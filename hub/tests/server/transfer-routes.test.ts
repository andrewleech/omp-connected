import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConn, AgentRegistry } from "@/server/agent-registry";
import { allowsMutationOrigin } from "@/server/index";
import {
  type TransferRoutesOptions,
  transferRoutes,
} from "@/server/transfer-routes";
import { TransferStore, verifierOf } from "@/server/transfer-store";
import {
  SESSION_TRANSFER_FEATURE,
  TRANSFER_ABANDON_AFTER_MS,
  TRANSFER_RETENTION_MS,
  TRANSFER_TOKEN_TTL_MS,
  type TransferCommitParams,
  type TransferView,
} from "@/server/types";

const HOST = "user@hub-host";
const SESSIONS = `http://localhost/api/hosts/${HOST}/sessions`;
const TRANSFERS = "http://localhost/api/transfers";
const PUBLIC_ORIGIN = "https://hub-host.example";
const START = 1_700_000_000_000;

/** Thrown by a fake handler to reply with a JSON-RPC error. */
class RpcFault {
  constructor(
    readonly code: number,
    readonly message: string,
  ) {}
}

interface Call {
  method: string;
  params: Json;
}

type MethodHandler = (params: Json, env: Env) => unknown;
type Handlers = Record<string, MethodHandler>;
type Json = Record<string, unknown>;

/** The operation block of a transfer.commit request. */
function operationIn(params: Json): TransferCommitParams["operation"] {
  return params.operation as TransferCommitParams["operation"];
}

function operationOf(
  call: Call | undefined,
): TransferCommitParams["operation"] {
  return operationIn(call?.params ?? {});
}

interface Env {
  registry: AgentRegistry;
  store: TransferStore;
  app: { handle(request: Request): Promise<Response> };
  calls: Call[];
  dir: string;
  clock: { now: number };
}

interface Started {
  id: string;
  token: string;
  renewalSecret: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const defaults: Handlers = {
  "collab.list": () => ({
    sessions: [
      { instanceId: "inst-1", sessionId: "sess-1" },
      { instanceId: "inst-2", sessionId: "sess-2" },
    ],
  }),
  "transfer.destinations": () => ({
    enabled: true,
    destinations: [{ name: "worker-a", hostId: "user@worker-host" }],
  }),
  "transfer.plan": () => ({
    planId: "plan-1",
    digest: "digest-1",
    plan: { entries: [] },
    preflight: { ok: true },
  }),
  "transfer.commit": (params) => ({ operationId: operationIn(params).id }),
};

/** The fake agents' connections by instance id, for tests that drop one. */
const connections = new Map<string, AgentConn>();

function registerAgent(
  registry: AgentRegistry,
  handler: (method: string, params: Json) => unknown,
  features: string[],
  instanceId = "inst-1",
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
    { hostId: HOST, instanceId, pid: 1, cwd: "/work", features },
    conn,
  );
  connections.set(instanceId, conn);
  return calls;
}

interface SetupOptions {
  features?: string[];
  routes?: TransferRoutesOptions;
}

function setup(over: Handlers = {}, options: SetupOptions = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "omp-hub-transfers-"));
  dirs.push(dir);
  const registry = new AgentRegistry();
  const env = { registry, dir, clock: { now: START } } as Env;
  env.calls = registerAgent(
    registry,
    (method, params) => {
      const handler = over[method] ?? defaults[method];
      if (!handler) throw new RpcFault(-32601, `unknown method '${method}'`);
      return handler(params, env);
    },
    options.features ?? ["session.v1", SESSION_TRANSFER_FEATURE],
  );
  env.store = new TransferStore(dir, () => env.clock.now);
  env.app = transferRoutes(registry, env.store, {
    publicOrigin: PUBLIC_ORIGIN,
    ...options.routes,
  });
  return env;
}

