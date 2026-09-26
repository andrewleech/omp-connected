// REST surface for the dashboard's session inspector: session info and
// controls, and browsing / transferring files in the session's cwd. Each
// route forwards to the one agent connection registered for
// `${hostId}:${instanceId}` (AgentRegistry.callOnAgent); the extension in
// that omp process answers, enforces the path root and the view/control
// access gate, and reports failures as JSON-RPC error codes mapped to HTTP
// statuses here.
//
// Transfers are streamed in FILE_CHUNK_BYTES pieces in both directions so
// the hub never holds more than a chunk or two of a file in memory.

import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { type Context, Elysia } from "elysia";
import { AgentCallError, type AgentRegistry } from "./agent-registry";
import { RateLimiter } from "./rate-limit";
import {
  type FilesStatResult,
  SESSION_FEATURE,
  SESSION_RPC_ERRORS,
  type SessionMethod,
  type SessionMethodParams,
  type SessionMethodResult,
} from "./types";

/** Per-RPC deadline; a call that exceeds it answers 504. */
const RPC_TIMEOUT_MS = 15_000;
/** files.read / files.write chunk size; the extension's per-call maximum. */
export const FILE_CHUNK_BYTES = 256 * 1024;
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
/** Uploads plus downloads in flight per agent. */
const MAX_CONCURRENT_TRANSFERS = 4;
const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const COMPACT_INSTRUCTIONS_MAX = 4000;
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const NO_FEATURE_ERROR = `session's omp-connected extension does not support ${SESSION_FEATURE}; restart the session to update it`;

const HTTP_STATUS_BY_RPC_CODE: Record<number, number> = {
  [SESSION_RPC_ERRORS.notFound]: 404,
  [SESSION_RPC_ERRORS.exists]: 409,
  [SESSION_RPC_ERRORS.forbidden]: 403,
  [SESSION_RPC_ERRORS.invalid]: 400,
  [SESSION_RPC_ERRORS.changed]: 409,
  [SESSION_RPC_ERRORS.busy]: 409,
  [SESSION_RPC_ERRORS.methodNotFound]: 501,
};

interface Failure {
  status: number;
  error: string;
}

/** HTTP status for a failed agent call: extension error codes per the
 *  session.v1 table, 504 when no reply arrived in time, 502 otherwise. */
function rpcFailure(err: unknown): Failure {
  if (!(err instanceof AgentCallError)) throw err;
  if (err.kind === "timeout") return { status: 504, error: err.message };
  const status =
    err.kind === "remote" && err.code !== undefined
      ? (HTTP_STATUS_BY_RPC_CODE[err.code] ?? 502)
      : 502;
  return { status, error: err.message };
}

/** `attachment; filename="<ascii>"; filename*=UTF-8''<pct>` (RFC 6266 /
 *  RFC 5987). The quoted fallback replaces anything outside printable
 *  ASCII, and the quote/backslash that would need escaping, with `_`. */
export function contentDisposition(
  disposition: "attachment" | "inline",
  name: string,
): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Query flags are "0"/"1"; absent means false, anything else is invalid. */
function queryFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  return undefined;
}

