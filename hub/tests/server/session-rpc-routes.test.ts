import { describe, expect, test } from "bun:test";
import { type AgentConn, AgentRegistry } from "@/server/agent-registry";
import {
  FILE_CHUNK_BYTES,
  sessionRpcRoutes,
} from "@/server/session-rpc-routes";

const HOST = "user@hub-host";
const BASE = `http://localhost/api/hosts/${HOST}/sessions`;

/** Thrown by a fake handler to reply with a JSON-RPC error. */
class RpcFault {
  constructor(
    readonly code: number,
    readonly message: string,
  ) {}
}

interface Call {
  method: string;
  // biome-ignore lint/suspicious/noExplicitAny: test fake inspects arbitrary params
  params: any;
}

// biome-ignore lint/suspicious/noExplicitAny: test fake handles arbitrary params
type Handler = (method: string, params: any) => unknown;

/** Registers a fake omp-connected extension that answers each pushed
 *  request with `handler`'s (possibly async) result, or a JSON-RPC error
 *  when it throws an RpcFault. Returns the log of requests it received. */
function registerSessionAgent(
  registry: AgentRegistry,
  handler: Handler,
  options: { instanceId?: string; features?: string[] } = {},
): Call[] {
  const calls: Call[] = [];
  const conn: AgentConn = {
    send: (data) => {
      const frame = JSON.parse(data) as Call & { id: string };
      calls.push({ method: frame.method, params: frame.params });
      void (async () => {
        try {
          const result = await handler(frame.method, frame.params);
          registry.resolveHostCall(frame.id, result, undefined);
        } catch (err) {
          if (!(err instanceof RpcFault)) throw err;
          registry.resolveHostCall(frame.id, undefined, {
            code: err.code,
            message: err.message,
          });
        }
      })();
    },
    close: () => {},
  };
  registry.register(
    {
      hostId: HOST,
      instanceId: options.instanceId ?? "inst-1",
      pid: 1,
      cwd: "/work",
      features: options.features ?? ["session.v1"],
    },
    conn,
  );
  return calls;
}