async function json(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

function request(
  url: string,
  method: string,
  body?: unknown,
  bearer?: string,
): Request {
  return new Request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const commitBody = {
  destination: "worker-a",
  planId: "plan-1",
  planDigest: "digest-1",
  projectMode: "session-only",
};

function sessionPost(
  env: Env,
  route: string,
  body: unknown = {},
  instance = "inst-1",
) {
  return env.app.handle(
    request(`${SESSIONS}/${instance}/transfer/${route}`, "POST", body),
  );
}

/** Commits a transfer and returns the secrets the extension received. */
async function start(env: Env): Promise<Started> {
  const response = await sessionPost(env, "commit", commitBody);
  expect(response.status).toBe(200);
  const { operationId } = await json(response);
  const call = env.calls.filter((c) => c.method === "transfer.commit").at(-1);
  const { token, renewalSecret } = operationOf(call);
  return { id: operationId as string, token, renewalSecret };
}

function worker(
  env: Env,
  id: string,
  route: string,
  options: { method?: string; body?: unknown; bearer?: string } = {},
) {
  return env.app.handle(
    request(
      `${TRANSFERS}/${id}/worker/${route}`,
      options.method ?? "POST",
      options.body,
      options.bearer,
    ),
  );
}

function event(env: Env, started: Started, body: unknown) {
  return worker(env, started.id, "events", { body, bearer: started.token });
}

describe("transfer-routes: forwarding and gates", () => {
  test("answers 501 without calling the session when the feature is absent", async () => {
    const env = setup({}, { features: ["session.v1"] });
    for (const [route, body] of [
      ["destinations", {}],
      ["plan", { destination: "worker-a" }],
      ["commit", commitBody],
    ] as const) {
      const response = await sessionPost(env, route, body);
      expect(response.status).toBe(501);
      expect((await json(response)).error).toContain(SESSION_TRANSFER_FEATURE);
    }
    expect(env.calls).toEqual([]);
    expect(env.store.list()).toEqual([]);
  });

  test("404 for a session that is not connected and 400 for a bad instance id", async () => {
    const env = setup();
    expect(
      (await sessionPost(env, "plan", { destination: "worker-a" }, "other"))
        .status,
    ).toBe(404);
    expect(
      (await sessionPost(env, "plan", { destination: "worker-a" }, "in.st"))
        .status,
    ).toBe(400);
  });

  test("control access is enforced by the extension: forbidden answers 403", async () => {
    const forbid = () => {
      throw new RpcFault(-32003, "control access required");
    };
    const env = setup({
      "transfer.destinations": forbid,
      "transfer.plan": forbid,
      "transfer.commit": forbid,
    });
    expect((await sessionPost(env, "destinations")).status).toBe(403);
    expect(
      (await sessionPost(env, "plan", { destination: "worker-a" })).status,
    ).toBe(403);
    const commit = await sessionPost(env, "commit", commitBody);
    expect(commit.status).toBe(403);
    expect(await json(commit)).toEqual({ error: "control access required" });
    expect(env.store.list()).toEqual([]);
  });

  test("destinations and plan forward their parameters and relay the result", async () => {
    const env = setup();
    const destinations = await sessionPost(env, "destinations");
    expect(await json(destinations)).toEqual({
      enabled: true,
      destinations: [{ name: "worker-a", hostId: "user@worker-host" }],
    });
    const plan = await sessionPost(env, "plan", {
      destination: "worker-a",
      projectMode: "update",
      destinationPath: "/home/user/project",
    });
    expect(plan.status).toBe(200);
    expect((await json(plan)).planId).toBe("plan-1");
    expect(env.calls).toEqual([
      { method: "transfer.destinations", params: {} },
      {
        method: "transfer.plan",
        params: {
          destination: "worker-a",
          projectMode: "update",
          destinationPath: "/home/user/project",
        },
      },
    ]);
  });

  test("plan and commit bodies are validated before any call", async () => {
    const env = setup();
    for (const body of [
      {},
      { destination: "../etc" },
      { destination: "worker-a", projectMode: "overwrite" },
      { destination: "worker-a", destinationPath: "bad\u0000path" },
    ])
      expect((await sessionPost(env, "plan", body)).status).toBe(400);
    for (const body of [
      { ...commitBody, planId: "" },
      { ...commitBody, projectMode: "x" },
      { ...commitBody, destination: "a b" },
      { ...commitBody, acceptIncomplete: "yes" },
    ])
      expect((await sessionPost(env, "commit", body)).status).toBe(400);
    expect(env.calls).toEqual([]);
  });

  test("plan and commit use their own deadlines", async () => {
    const hang = () => new Promise(() => {});
    const env = setup(
      { "transfer.plan": hang, "transfer.commit": hang },
      { routes: { planTimeoutMs: 20, commitTimeoutMs: 20 } },
    );
    expect(
      (await sessionPost(env, "plan", { destination: "worker-a" })).status,
    ).toBe(504);
    expect((await sessionPost(env, "commit", commitBody)).status).toBe(504);
  });

  test("dashboard mutations are rate limited; worker routes are not", async () => {
    const env = setup();
    const started = await start(env);
    for (let i = 0; i < 19; i++)
      expect((await sessionPost(env, "destinations")).status).toBe(200);
    expect((await sessionPost(env, "destinations")).status).toBe(429);
    for (let i = 0; i < 40; i++)
      expect(
        (
          await worker(env, started.id, "commands", {
            method: "GET",
            bearer: started.token,
          })
        ).status,
      ).toBe(200);
  });
});

describe("transfer-routes: commit", () => {
  test("creates the operation and forwards the secrets to the session", async () => {
    const env = setup();
    const response = await sessionPost(env, "commit", {
      ...commitBody,
      acceptIncomplete: true,
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    const id = body.operationId as string;
    expect(Object.keys(body)).toEqual(["operationId"]);

    const call = env.calls.find((c) => c.method === "transfer.commit");
    expect(call?.params).toEqual({
      planId: "plan-1",
      planDigest: "digest-1",
      projectMode: "session-only",
      acceptIncomplete: true,
      operation: {
        id,
        token: expect.any(String),
        renewalSecret: expect.any(String),
        hubUrl: PUBLIC_ORIGIN,
      },
    });
    const { token, renewalSecret } = operationOf(call);
    expect(token).not.toBe(renewalSecret);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(Buffer.from(renewalSecret, "base64url")).toHaveLength(32);

    const view = env.store.view(id);
    expect(view).toMatchObject({
      id,
      sessionId: "sess-1",
      host: HOST,
      instance: "inst-1",
      destination: "worker-a",
      state: "prepared",
      lastConfirmedState: "prepared",
      planDigest: "digest-1",
      projectMode: "session-only",
      finished: false,
      commands: [],
    });
    expect(view?.history).toHaveLength(1);
    expect(env.store.checkToken(id, token)).toBe("ok");
    expect(env.store.checkRenewal(id, renewalSecret)).toBe(true);
  });

  test("the state file holds verifiers, never the secrets", async () => {
    const env = setup();
    const started = await start(env);
    const file = readFileSync(join(env.dir, "transfers.json"), "utf8");
    expect(file).not.toContain(started.token);
    expect(file).not.toContain(started.renewalSecret);
    expect(file).toContain(verifierOf(started.token));
    expect(file).toContain(verifierOf(started.renewalSecret));
  });

  test("hub URL falls back to the request origin without a public origin", async () => {
    const env = setup({}, { routes: { publicOrigin: null } });
    await start(env);
    const call = env.calls.find((c) => c.method === "transfer.commit");
    expect(operationOf(call).hubUrl).toBe("http://localhost");
  });

  test("a second commit for the same session answers 409", async () => {
    const env = setup();
    const first = await start(env);
    const second = await sessionPost(env, "commit", commitBody);
    expect(second.status).toBe(409);
    expect((await json(second)).error).toContain(first.id);
    expect(
      env.calls.filter((c) => c.method === "transfer.commit"),
    ).toHaveLength(1);
    expect(env.store.list()).toHaveLength(1);
  });

  test("concurrent commits for one session create one operation", async () => {
    const gate = Promise.withResolvers<void>();
    const env = setup({
      "transfer.commit": async (params) => {
        await gate.promise;
        return { operationId: operationIn(params).id };
      },
    });
    const first = sessionPost(env, "commit", commitBody);
    const second = sessionPost(env, "commit", commitBody);
    // The winner's RPC is blocked, so only the refused request can answer.
    const refused = await Promise.race([first, second]);
    expect(refused.status).toBe(409);
    gate.resolve();
    const statuses = [(await first).status, (await second).status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(env.store.list()).toHaveLength(1);
  });

  test("a finished or terminal operation no longer blocks the session", async () => {
    const env = setup();
    const first = await start(env);
    await event(env, first, { state: "completed" });
    const second = await sessionPost(env, "commit", commitBody);
    expect(second.status).toBe(200);
  });

  test("an RPC failure removes the operation and frees the session", async () => {
    let fail = true;
    const env = setup({
      "transfer.commit": (params) => {
        if (fail)
          throw new RpcFault(
            -32006,
            `busy; token ${operationIn(params).token} rejected`,
          );
        return { operationId: operationIn(params).id };
      },
    });
    const response = await sessionPost(env, "commit", commitBody);
    expect(response.status).toBe(409);
    const token = operationOf(
      env.calls.find((c) => c.method === "transfer.commit"),
    ).token;
    expect(JSON.stringify(await json(response))).not.toContain(token);
    expect(env.store.list()).toEqual([]);
    expect(
      JSON.parse(readFileSync(join(env.dir, "transfers.json"), "utf8"))
        .transfers,
    ).toEqual([]);

    fail = false;
    expect((await sessionPost(env, "commit", commitBody)).status).toBe(200);
  });

  test("a failure after the worker reported in keeps the operation", async () => {
    const env = setup({
      "transfer.commit": async (params, e) => {
        const reported = await e.app.handle(
          request(
            `${TRANSFERS}/${operationIn(params).id}/worker/events`,
            "POST",
            { state: "source-stopping" },
            operationIn(params).token,
          ),
        );
        expect(reported.status).toBe(200);
        throw new RpcFault(-32006, "late failure");
      },
    });
    const response = await sessionPost(env, "commit", commitBody);
    expect(response.status).toBe(200);
    const { operationId } = await json(response);
    expect(env.store.view(operationId as string)?.state).toBe(
      "source-stopping",
    );
  });

  test("a session missing from the host's list answers 404 without creating an operation", async () => {
    const env = setup({ "collab.list": () => ({ sessions: [] }) });
    expect((await sessionPost(env, "commit", commitBody)).status).toBe(404);
    expect(env.store.list()).toEqual([]);
  });
});

describe("transfer-routes: worker auth", () => {
  test("a correct token is accepted; missing, wrong and foreign tokens are not", async () => {
    const env = setup();
    registerAgent(
      env.registry,
      (method, params) => defaults[method]?.(params, env),
      ["session.v1", SESSION_TRANSFER_FEATURE],
      "inst-2",
    );
    const a = await start(env);
    const bResponse = await sessionPost(env, "commit", commitBody, "inst-2");
    expect(bResponse.status).toBe(200);
    const bId = (await json(bResponse)).operationId as string;

    expect((await event(env, a, { state: "source-stopping" })).status).toBe(
      200,
    );
    const missing = await worker(env, a.id, "events", {
      body: { state: "staged" },
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    const wrong = await worker(env, a.id, "events", {
      body: { state: "staged" },
      bearer: "nope",
    });
    expect(wrong.status).toBe(401);
    expect((await json(wrong)).code).toBe("token-invalid");
    const foreign = await worker(env, bId, "events", {
      body: { state: "staged" },
      bearer: a.token,
    });
    expect(foreign.status).toBe(401);
    expect(env.store.view(a.id)?.state).toBe("source-stopping");
    expect(env.store.view(bId)?.state).toBe("prepared");
  });

  test("an unknown operation answers 404 on every worker route", async () => {
    const env = setup();
    for (const [route, method] of [
      ["events", "POST"],
      ["commands", "GET"],
      ["commands/1/ack", "POST"],
      ["renew", "POST"],
      ["finish", "POST"],
    ] as const) {
      const response = await worker(env, "missing", route, {
        method,
        bearer: "x",
        body: method === "POST" ? { state: "staged" } : undefined,
      });
      expect(response.status).toBe(404);
    }
  });

  test("an expired token answers 401 token-expired and renewal issues a fresh one", async () => {
    const env = setup();
    const started = await start(env);
    env.clock.now += TRANSFER_TOKEN_TTL_MS - 1;
    expect(
      (await event(env, started, { state: "source-stopping" })).status,
    ).toBe(200);
    env.clock.now += 1;
    const expired = await event(env, started, { state: "source-stopped" });
    expect(expired.status).toBe(401);
    expect((await json(expired)).code).toBe("token-expired");
    const wrongAfterExpiry = await worker(env, started.id, "events", {
      body: { state: "staged" },
      bearer: "nope",
    });
    expect((await json(wrongAfterExpiry)).code).toBe("token-invalid");

    const renewed = await worker(env, started.id, "renew", {
      bearer: started.renewalSecret,
    });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get("cache-control")).toBe("no-store");
    const { token, expiresAt } = await json(renewed);
    expect(expiresAt).toBe(env.clock.now + TRANSFER_TOKEN_TTL_MS);
    expect(token).not.toBe(started.token);

    expect(
      (
        await worker(env, started.id, "events", {
          body: { state: "source-stopped" },
          bearer: token as string,
        })
      ).status,
    ).toBe(200);
    expect((await event(env, started, { state: "staged" })).status).toBe(401);
  });

  test("renewal needs the renewal secret, not the worker token", async () => {
    const env = setup();
    const started = await start(env);
    for (const bearer of [started.token, "nope", undefined]) {
      const response = await worker(env, started.id, "renew", { bearer });
      expect(response.status).toBe(401);
      expect((await json(response)).code).toBe("renewal-invalid");
    }
    expect(env.store.checkToken(started.id, started.token)).toBe("ok");
  });

  test("finish revokes the renewal secret", async () => {
    const env = setup();
    const started = await start(env);
    const renewed = await worker(env, started.id, "renew", {
      bearer: started.renewalSecret,
    });
    expect(renewed.status).toBe(200);
    const { token } = await json(renewed);

    const finish = await worker(env, started.id, "finish", {
      bearer: token as string,
    });
    expect(finish.status).toBe(200);
    expect(env.store.view(started.id)?.finished).toBe(true);
    const again = await worker(env, started.id, "renew", {
      bearer: started.renewalSecret,
    });
    expect(again.status).toBe(401);
    expect((await json(again)).code).toBe("renewal-invalid");
    expect(env.store.checkRenewal(started.id, started.renewalSecret)).toBe(
      false,
    );
    expect(
      JSON.parse(readFileSync(join(env.dir, "transfers.json"), "utf8"))
        .transfers[0].renewalVerifier,
    ).toBe("");
    // Repeating finish is harmless.
    expect(
      (await worker(env, started.id, "finish", { bearer: token as string }))
        .status,
    ).toBe(200);
  });
});

describe("transfer-routes: worker events", () => {
  test("records state, detail, error and progress", async () => {
    const env = setup();
    const started = await start(env);
    const first = await event(env, started, {
      state: "source-stopping",
      detail: "waiting for idle",
      progress: { phase: "stop" },
    });
    expect(await json(first)).toEqual({ ok: true, applied: true });
    expect(env.store.view(started.id)).toMatchObject({
      state: "source-stopping",
      lastConfirmedState: "source-stopping",
      progress: { phase: "stop" },
    });

    await event(env, started, {
      state: "aborting",
      error: { code: "ssh", message: "connection lost" },
    });
    const failed = env.store.view(started.id);
    expect(failed?.state).toBe("aborting");
    expect(failed?.lastConfirmedState).toBe("source-stopping");
    expect(failed?.error).toMatchObject({
      code: "ssh",
      message: "connection lost",
    });
    expect(failed?.history.map((h) => h.state)).toEqual([
      "prepared",
      "source-stopping",
      "aborting",
    ]);
    expect(failed?.history[1]?.detail).toBe("waiting for idle");

    await event(env, started, { state: "rolled-back" });
    const done = env.store.view(started.id);
    expect(done?.error).toBeUndefined();
    expect(done?.lastConfirmedState).toBe("rolled-back");
  });

  test("replayed events change nothing", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, { state: "source-stopping" });
    const before = env.store.view(started.id);
    env.clock.now += 1000;
    const replay = await event(env, started, { state: "source-stopping" });
    expect(await json(replay)).toEqual({ ok: true, applied: false });
    expect(env.store.view(started.id)).toEqual(before);

    const error = { state: "aborting", error: { code: "x", message: "y" } };
    await event(env, started, error);
    const withError = env.store.view(started.id);
    env.clock.now += 1000;
    await event(env, started, error);
    expect(env.store.view(started.id)).toEqual(withError);
  });

  test("a terminal state never changes and a state regression is dropped", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, { state: "completed" });
    const before = env.store.view(started.id);
    for (const state of ["prepared", "publishing", "aborting", "rolled-back"]) {
      const response = await event(env, started, { state });
      expect(await json(response)).toEqual({ ok: true, applied: false });
    }
    expect(env.store.view(started.id)).toEqual(before);

    await event(env, started, {
      state: "aborting",
      error: { code: "x", message: "y" },
      progress: { phase: "cleanup" },
    });
    const after = env.store.view(started.id);
    expect(after?.state).toBe("completed");
    expect(after?.history).toEqual(before?.history);
  });

  test("a terminal operation takes error and progress reports until the worker finishes", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, { state: "rolled-back" });
    const report = {
      state: "rolled-back",
      error: { code: "restore-failed", message: "destination edited" },
      progress: { phase: "restore" },
    };
    expect(await json(await event(env, started, report))).toEqual({
      ok: true,
      applied: true,
    });
    const reported = env.store.view(started.id);
    expect(reported).toMatchObject({
      state: "rolled-back",
      lastConfirmedState: "rolled-back",
      error: { code: "restore-failed", message: "destination edited" },
      progress: { phase: "restore" },
    });
    expect(reported?.history.map((h) => h.state)).toEqual([
      "prepared",
      "rolled-back",
    ]);

    // Repeats and state-only events change nothing and do not clear the error.
    for (const body of [
      report,
      { state: "rolled-back" },
      { state: "prepared" },
    ])
      expect(await json(await event(env, started, body))).toEqual({
        ok: true,
        applied: false,
      });
    expect(env.store.view(started.id)).toEqual(reported);

    await worker(env, started.id, "finish", { bearer: started.token });
    const finished = env.store.view(started.id);
    const late = await event(env, started, {
      state: "rolled-back",
      error: { code: "late", message: "after finish" },
      progress: { phase: "late" },
    });
    expect(await json(late)).toEqual({ ok: true, applied: false });
    expect(env.store.view(started.id)).toEqual(finished);
  });

  test("a same-state event with only progress keeps the error and the confirmed state", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, { state: "source-stopping" });
    await event(env, started, {
      state: "aborting",
      error: { code: "x", message: "y" },
    });
    const failed = env.store.view(started.id);
    expect(failed?.lastConfirmedState).toBe("source-stopping");

    const refused = await event(env, started, {
      state: "aborting",
      progress: { recoveryRefused: "live-owner" },
    });
    expect(await json(refused)).toEqual({ ok: true, applied: true });
    expect(env.store.view(started.id)).toMatchObject({
      state: "aborting",
      lastConfirmedState: "source-stopping",
      error: { code: "x", message: "y" },
      progress: { recoveryRefused: "live-owner" },
    });

    // Without progress the same state confirms and clears the error.
    await event(env, started, { state: "aborting" });
    const cleared = env.store.view(started.id);
    expect(cleared?.error).toBeUndefined();
    expect(cleared?.lastConfirmedState).toBe("aborting");
  });

  test("a state change with progress clears the error and confirms the new state", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, {
      state: "aborting",
      error: { code: "x", message: "y" },
    });
    await event(env, started, {
      state: "rolled-back",
      progress: { phase: "done" },
    });
    const view = env.store.view(started.id);
    expect(view?.error).toBeUndefined();
    expect(view?.lastConfirmedState).toBe("rolled-back");
    expect(view?.progress).toEqual({ phase: "done" });
  });

  test("invalid payloads answer 400 and change nothing", async () => {
    const env = setup();
    const started = await start(env);
    for (const body of [
      {},
      { state: "unknown" },
      { state: "staged", detail: "" },
      { state: "staged", error: { code: "x" } },
      { state: "staged", progress: "text" },
      { state: "staged", progress: { blob: "x".repeat(9000) } },
    ])
      expect((await event(env, started, body)).status).toBe(400);
    expect(env.store.view(started.id)?.state).toBe("prepared");
  });
});