/** A JSON request body as an object; an absent body counts as `{}`. */
function bodyObject(body: unknown): Record<string, unknown> | undefined {
  if (body === undefined || body === null || body === "") return {};
  if (typeof body !== "object" || Array.isArray(body)) return undefined;
  return body as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

class UploadTooLargeError extends Error {}

export interface SessionRpcRoutesOptions {
  /** Per-RPC deadline override for tests. */
  rpcTimeoutMs?: number;
  /** Upload size cap override for tests. */
  maxUploadBytes?: number;
}

export function sessionRpcRoutes(
  agentRegistry: AgentRegistry,
  options: SessionRpcRoutesOptions = {},
) {
  const rpcTimeoutMs = options.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
  const maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const controlLimiter = new RateLimiter({ max: 20, windowMs: 10_000 });
  const activeTransfers = new Map<string, number>();

  /** The agent id to call, or the 400/404/501 that stops the request. */
  function target(
    hostId: string,
    instanceId: string,
  ): { agentId: string } | Failure {
    if (!INSTANCE_ID_RE.test(instanceId))
      return { status: 400, error: "Invalid session instance ID" };
    const agentId = `${hostId}:${instanceId}`;
    const agent = agentRegistry.liveAgent(agentId);
    if (!agent)
      return { status: 404, error: `session '${agentId}' not connected` };
    if (!agent.features.includes(SESSION_FEATURE))
      return { status: 501, error: NO_FEATURE_ERROR };
    return { agentId };
  }

  function fail(set: Context["set"], failure: Failure): { error: string } {
    set.status = failure.status;
    return { error: failure.error };
  }

  function rateLimited(set: Context["set"]): { error: string } {
    set.headers["retry-after"] = "1";
    return fail(set, {
      status: 429,
      error: "Rate limit: session controls (20 per 10s)",
    });
  }

  /** Claims one of the agent's transfer slots. Returns an idempotent
   *  release function, or undefined when all slots are in use. */
  function acquireTransfer(agentId: string): (() => void) | undefined {
    const active = activeTransfers.get(agentId) ?? 0;
    if (active >= MAX_CONCURRENT_TRANSFERS) return undefined;
    activeTransfers.set(agentId, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (activeTransfers.get(agentId) ?? 1) - 1;
      if (remaining <= 0) activeTransfers.delete(agentId);
      else activeTransfers.set(agentId, remaining);
    };
  }

  function transfersBusy(set: Context["set"]): { error: string } {
    set.headers["retry-after"] = "1";
    return fail(set, {
      status: 429,
      error: `Too many transfers for this session (max ${MAX_CONCURRENT_TRANSFERS})`,
    });
  }

  function call<M extends SessionMethod>(
    agentId: string,
    method: M,
    params: SessionMethodParams[M],
  ): Promise<SessionMethodResult[M]> {
    return agentRegistry.callOnAgent(agentId, method, params, rpcTimeoutMs);
  }

  /** Forwards one call and returns its result, or the mapped error. */
  async function forward<M extends SessionMethod>(
    set: Context["set"],
    agentId: string,
    method: M,
    params: SessionMethodParams[M],
  ): Promise<SessionMethodResult[M] | { error: string }> {
    try {
      return await call(agentId, method, params);
    } catch (err) {
      return fail(set, rpcFailure(err));
    }
  }

  /** Forwards a control action: pre-checks, then the shared rate limit. */
  function control<M extends SessionMethod>(
    set: Context["set"],
    routeParams: { id: string; instanceId: string },
    method: M,
    params: SessionMethodParams[M],
  ): Promise<SessionMethodResult[M] | { error: string }> | { error: string } {
    const resolved = target(routeParams.id, routeParams.instanceId);
    if (!("agentId" in resolved)) return fail(set, resolved);
    if (!controlLimiter.allow(resolved.agentId)) return rateLimited(set);
    return forward(set, resolved.agentId, method, params);
  }

  /** One files.read chunk at `offset`, checked against the stat's size and
   *  mtime (`expect`) so a file that changes mid-download fails the read
   *  instead of splicing two versions together. */
  async function readChunk(
    agentId: string,
    path: string,
    stat: FilesStatResult,
    offset: number,
  ): Promise<Buffer> {
    const length = Math.min(FILE_CHUNK_BYTES, stat.size - offset);
    const chunk = await call(agentId, "files.read", {
      path,
      offset,
      length,
      expect: { size: stat.size, mtimeMs: stat.mtimeMs },
    });
    const bytes = Buffer.from(chunk.data, "base64");
    if ((bytes.length === 0 && length > 0) || bytes.length > length) {
      throw new Error(
        `files.read returned ${bytes.length} bytes at offset ${offset}, expected ${length}`,
      );
    }
    return bytes;
  }

  /** The file body as a pull stream: `first` (already read, so a path that
   *  cannot be read fails before any header is sent), then one files.read
   *  per pull until `stat.size` bytes have been delivered. */
  function downloadStream(
    agentId: string,
    path: string,
    stat: FilesStatResult,
    first: Buffer,
    release: () => void,
  ): ReadableStream<Uint8Array> {
    let offset = 0;
    let pending: Buffer | undefined = first;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const bytes =
            pending ?? (await readChunk(agentId, path, stat, offset));
          pending = undefined;
          offset += bytes.length;
          if (bytes.length > 0) controller.enqueue(bytes);
          if (offset >= stat.size) {
            release();
            controller.close();
          }
        } catch (err) {
          release();
          controller.error(err);
        }
      },
      cancel() {
        release();
      },
    });
  }

  /** Streams the request body into files.write calls of exactly
   *  FILE_CHUNK_BYTES (the last one shorter, and `final`), awaiting each
   *  before reading on. Any failure abandons the upload with
   *  files.write_abort so the extension drops its temp file. */
  async function upload(
    set: Context["set"],
    agentId: string,
    request: Request,
    path: string,
    overwrite: boolean,
  ) {
    const uploadId = randomBytes(16).toString("base64url");
    const reader = request.body?.getReader();
    const buffer = new Uint8Array(FILE_CHUNK_BYTES);
    let filled = 0;
    let offset = 0;
    let received = 0;
    let started = false;

    const write = async (final: boolean) => {
      started = true;
      const result = await call(agentId, "files.write", {
        path,
        uploadId,
        offset,
        data: Buffer.from(buffer.buffer, 0, filled).toString("base64"),
        final,
        overwrite,
      });
      offset += filled;
      filled = 0;
      return result;
    };

    try {
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > maxUploadBytes) throw new UploadTooLargeError();
          let pos = 0;
          while (pos < value.length) {
            // A full chunk is only sent once more data proves it is not
            // the last one, so the final write always carries `final`.
            if (filled === FILE_CHUNK_BYTES) await write(false);
            const n = Math.min(FILE_CHUNK_BYTES - filled, value.length - pos);
            buffer.set(value.subarray(pos, pos + n), filled);
            filled += n;
            pos += n;
          }
        }
      }
      const result = await write(true);
      return { ok: true as const, path: result.path, size: result.size };
    } catch (err) {
      reader?.cancel().catch(() => {});
      if (started) {
        // Sent immediately; the reply (or its absence) doesn't change the
        // response, and the extension also expires idle uploads itself.
        call(agentId, "files.write_abort", { path, uploadId }).catch(() => {});
      }
      if (err instanceof UploadTooLargeError)
        return fail(set, {
          status: 413,
          error: `Upload exceeds ${maxUploadBytes} bytes`,
        });
      if (err instanceof AgentCallError) return fail(set, rpcFailure(err));
      return fail(set, {
        status: 400,
        error: `upload body failed: ${(err as Error).message}`,
      });
    }
  }

  return new Elysia({ prefix: "/api/hosts" })
    .get("/:id/sessions/:instanceId/info", ({ params, set }) => {
      const resolved = target(params.id, params.instanceId);
      if (!("agentId" in resolved)) return fail(set, resolved);
      return forward(set, resolved.agentId, "session.info", {});
    })

    .post("/:id/sessions/:instanceId/abort", ({ params, set }) =>
      control(set, params, "session.abort", {}),
    )

    .post("/:id/sessions/:instanceId/compact", ({ params, body, set }) => {
      const payload = bodyObject(body);
      const instructions = payload?.instructions;
      if (
        !payload ||
        (instructions !== undefined &&
          (typeof instructions !== "string" ||
            instructions.length > COMPACT_INSTRUCTIONS_MAX))
      ) {
        return fail(set, {
          status: 400,
          error: `instructions must be a string of at most ${COMPACT_INSTRUCTIONS_MAX} characters`,
        });
      }
      return control(
        set,
        params,
        "session.compact",
        instructions === undefined ? {} : { instructions },
      );
    })

    .post("/:id/sessions/:instanceId/model", ({ params, body, set }) => {
      const payload = bodyObject(body);
      if (
        !isNonEmptyString(payload?.provider) ||
        !isNonEmptyString(payload?.id)
      ) {
        return fail(set, {
          status: 400,
          error: "provider and id are required",
        });
      }
      return control(set, params, "session.set_model", {
        provider: payload.provider,
        id: payload.id,
      });
    })

    .post("/:id/sessions/:instanceId/thinking", ({ params, body, set }) => {
      const payload = bodyObject(body);
      if (!isNonEmptyString(payload?.level)) {
        return fail(set, { status: 400, error: "level is required" });
      }
      return control(set, params, "session.set_thinking", {
        level: payload.level,
      });
    })

    .get("/:id/sessions/:instanceId/files", ({ params, query, set }) => {
      const resolved = target(params.id, params.instanceId);
      if (!("agentId" in resolved)) return fail(set, resolved);
      return forward(set, resolved.agentId, "files.list", {
        path: query.path ?? "",
      });
    })

    .post("/:id/sessions/:instanceId/files/mkdir", ({ params, body, set }) => {
      const payload = bodyObject(body);
      if (!isNonEmptyString(payload?.path)) {
        return fail(set, { status: 400, error: "path is required" });
      }
      return control(set, params, "files.mkdir", { path: payload.path });
    })

    .get(
      "/:id/sessions/:instanceId/files/download",
      async ({ params, query, set }) => {
        const inline = queryFlag(query.inline);
        if (inline === undefined)
          return fail(set, { status: 400, error: "inline must be 0 or 1" });
        const resolved = target(params.id, params.instanceId);
        if (!("agentId" in resolved)) return fail(set, resolved);
        const { agentId } = resolved;
        const path = query.path ?? "";
        const release = acquireTransfer(agentId);
        if (!release) return transfersBusy(set);

        let stat: FilesStatResult;
        try {
          stat = await call(agentId, "files.stat", { path });
        } catch (err) {
          release();
          return fail(set, rpcFailure(err));
        }
        if (stat.type !== "file" && stat.type !== "symlink") {
          release();
          return fail(set, {
            status: 400,
            error:
              stat.type === "dir"
                ? `'${stat.path}' is a directory`
                : `'${stat.path}' is not a regular file`,
          });
        }
        // The first read also covers what the stat cannot tell apart: a
        // symlink to a directory or special file fails here, with its own
        // status, before any header is sent.
        let first: Buffer;
        try {
          first = await readChunk(agentId, path, stat, 0);
        } catch (err) {
          release();
          if (err instanceof AgentCallError) return fail(set, rpcFailure(err));
          return fail(set, { status: 502, error: (err as Error).message });
        }

        const name = posix.basename(stat.path) || "download";
        const contentType = Bun.file(name).type || "application/octet-stream";
        const mimeType = contentType.split(";")[0]?.trim() ?? "";
        const disposition =
          inline && INLINE_IMAGE_TYPES.has(mimeType) ? "inline" : "attachment";
        return new Response(
          downloadStream(agentId, path, stat, first, release),
          {
            headers: {
              "content-type": contentType,
              "content-length": String(stat.size),
              "content-disposition": contentDisposition(disposition, name),
              "x-content-type-options": "nosniff",
              "content-security-policy": "sandbox",
              "cache-control": "no-store",
            },
          },
        );
      },
    )

    .put(
      "/:id/sessions/:instanceId/files/upload",
      async ({ params, query, request, set }) => {
        const path = query.path;
        if (!isNonEmptyString(path))
          return fail(set, { status: 400, error: "path is required" });
        const overwrite = queryFlag(query.overwrite);
        if (overwrite === undefined)
          return fail(set, { status: 400, error: "overwrite must be 0 or 1" });
        const resolved = target(params.id, params.instanceId);
        if (!("agentId" in resolved)) return fail(set, resolved);
        const declaredLength = Number(
          request.headers.get("content-length") ?? 0,
        );
        if (declaredLength > maxUploadBytes)
          return fail(set, {
            status: 413,
            error: `Upload exceeds ${maxUploadBytes} bytes`,
          });
        const release = acquireTransfer(resolved.agentId);
        if (!release) return transfersBusy(set);
        try {
          return await upload(set, resolved.agentId, request, path, overwrite);
        } finally {
          release();
        }
      },
      // The body is streamed from `request` by the handler; Elysia must not
      // read (and buffer) it first.
      { parse: "none" },
    );
}