function patternBytes(size: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

/** A fake file store answering files.stat / files.read like the extension,
 *  including the `expect` check. */
function fileHandler(
  files: Record<string, Uint8Array>,
  mtimeMs = 1000,
): Handler {
  return (method, params) => {
    const file = files[params.path];
    if (method === "files.stat") {
      if (!file) throw new RpcFault(-32001, `'${params.path}' not found`);
      return { path: params.path, type: "file", size: file.length, mtimeMs };
    }
    if (method === "files.read") {
      if (!file) throw new RpcFault(-32001, `'${params.path}' not found`);
      if (
        params.expect &&
        (params.expect.size !== file.length ||
          params.expect.mtimeMs !== mtimeMs)
      )
        throw new RpcFault(-32005, "file changed");
      const data = file.subarray(params.offset, params.offset + params.length);
      return {
        data: Buffer.from(data).toString("base64"),
        size: file.length,
        mtimeMs,
        eof: params.offset + data.length >= file.length,
      };
    }
    throw new RpcFault(-32601, `unknown method '${method}'`);
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function put(path: string, body: BodyInit | null, query = "") {
  return new Request(
    `${BASE}/inst-1/files/upload?path=${encodeURIComponent(path)}${query}`,
    { method: "PUT", body, duplex: "half" } as RequestInit,
  );
}

function post(route: string, body?: unknown) {
  return new Request(`${BASE}/inst-1/${route}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

/** A handler for files.write that records decoded chunks and acks them. */
function writeRecorder(): {
  handler: Handler;
  chunks: { offset: number; bytes: Uint8Array; final: boolean }[];
} {
  const chunks: { offset: number; bytes: Uint8Array; final: boolean }[] = [];
  let size = 0;
  return {
    chunks,
    handler: (method, params) => {
      if (method === "files.write_abort") return { ok: true };
      if (method !== "files.write") throw new RpcFault(-32601, method);
      const bytes = new Uint8Array(Buffer.from(params.data, "base64"));
      chunks.push({ offset: params.offset, bytes, final: params.final });
      size += bytes.length;
      return { ok: true, path: params.path, size };
    },
  };
}

describe("session-rpc-routes: pre-checks", () => {
  test("404 when no live agent is registered for the session", async () => {
    const app = sessionRpcRoutes(new AgentRegistry());
    const response = await app.handle(new Request(`${BASE}/inst-1/info`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: `session '${HOST}:inst-1' not connected`,
    });
  });

  test("501 with the restart hint when the agent lacks session.v1, without calling it", async () => {
    const registry = new AgentRegistry();
    const calls = registerSessionAgent(registry, () => ({}), { features: [] });
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(new Request(`${BASE}/inst-1/info`));

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error:
        "session's omp-connected extension does not support session.v1; restart the session to update it",
    });
    expect(calls).toEqual([]);
  });

  test("400 for an instance id outside the allowed charset", async () => {
    const registry = new AgentRegistry();
    registerSessionAgent(registry, () => ({}));
    const app = sessionRpcRoutes(registry);
    const response = await app.handle(new Request(`${BASE}/in.st/info`));
    expect(response.status).toBe(400);
  });

  test("routes to the addressed session, not another on the same host", async () => {
    const registry = new AgentRegistry();
    const callsA = registerSessionAgent(registry, () => ({ cwd: "/a" }), {
      instanceId: "a",
    });
    const callsB = registerSessionAgent(registry, () => ({ cwd: "/b" }), {
      instanceId: "b",
    });
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(new Request(`${BASE}/b/info`));

    expect(await response.json()).toEqual({ cwd: "/b" });
    expect(callsA).toEqual([]);
    expect(callsB).toEqual([{ method: "session.info", params: {} }]);
  });
});

describe("session-rpc-routes: error mapping", () => {
  test.each([
    [-32001, 404],
    [-32002, 409],
    [-32003, 403],
    [-32004, 400],
    [-32005, 409],
    [-32006, 409],
    [-32601, 501],
    [-32603, 502],
    [-1, 502],
  ])(
    "extension code %d answers HTTP %d with its message",
    async (code, status) => {
      const registry = new AgentRegistry();
      registerSessionAgent(registry, () => {
        throw new RpcFault(code, "extension says no");
      });
      const app = sessionRpcRoutes(registry);

      const response = await app.handle(
        new Request(`${BASE}/inst-1/files?path=src`),
      );

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "extension says no" });
    },
  );

  test("no reply within the RPC deadline answers 504", async () => {
    const registry = new AgentRegistry();
    registerSessionAgent(registry, () => new Promise(() => {}));
    const app = sessionRpcRoutes(registry, { rpcTimeoutMs: 20 });

    const response = await app.handle(new Request(`${BASE}/inst-1/info`));

    expect(response.status).toBe(504);
  });
});

describe("session-rpc-routes: info, controls, listing", () => {
  test("files listing forwards the path, defaulting to the root", async () => {
    const registry = new AgentRegistry();
    const calls = registerSessionAgent(registry, (_, params) => ({
      path: params.path,
      entries: [],
    }));
    const app = sessionRpcRoutes(registry);

    const root = await app.handle(new Request(`${BASE}/inst-1/files`));
    const sub = await app.handle(
      new Request(`${BASE}/inst-1/files?path=src%2Flib`),
    );

    expect(await root.json()).toEqual({ path: "", entries: [] });
    expect(await sub.json()).toEqual({ path: "src/lib", entries: [] });
    expect(calls.map((c) => c.params)).toEqual([
      { path: "" },
      { path: "src/lib" },
    ]);
  });

  test("control bodies are validated before anything is sent", async () => {
    const registry = new AgentRegistry();
    const calls = registerSessionAgent(registry, () => ({ ok: true }));
    const app = sessionRpcRoutes(registry);

    const rejected = await Promise.all([
      app.handle(post("compact", { instructions: "x".repeat(4001) })),
      app.handle(post("compact", { instructions: 5 })),
      app.handle(post("model", { provider: "anthropic" })),
      app.handle(post("model", { provider: "", id: "m" })),
      app.handle(post("thinking", {})),
      app.handle(post("files/mkdir", { path: 3 })),
    ]);

    expect(rejected.map((r) => r.status)).toEqual([
      400, 400, 400, 400, 400, 400,
    ]);
    expect(calls).toEqual([]);
  });

  test("valid control actions forward their parameters and return the result", async () => {
    const registry = new AgentRegistry();
    const calls = registerSessionAgent(registry, () => ({ ok: true }));
    const app = sessionRpcRoutes(registry);

    const responses = await Promise.all([
      app.handle(post("abort")),
      app.handle(post("compact")),
      app.handle(post("compact", { instructions: "x".repeat(4000) })),
      app.handle(post("model", { provider: "anthropic", id: "opus" })),
      app.handle(post("thinking", { level: "high" })),
      app.handle(post("files/mkdir", { path: "src/new" })),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(calls).toEqual([
      { method: "session.abort", params: {} },
      { method: "session.compact", params: {} },
      { method: "session.compact", params: { instructions: "x".repeat(4000) } },
      {
        method: "session.set_model",
        params: { provider: "anthropic", id: "opus" },
      },
      { method: "session.set_thinking", params: { level: "high" } },
      { method: "files.mkdir", params: { path: "src/new" } },
    ]);
  });

  test("control actions share a 20 per 10 s limit per session; reads are not limited", async () => {
    const registry = new AgentRegistry();
    registerSessionAgent(registry, () => ({ ok: true }));
    registerSessionAgent(registry, () => ({ ok: true }), {
      instanceId: "other",
    });
    const app = sessionRpcRoutes(registry);

    for (let i = 0; i < 10; i++) {
      expect((await app.handle(post("abort"))).status).toBe(200);
      expect(
        (await app.handle(post("thinking", { level: "low" }))).status,
      ).toBe(200);
    }
    const limited = await app.handle(post("files/mkdir", { path: "d" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");

    expect((await app.handle(new Request(`${BASE}/inst-1/info`))).status).toBe(
      200,
    );
    const otherSession = await app.handle(
      new Request(`${BASE}/other/abort`, { method: "POST" }),
    );
    expect(otherSession.status).toBe(200);
  });
});

describe("session-rpc-routes: download", () => {
  test("streams a multi-chunk file with the stat's size/mtime as `expect`", async () => {
    const registry = new AgentRegistry();
    const file = patternBytes(2 * FILE_CHUNK_BYTES + 1000);
    const calls = registerSessionAgent(
      registry,
      fileHandler({ "out/data.bin": file }),
    );
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(
      new Request(`${BASE}/inst-1/files/download?path=out%2Fdata.bin`),
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(file)).toBe(true);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/octet-stream",
      "content-length": String(file.length),
      "content-disposition": `attachment; filename="data.bin"; filename*=UTF-8''data.bin`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "no-store",
    });
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["files.stat", { path: "out/data.bin" }],
      ...[0, 1, 2].map((i) => [
        "files.read",
        {
          path: "out/data.bin",
          offset: i * FILE_CHUNK_BYTES,
          length: i < 2 ? FILE_CHUNK_BYTES : 1000,
          expect: { size: file.length, mtimeMs: 1000 },
        },
      ]),
    ]);
  });

  test("a zero-byte file downloads as an empty body", async () => {
    const registry = new AgentRegistry();
    registerSessionAgent(registry, fileHandler({ empty: new Uint8Array(0) }));
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(
      new Request(`${BASE}/inst-1/files/download?path=empty`),
    );

    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test("the filename is RFC 5987 encoded with an ASCII fallback", async () => {
    const registry = new AgentRegistry();
    const name = 'résumé "v2" (final)*.txt';
    registerSessionAgent(registry, fileHandler({ [name]: patternBytes(3) }));
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(
      new Request(
        `${BASE}/inst-1/files/download?path=${encodeURIComponent(name)}`,
      ),
    );

    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="r_sum_ _v2_ (final)*.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22%20%28final%29%2A.txt`,
    );
    expect(response.headers.get("content-type")).toBe(
      "text/plain;charset=utf-8",
    );
    await response.arrayBuffer();
  });

  test.each([
    ["a.png", "", "attachment", "image/png"],
    ["a.png", "&inline=1", "inline", "image/png"],
    ["a.jpg", "&inline=1", "inline", "image/jpeg"],
    ["a.gif", "&inline=1", "inline", "image/gif"],
    ["a.webp", "&inline=1", "inline", "image/webp"],
    ["a.svg", "&inline=1", "attachment", "image/svg+xml"],
    ["a.html", "&inline=1", "attachment", "text/html;charset=utf-8"],
    ["a.png", "&inline=0", "attachment", "image/png"],
  ])(
    "%s with query '%s' is served %s as %s",
    async (name, query, disposition, type) => {
      const registry = new AgentRegistry();
      registerSessionAgent(registry, fileHandler({ [name]: patternBytes(10) }));
      const app = sessionRpcRoutes(registry);

      const response = await app.handle(
        new Request(`${BASE}/inst-1/files/download?path=${name}${query}`),
      );

      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("content-disposition")).toStartWith(
        `${disposition}; `,
      );
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
      await response.arrayBuffer();
    },
  );

  test("directories answer 400 and a missing file 404, before any read", async () => {
    const registry = new AgentRegistry();
    const calls = registerSessionAgent(registry, (method, params) => {
      if (params.path === "src")
        return { path: "src", type: "dir", size: 0, mtimeMs: 1 };
      throw new RpcFault(-32001, "not found");
    });
    const app = sessionRpcRoutes(registry);

    const dir = await app.handle(
      new Request(`${BASE}/inst-1/files/download?path=src`),
    );
    const missing = await app.handle(
      new Request(`${BASE}/inst-1/files/download?path=nope`),
    );

    expect(dir.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(calls.every((c) => c.method === "files.stat")).toBe(true);
  });

  test("a symlink the first read refuses answers that error, not a broken 200", async () => {
    const registry = new AgentRegistry();
    registerSessionAgent(registry, (method) => {
      if (method === "files.stat")
        return { path: "dir-link", type: "symlink", size: 4096, mtimeMs: 1 };
      throw new RpcFault(-32004, "'dir-link' is not a regular file");
    });
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(
      new Request(`${BASE}/inst-1/files/download?path=dir-link`),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toEqual({
      error: "'dir-link' is not a regular file",
    });
  });

  test("chunks are read only as the client consumes them", async () => {
    const registry = new AgentRegistry();
    const calls = registerSessionAgent(
      registry,
      fileHandler({ big: patternBytes(8 * FILE_CHUNK_BYTES) }),
    );
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(
      new Request(`${BASE}/inst-1/files/download?path=big`),
    );
    const reader = response.body?.getReader();
    const first = await reader?.read();
    await Bun.sleep(20);

    expect(first?.value?.length).toBe(FILE_CHUNK_BYTES);
    const reads = calls.filter((c) => c.method === "files.read").length;
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(reads).toBeLessThanOrEqual(2);
    await reader?.cancel();
  });

  test("a file that changes mid-download errors the body stream", async () => {
    const registry = new AgentRegistry();
    const file = patternBytes(3 * FILE_CHUNK_BYTES);
    let mtimeMs = 1000;
    const store = fileHandler({ f: file }, 1000);
    registerSessionAgent(registry, (method, params) => {
      if (method === "files.read" && params.offset > 0) mtimeMs = 2000;
      if (mtimeMs !== 1000)
        return fileHandler({ f: file }, mtimeMs)(method, params);
      return store(method, params);
    });
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(
      new Request(`${BASE}/inst-1/files/download?path=f`),
    );

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("file changed");
  });
});

describe("session-rpc-routes: upload", () => {
  test("re-chunks an irregular body into exact 256 KiB writes with one final", async () => {
    const registry = new AgentRegistry();
    const recorder = writeRecorder();
    const calls = registerSessionAgent(registry, recorder.handler);
    const app = sessionRpcRoutes(registry);
    const data = patternBytes(2 * FILE_CHUNK_BYTES + 5);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < data.length; i += 100_000)
      parts.push(data.subarray(i, i + 100_000));

    const response = await app.handle(put("dir/up.bin", streamOf(parts)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      path: "dir/up.bin",
      size: data.length,
    });
    expect(
      recorder.chunks.map((c) => [c.offset, c.bytes.length, c.final]),
    ).toEqual([
      [0, FILE_CHUNK_BYTES, false],
      [FILE_CHUNK_BYTES, FILE_CHUNK_BYTES, false],
      [2 * FILE_CHUNK_BYTES, 5, true],
    ]);
    expect(concat(recorder.chunks.map((c) => c.bytes))).toEqual(data);
    const uploadIds = new Set(calls.map((c) => c.params.uploadId));
    expect(uploadIds.size).toBe(1);
    expect([...uploadIds][0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(calls.every((c) => c.params.overwrite === false)).toBe(true);
  });

  test("a body of exactly two chunks ends with a full final chunk", async () => {
    const registry = new AgentRegistry();
    const recorder = writeRecorder();
    registerSessionAgent(registry, recorder.handler);
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(
      put("f", streamOf([patternBytes(2 * FILE_CHUNK_BYTES)])),
    );

    expect(response.status).toBe(200);
    expect(recorder.chunks.map((c) => [c.bytes.length, c.final])).toEqual([
      [FILE_CHUNK_BYTES, false],
      [FILE_CHUNK_BYTES, true],
    ]);
  });

  test("an empty body writes a zero-byte file in one final chunk", async () => {
    const registry = new AgentRegistry();
    const recorder = writeRecorder();
    const calls = registerSessionAgent(registry, recorder.handler);
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(put("empty.txt", null, "&overwrite=1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      path: "empty.txt",
      size: 0,
    });
    expect(calls).toEqual([
      {
        method: "files.write",
        params: expect.objectContaining({
          path: "empty.txt",
          offset: 0,
          data: "",
          final: true,
          overwrite: true,
        }),
      },
    ]);
  });

  test("writes start before the client has sent the whole body", async () => {
    const registry = new AgentRegistry();
    const recorder = writeRecorder();
    const { promise: firstWrite, resolve: onFirstWrite } =
      Promise.withResolvers<void>();
    registerSessionAgent(registry, (method, params) => {
      onFirstWrite();
      return recorder.handler(method, params);
    });
    const app = sessionRpcRoutes(registry);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(patternBytes(FILE_CHUNK_BYTES + 1));
        // The rest is only sent once the hub has forwarded the first chunk.
        await firstWrite;
        controller.enqueue(patternBytes(10));
        controller.close();
      },
    });

    const response = await app.handle(put("f", body));

    expect(response.status).toBe(200);
    expect(recorder.chunks.map((c) => c.bytes.length)).toEqual([
      FILE_CHUNK_BYTES,
      11,
    ]);
  });

  test("an existing target answers 409 and abandons the upload", async () => {
    const registry = new AgentRegistry();
    const calls = registerSessionAgent(registry, (method) => {
      if (method === "files.write")
        throw new RpcFault(-32002, "'f' already exists");
      return { ok: true };
    });
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(put("f", streamOf([patternBytes(5)])));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "'f' already exists" });
    expect(calls.map((c) => c.method)).toEqual([
      "files.write",
      "files.write_abort",
    ]);
    expect(calls[1]?.params).toEqual({
      path: "f",
      uploadId: calls[0]?.params.uploadId,
    });
  });

  test("a declared length over the cap answers 413 without writing", async () => {
    const registry = new AgentRegistry();
    const calls = registerSessionAgent(registry, () => ({ ok: true }));
    const app = sessionRpcRoutes(registry);

    const response = await app.handle(
      new Request(`${BASE}/inst-1/files/upload?path=f`, {
        method: "PUT",
        headers: { "content-length": String(256 * 1024 * 1024 + 1) },
        body: "x",
      }),
    );

    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });

  test("a streamed body that passes the cap answers 413 and aborts", async () => {
    const registry = new AgentRegistry();
    const recorder = writeRecorder();
    const calls = registerSessionAgent(registry, recorder.handler);
    const app = sessionRpcRoutes(registry, {
      maxUploadBytes: FILE_CHUNK_BYTES + 10,
    });

    const response = await app.handle(
      put(
        "f",
        streamOf([patternBytes(FILE_CHUNK_BYTES + 1), patternBytes(10)]),
      ),
    );

    expect(response.status).toBe(413);
    expect(calls.map((c) => c.method)).toEqual([
      "files.write",
      "files.write_abort",
    ]);
    expect(recorder.chunks.map((c) => c.final)).toEqual([false]);
  });

  test("a stream exactly at the cap is accepted", async () => {
    const registry = new AgentRegistry();
    const recorder = writeRecorder();
    registerSessionAgent(registry, recorder.handler);
    const app = sessionRpcRoutes(registry, {
      maxUploadBytes: FILE_CHUNK_BYTES + 10,
    });

    const response = await app.handle(
      put("f", streamOf([patternBytes(FILE_CHUNK_BYTES + 10)])),
    );

    expect(response.status).toBe(200);
  });

  test("a client body that fails mid-upload aborts the upload", async () => {
    const registry = new AgentRegistry();
    const recorder = writeRecorder();
    const { promise: firstWrite, resolve: onFirstWrite } =
      Promise.withResolvers<void>();
    const calls = registerSessionAgent(registry, (method, params) => {
      onFirstWrite();
      return recorder.handler(method, params);
    });
    const app = sessionRpcRoutes(registry);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(patternBytes(FILE_CHUNK_BYTES + 1));
        await firstWrite;
        controller.error(new Error("client went away"));
      },
    });

    const response = await app.handle(put("f", body));

    expect(response.status).toBe(400);
    expect(calls.map((c) => c.method)).toEqual([
      "files.write",
      "files.write_abort",
    ]);
  });

  test("a write that times out answers 504 and aborts", async () => {
    const registry = new AgentRegistry();
    const calls = registerSessionAgent(registry, (method) =>
      method === "files.write" ? new Promise(() => {}) : { ok: true },
    );
    const app = sessionRpcRoutes(registry, { rpcTimeoutMs: 20 });

    const response = await app.handle(put("f", streamOf([patternBytes(3)])));

    expect(response.status).toBe(504);
    expect(calls.map((c) => c.method)).toEqual([
      "files.write",
      "files.write_abort",
    ]);
  });

  test("path is required and overwrite must be 0 or 1", async () => {
    const registry = new AgentRegistry();
    const calls = registerSessionAgent(registry, () => ({ ok: true }));
    const app = sessionRpcRoutes(registry);

    const noPath = await app.handle(
      new Request(`${BASE}/inst-1/files/upload`, { method: "PUT", body: "x" }),
    );
    const badOverwrite = await app.handle(put("f", "x", "&overwrite=yes"));

    expect(noPath.status).toBe(400);
    expect(badOverwrite.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("session-rpc-routes: transfer concurrency", () => {
  test("a fifth concurrent transfer is refused until one finishes", async () => {
    const registry = new AgentRegistry();
    const pendingStats: ((result: unknown) => void)[] = [];
    registerSessionAgent(registry, (method) => {
      if (method !== "files.stat") return { ok: true };
      return new Promise((resolve) => pendingStats.push(resolve));
    });
    registerSessionAgent(registry, () => ({ ok: true }), {
      instanceId: "other",
    });
    const app = sessionRpcRoutes(registry);
    const download = (instanceId = "inst-1") =>
      app.handle(new Request(`${BASE}/${instanceId}/files/download?path=f`));

    const inFlight = [download(), download(), download(), download()];
    await Bun.sleep(5);
    expect(pendingStats).toHaveLength(4);

    const refusedDownload = await download();
    const refusedUpload = await app.handle(put("u", "x"));
    expect(refusedDownload.status).toBe(429);
    expect(refusedUpload.status).toBe(429);
    // The cap is per session.
    expect((await app.handle(put("u", "x").clone())).status).toBe(429);
    const otherUpload = await app.handle(
      new Request(`${BASE}/other/files/upload?path=u`, {
        method: "PUT",
        body: "x",
      }),
    );
    expect(otherUpload.status).toBe(200);

    // A directory stat finishes that transfer and frees its slot.
    pendingStats[0]?.({ path: "f", type: "dir", size: 0, mtimeMs: 1 });
    expect((await inFlight[0])?.status).toBe(400);
    const admitted = download();
    await Bun.sleep(5);
    expect(pendingStats).toHaveLength(5);

    for (const resolve of pendingStats.slice(1))
      resolve({ path: "f", type: "dir", size: 0, mtimeMs: 1 });
    await Promise.all([...inFlight, admitted]);
  });

  test("a download the client cancels releases its slot", async () => {
    const registry = new AgentRegistry();
    registerSessionAgent(
      registry,
      fileHandler({ big: patternBytes(8 * FILE_CHUNK_BYTES) }),
    );
    const app = sessionRpcRoutes(registry);
    const open = async () => {
      const response = await app.handle(
        new Request(`${BASE}/inst-1/files/download?path=big`),
      );
      expect(response.status).toBe(200);
      return response;
    };

    const first = await Promise.all([open(), open(), open(), open()]);
    const refused = await app.handle(
      new Request(`${BASE}/inst-1/files/download?path=big`),
    );
    expect(refused.status).toBe(429);

    for (const response of first) await response.body?.cancel();
    const again = await Promise.all([open(), open(), open(), open()]);
    for (const response of again) await response.body?.cancel();
  });

  test("a completed download releases its slot", async () => {
    const registry = new AgentRegistry();
    registerSessionAgent(registry, fileHandler({ f: patternBytes(100) }));
    const app = sessionRpcRoutes(registry);

    for (let i = 0; i < 6; i++) {
      const response = await app.handle(
        new Request(`${BASE}/inst-1/files/download?path=f`),
      );
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
  });
});