describe("transfer-routes: commands", () => {
  async function post(env: Env, id: string, action: string, body?: unknown) {
    return env.app.handle(
      request(`${TRANSFERS}/${id}/${action}`, "POST", body),
    );
  }
  function commands(env: Env, started: Started, after = 0) {
    return worker(env, started.id, `commands?after=${after}`, {
      method: "GET",
      bearer: started.token,
    });
  }

  test("cancel and recover append ordered commands the worker reads and acknowledges", async () => {
    const env = setup();
    const started = await start(env);
    expect((await commands(env, started)).status).toBe(200);
    expect(await json(await commands(env, started))).toEqual({ commands: [] });

    const cancel = await post(env, started.id, "cancel");
    expect(cancel.status).toBe(200);
    expect(
      ((await json(cancel)) as unknown as TransferView).commands.map(
        (c) => c.seq,
      ),
    ).toEqual([1]);
    const recover = await post(env, started.id, "recover", {
      action: "restore-project",
    });
    expect(recover.status).toBe(200);

    expect(await json(await commands(env, started))).toEqual({
      commands: [
        { seq: 1, type: "cancel", payload: {} },
        { seq: 2, type: "recover", payload: { action: "restore-project" } },
      ],
    });
    expect(await json(await commands(env, started, 1))).toEqual({
      commands: [
        { seq: 2, type: "recover", payload: { action: "restore-project" } },
      ],
    });

    const ack = await worker(env, started.id, "commands/1/ack", {
      bearer: started.token,
    });
    expect(await json(ack)).toEqual({ ok: true });
    expect(
      (
        await worker(env, started.id, "commands/1/ack", {
          bearer: started.token,
        })
      ).status,
    ).toBe(200);
    expect(await json(await commands(env, started))).toEqual({
      commands: [
        { seq: 2, type: "recover", payload: { action: "restore-project" } },
      ],
    });
    expect(env.store.view(started.id)?.commands[0]?.ackedAt).toBeString();
    expect(env.store.view(started.id)?.commands[1]?.ackedAt).toBeUndefined();
  });

  test("a waiting identical command is not queued twice; later ones get new sequence numbers", async () => {
    const env = setup();
    const started = await start(env);
    await post(env, started.id, "cancel");
    await post(env, started.id, "cancel");
    expect(env.store.view(started.id)?.commands).toHaveLength(1);
    await worker(env, started.id, "commands/1/ack", { bearer: started.token });
    await post(env, started.id, "cancel");
    expect(env.store.view(started.id)?.commands.map((c) => c.seq)).toEqual([
      1, 2,
    ]);
  });

  test("ack and query validation", async () => {
    const env = setup();
    const started = await start(env);
    expect(
      (
        await worker(env, started.id, "commands/9/ack", {
          bearer: started.token,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await worker(env, started.id, "commands/0/ack", {
          bearer: started.token,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await worker(env, started.id, "commands/x/ack", {
          bearer: started.token,
        })
      ).status,
    ).toBe(400);
    expect((await commands(env, started, -1)).status).toBe(400);
    expect(
      (
        await worker(env, started.id, "commands?after=abc", {
          method: "GET",
          bearer: started.token,
        })
      ).status,
    ).toBe(400);
    expect(
      (await worker(env, started.id, "commands", { method: "GET" })).status,
    ).toBe(401);
  });

  test("recover validates its action; unknown ids answer 404", async () => {
    const env = setup();
    const started = await start(env);
    for (const body of [undefined, {}, { action: "format-disk" }])
      expect((await post(env, started.id, "recover", body)).status).toBe(400);
    expect(env.store.view(started.id)?.commands).toEqual([]);
    for (const action of ["cancel", "recover"])
      expect(
        (await post(env, "missing", action, { action: "cleanup" })).status,
      ).toBe(404);
  });

  test.each([
    "resume",
    "retry-launch",
    "rollback-source",
    "restore-project",
    "cleanup",
  ])("recover accepts the %s action and queues it for the worker", async (action) => {
    const env = setup();
    const started = await start(env);
    await event(env, started, { state: "source-stopping" });
    const response = await post(env, started.id, "recover", { action });
    expect(response.status).toBe(200);
    expect(
      await json(
        await worker(env, started.id, "commands", {
          method: "GET",
          bearer: started.token,
        }),
      ),
    ).toEqual({
      commands: [{ seq: 1, type: "recover", payload: { action } }],
    });
  });

  test("cancel on a terminal operation answers 409", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, { state: "completed" });
    const response = await post(env, started.id, "cancel");
    expect(response.status).toBe(409);
    expect(env.store.view(started.id)?.commands).toEqual([]);
  });

  test("commands for a finished operation answer 409", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, { state: "rolled-back" });
    await worker(env, started.id, "finish", { bearer: started.token });
    expect(
      (await post(env, started.id, "recover", { action: "cleanup" })).status,
    ).toBe(409);
    expect((await post(env, started.id, "cancel")).status).toBe(409);
  });
});

