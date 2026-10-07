import { type Context, Elysia } from "elysia";
import { AgentCallError, type AgentRegistry } from "./agent-registry";
import { RateLimiter } from "./rate-limit";
import {
  HOST_SESSIONS_FEATURE,
  type HostMethodParams,
  SESSION_RPC_ERRORS,
} from "./types";

const RPC_TIMEOUT_MS = 30_000;
const HTTP_ERRORS: Record<number, number> = {
  [SESSION_RPC_ERRORS.notFound]: 404,
  [SESSION_RPC_ERRORS.exists]: 409,
  [SESSION_RPC_ERRORS.forbidden]: 403,
  [SESSION_RPC_ERRORS.invalid]: 400,
  [SESSION_RPC_ERRORS.busy]: 409,
  [SESSION_RPC_ERRORS.methodNotFound]: 501,
};

export function hostSessionRoutes(registry: AgentRegistry) {
  const limiter = new RateLimiter({ max: 20, windowMs: 10_000 });

  async function call<M extends "host.sessions.list" | "host.sessions.start">(
    hostId: string,
    method: M,
    params: HostMethodParams[M],
    set: Context["set"],
  ) {
    const agents = registry
      .listAgents()
      .filter((agent) => agent.hostId === hostId);
    if (agents.length === 0) {
      set.status = 404;
      return { error: `host '${hostId}' not connected` };
    }
    if (
      !agents.some((agent) => agent.features.includes(HOST_SESSIONS_FEATURE))
    ) {
      set.status = 501;
      return {
        error:
          "Restart an OMP session on this host to enable dashboard session launching.",
      };
    }
    if (!limiter.allow(hostId)) {
      set.status = 429;
      set.headers["retry-after"] = "1";
      return { error: "Rate limit: host session requests (20 per 10s)" };
    }
    try {
      return await registry.callOnHost(
        hostId,
        method,
        params,
        RPC_TIMEOUT_MS,
        HOST_SESSIONS_FEATURE,
      );
    } catch (error) {
      if (!(error instanceof AgentCallError)) throw error;
      set.status =
        error.kind === "timeout"
          ? 504
          : error.kind === "remote"
            ? (HTTP_ERRORS[error.code ?? 0] ?? 502)
            : 502;
      return { error: error.message };
    }
  }

  return new Elysia({ prefix: "/api/hosts" })
    .get("/:id/session-history", ({ params, set }) =>
      call(params.id, "host.sessions.list", {}, set),
    )
    .post("/:id/sessions", ({ params, body, set }) => {
      const value =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : undefined;
      if (
        typeof value?.cwd !== "string" ||
        !value.cwd.trim() ||
        value.cwd.includes("\0") ||
        typeof value.name !== "string" ||
        value.name.length > 64 ||
        (value.name !== "" &&
          !/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(value.name)) ||
        (value.sessionId !== undefined &&
          (typeof value.sessionId !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)))
      ) {
        set.status = 400;
        return {
          error:
            "Provide a path, a valid ompc name (or blank), and an optional session UUID.",
        };
      }
      return call(
        params.id,
        "host.sessions.start",
        {
          cwd: value.cwd,
          name: value.name,
          ...(value.sessionId === undefined
            ? {}
            : { sessionId: value.sessionId as string }),
        },
        set,
      );
    });
}