describe("transfer-routes: read and broadcast", () => {
  test("GET never exposes verifiers or secrets", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, {
      state: "staged",
      error: { code: "x", message: "y" },
    });
    const renewed = await worker(env, started.id, "renew", {
      bearer: started.renewalSecret,
    });
    const { token } = await json(renewed);

    const list = await env.app.handle(new Request(TRANSFERS));
    const detail = await env.app.handle(
      new Request(`${TRANSFERS}/${started.id}`),
    );
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    const texts = [await list.text(), await detail.text()];
    for (const text of texts) {
      for (const secret of [
        started.token,
        started.renewalSecret,
        token as string,
      ])
        expect(text).not.toContain(secret);
      for (const secret of [
        started.token,
        started.renewalSecret,
        token as string,
      ])
        expect(text).not.toContain(verifierOf(secret));
      expect(text).not.toMatch(/erifier|tokenExpiresAt/);
    }
    expect(JSON.parse(texts[1] as string)).toMatchObject({
      id: started.id,
      state: "staged",
    });
    expect(JSON.parse(texts[0] as string)).toHaveLength(1);
  });

  test("GET of an unknown operation answers 404", async () => {
    const env = setup();
    expect(
      (await env.app.handle(new Request(`${TRANSFERS}/missing`))).status,
    ).toBe(404);
  });

  test("every change is announced with the view, including cancel and ack", async () => {
    const env = setup();
    const seen: TransferView[] = [];
    env.store.onChange((view) => seen.push(view));
    const started = await start(env);
    expect(seen.map((v) => v.state)).toEqual(["prepared"]);

    await event(env, started, { state: "source-stopping" });
    await env.app.handle(request(`${TRANSFERS}/${started.id}/cancel`, "POST"));
    await worker(env, started.id, "commands/1/ack", { bearer: started.token });
    await worker(env, started.id, "finish", { bearer: started.token });
    expect(seen.map((v) => [v.state, v.commands.length, v.finished])).toEqual([
      ["prepared", 0, false],
      ["source-stopping", 0, false],
      ["source-stopping", 1, false],
      ["source-stopping", 1, false],
      ["source-stopping", 1, true],
    ]);
    expect(JSON.stringify(seen)).not.toMatch(/erifier/);
    expect(JSON.stringify(seen)).not.toContain(started.token);
  });
});

describe("TransferStore persistence", () => {
  test("active operations survive a reload with their credentials and commands", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, { state: "publishing" });
    await env.app.handle(
      request(`${TRANSFERS}/${started.id}/recover`, "POST", {
        action: "cleanup",
      }),
    );

    const reloaded = new TransferStore(env.dir, () => env.clock.now);
    expect(reloaded.list()).toEqual(env.store.list());
    expect(reloaded.checkToken(started.id, started.token)).toBe("ok");
    expect(reloaded.checkRenewal(started.id, started.renewalSecret)).toBe(true);
    expect(reloaded.pendingCommands(started.id, 0)).toHaveLength(1);

    const app = transferRoutes(env.registry, reloaded, {
      publicOrigin: PUBLIC_ORIGIN,
    });
    const response = await app.handle(
      request(
        `${TRANSFERS}/${started.id}/worker/events`,
        "POST",
        { state: "source-departed" },
        started.token,
      ),
    );
    expect(response.status).toBe(200);
    expect(reloaded.view(started.id)?.state).toBe("source-departed");
    expect(
      (
        await app.handle(
          request(`${SESSIONS}/inst-1/transfer/commit`, "POST", commitBody),
        )
      ).status,
    ).toBe(409);
  });

  test("the state file is replaced atomically and holds only transfers.json", async () => {
    const env = setup();
    await start(env);
    expect(readdirSync(env.dir)).toEqual(["transfers.json"]);
    expect(
      JSON.parse(readFileSync(join(env.dir, "transfers.json"), "utf8")),
    ).toMatchObject({ version: 1 });
  });

  test.each([
    ["not JSON", "{not json"],
    ["a wrong shape", JSON.stringify({ version: 1, transfers: [{ id: "x" }] })],
    ["an unknown version", JSON.stringify({ version: 2, transfers: [] })],
  ])(
    "a file that is %s is renamed aside and the store starts empty",
    (_, content) => {
      const dir = mkdtempSync(join(tmpdir(), "omp-hub-transfers-"));
      dirs.push(dir);
      writeFileSync(join(dir, "transfers.json"), content);
      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        const store = new TransferStore(dir);
        expect(store.list()).toEqual([]);
        const files = readdirSync(dir);
        expect(files).toHaveLength(1);
        expect(files[0]).toStartWith("transfers.json.corrupt-");
        expect(readFileSync(join(dir, files[0] as string), "utf8")).toBe(
          content,
        );
        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    },
  );

  test("a missing file starts empty without a log", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-hub-transfers-"));
    dirs.push(dir);
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(new TransferStore(dir).list()).toEqual([]);
      expect(log).not.toHaveBeenCalled();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("transfer-routes: commit failures without a verdict", () => {
  test("a timeout keeps the operation and names it for a later abandon", async () => {
    const env = setup(
      { "transfer.commit": () => new Promise(() => {}) },
      { routes: { commitTimeoutMs: 20 } },
    );
    const response = await sessionPost(env, "commit", commitBody);
    expect(response.status).toBe(504);
    const body = await json(response);
    const [kept] = env.store.list();
    expect(env.store.list()).toHaveLength(1);
    expect(body.operationId).toBe(kept?.id);
    expect(body.error).toContain("may have started");
    expect(body.error).toContain("abandoned later");
    expect(kept).toMatchObject({ state: "prepared", workerStarted: false });
    const token = operationOf(
      env.calls.find((c) => c.method === "transfer.commit"),
    ).token;
    expect(JSON.stringify(body)).not.toContain(token);

    // The session stays blocked until the operation is abandoned.
    expect((await sessionPost(env, "commit", commitBody)).status).toBe(409);
    const abandoned = await env.app.handle(
      request(`${TRANSFERS}/${kept?.id}/abandon`, "POST"),
    );
    expect(abandoned.status).toBe(200);
  });

  test("a dropped connection keeps the operation and answers 502", async () => {
    const env = setup({
      "transfer.commit": (_, e) => {
        e.registry.unregister(
          `${HOST}:inst-1`,
          connections.get("inst-1") as AgentConn,
        );
        return new Promise(() => {});
      },
    });
    const response = await sessionPost(env, "commit", commitBody);
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.error).toContain("may have started");
    expect(env.store.view(body.operationId as string)?.state).toBe("prepared");
  });

  test("an error reply withdraws the operation", async () => {
    const env = setup({
      "transfer.commit": () => {
        throw new RpcFault(-32004, "plan is stale");
      },
    });
    const response = await sessionPost(env, "commit", commitBody);
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "plan is stale" });
    expect(env.store.list()).toEqual([]);
  });

  test("a failed withdrawal is logged and the operation is kept", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = setup({
        "transfer.commit": (_, e) => {
          // A directory in place of the state file makes the next save fail.
          const file = join(e.dir, "transfers.json");
          rmSync(file);
          mkdirSync(file);
          throw new RpcFault(-32006, "busy");
        },
      });
      const response = await sessionPost(env, "commit", commitBody);
      expect(response.status).toBe(409);
      const body = await json(response);
      expect(body.error).toContain("abandoned later");
      expect(env.store.view(body.operationId as string)).toBeDefined();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe("transfer-routes: abandon", () => {
  function abandon(env: Env, id: string) {
    return env.app.handle(request(`${TRANSFERS}/${id}/abandon`, "POST"));
  }

  test("closes an operation whose worker never reported in", async () => {
    const env = setup();
    const started = await start(env);
    const seen: TransferView[] = [];
    env.store.onChange((view) => seen.push(view));
    expect(env.store.view(started.id)).toMatchObject({
      workerStarted: false,
      updatedAt: expect.any(String),
    });

    const response = await abandon(env, started.id);
    expect(response.status).toBe(200);
    const view = (await json(response)) as unknown as TransferView;
    expect(view).toMatchObject({
      id: started.id,
      state: "rolled-back",
      lastConfirmedState: "prepared",
      finished: true,
      error: { code: "abandoned" },
    });
    expect(view.error?.message).toContain("ompc-send recover");
    expect(view.history.at(-1)).toMatchObject({
      state: "rolled-back",
      detail: "abandoned",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.state).toBe("rolled-back");

    expect(env.store.checkToken(started.id, started.token)).toBe("invalid");
    expect(env.store.checkRenewal(started.id, started.renewalSecret)).toBe(
      false,
    );
    const saved = JSON.parse(
      readFileSync(join(env.dir, "transfers.json"), "utf8"),
    ) as { transfers: { tokenVerifier: string; renewalVerifier: string }[] };
    expect(saved.transfers[0]).toMatchObject({
      tokenVerifier: "",
      renewalVerifier: "",
    });
    expect((await event(env, started, { state: "staged" })).status).toBe(401);
    expect(
      (
        await worker(env, started.id, "renew", {
          bearer: started.renewalSecret,
        })
      ).status,
    ).toBe(401);
    // The session is free again.
    expect((await sessionPost(env, "commit", commitBody)).status).toBe(200);
  });

  test("a started worker must be silent for the abandon period", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, { state: "source-stopping" });
    expect((await abandon(env, started.id)).status).toBe(409);
    env.clock.now += TRANSFER_ABANDON_AFTER_MS - 1;
    expect((await abandon(env, started.id)).status).toBe(409);
    expect(env.store.view(started.id)?.finished).toBe(false);
    env.clock.now += 1;
    const response = await abandon(env, started.id);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      state: "rolled-back",
      lastConfirmedState: "source-stopping",
      finished: true,
    });
  });

  test("worker activity postpones the abandon period", async () => {
    const env = setup();
    const started = await start(env);
    await event(env, started, { state: "source-stopping" });
    // Inside the token lifetime, so the second event is accepted.
    env.clock.now += TRANSFER_TOKEN_TTL_MS - 1000;
    await event(env, started, { state: "source-stopped" });
    env.clock.now += TRANSFER_ABANDON_AFTER_MS - 1;
    expect((await abandon(env, started.id)).status).toBe(409);
  });

  test("refuses a terminal or finished operation and an unknown id", async () => {
    const env = setup();
    const done = await start(env);
    await event(env, done, { state: "completed" });
    expect((await abandon(env, done.id)).status).toBe(409);
    await worker(env, done.id, "finish", { bearer: done.token });
    expect((await abandon(env, done.id)).status).toBe(409);

    const open = await start(env);
    await worker(env, open.id, "finish", { bearer: open.token });
    expect((await abandon(env, open.id)).status).toBe(409);
    expect(env.store.view(open.id)?.state).toBe("prepared");
    expect((await abandon(env, "missing")).status).toBe(404);
  });

  test("is a dashboard mutation: cross-origin browser requests are refused", () => {
    const url = `${TRANSFERS}/some-id/abandon`;
    expect(
      allowsMutationOrigin(
        new Request(url, {
          method: "POST",
          headers: { origin: "http://evil.example" },
        }),
      ),
    ).toBe(false);
    expect(allowsMutationOrigin(new Request(url, { method: "POST" }))).toBe(
      true,
    );
  });
});

describe("TransferStore retention", () => {
  /** Three operations for one session, ended differently, all at START. */
  async function endedOperations(env: Env) {
    const completed = await start(env);
    await event(env, completed, { state: "completed" });
    await worker(env, completed.id, "finish", { bearer: completed.token });
    const stuck = await start(env);
    await event(env, stuck, { state: "publishing" });
    await worker(env, stuck.id, "finish", { bearer: stuck.token });
    const rolledBack = await start(env);
    await event(env, rolledBack, { state: "rolled-back" });
    return { completed, stuck, rolledBack };
  }

  function savedIds(env: Env): string[] {
    const file = readFileSync(join(env.dir, "transfers.json"), "utf8");
    const saved: { transfers: { id: string }[] } = JSON.parse(file);
    return saved.transfers.map((t) => t.id);
  }

  test("finished terminal operations older than 14 days are dropped at load", async () => {
    const env = setup();
    const { stuck, rolledBack, completed } = await endedOperations(env);

    env.clock.now += TRANSFER_RETENTION_MS - 1;
    const early = new TransferStore(env.dir, () => env.clock.now);
    expect(early.list().map((t) => t.id)).toEqual([
      completed.id,
      stuck.id,
      rolledBack.id,
    ]);

    env.clock.now += 1;
    const late = new TransferStore(env.dir, () => env.clock.now);
    // Not terminal, or not finished: kept.
    expect(late.list().map((t) => t.id)).toEqual([stuck.id, rolledBack.id]);
  });

  test("creating an operation drops them from the state file too", async () => {
    const env = setup();
    const { stuck, rolledBack } = await endedOperations(env);
    expect(savedIds(env)).toHaveLength(3);

    env.clock.now += TRANSFER_RETENTION_MS;
    const fresh = await start(env);
    expect(savedIds(env)).toEqual([stuck.id, rolledBack.id, fresh.id]);
    expect(env.store.list().map((t) => t.id)).toEqual(savedIds(env));
  });
});
