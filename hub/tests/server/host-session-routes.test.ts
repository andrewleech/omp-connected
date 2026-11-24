import { expect, test } from "bun:test";
import { AgentRegistry } from "@/server/agent-registry";
import { hostSessionRoutes } from "@/server/host-session-routes";
import {
  HOST_FOLDERS_FEATURE,
  HOST_SESSIONS_FEATURE,
  HOST_SESSIONS_RESERVED_LABELS_FEATURE,
} from "@/server/types";

const base = "http://localhost/api/hosts/user@worker-host";
function agent(
  registry: AgentRegistry,
  id: string,
  features: string[],
  error?: { code: number; message: string },
  calls?: { id: string; method: string; params: unknown }[],
) {
  registry.register(
    {
      hostId: "user@worker-host",
      instanceId: id,
      pid: 123,
      cwd: "/work/project",
      features,
    },
    {
      close() {},
      send(data) {
        const request = JSON.parse(data);
        calls?.push({ id, method: request.method, params: request.params });
        queueMicrotask(() =>
          registry.resolveHostCall(
            request.id,
            error ? undefined : { sessions: [] },
            error,
          ),
        );
      },
    },
  );
}

function start(body: unknown) {
  return new Request(`${base}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("distinguishes disconnected hosts from connected hosts needing an extension update", async () => {
  const registry = new AgentRegistry();
  const app = hostSessionRoutes(registry);
  expect(
    (await app.handle(new Request(`${base}/session-history`))).status,
  ).toBe(404);
  agent(registry, "old", []);
  expect(
    (await app.handle(new Request(`${base}/session-history`))).status,
  ).toBe(501);
});

test("selects a capable connection even when an older extension connected first", async () => {
  const registry = new AgentRegistry();
  agent(registry, "old", [], { code: -32601, message: "Unsupported" });
  agent(registry, "updated", [HOST_SESSIONS_FEATURE]);
  expect(
    (
      await hostSessionRoutes(registry).handle(
        new Request(`${base}/session-history`),
      )
    ).status,
  ).toBe(200);
});

test("routes reserved-label launches to an updated connection rather than the oldest connection", async () => {
  const registry = new AgentRegistry();
  const calls: { id: string; method: string; params: unknown }[] = [];
  agent(registry, "old", [HOST_SESSIONS_FEATURE], undefined, calls);
  agent(
    registry,
    "updated",
    [HOST_SESSIONS_FEATURE, HOST_SESSIONS_RESERVED_LABELS_FEATURE],
    undefined,
    calls,
  );
  const app = hostSessionRoutes(registry);
  for (const reservedLabels of [["project.review"], []]) {
    const body = { cwd: "/work/project", name: "review", reservedLabels };
    expect((await app.handle(start(body))).status).toBe(200);
    expect(calls.pop()).toEqual({
      id: "updated",
      method: "host.sessions.start",
      params: body,
    });
    expect(calls).toEqual([]);
  }
});

test("rejects reserved-label launches on an old host without sending an RPC", async () => {
  const registry = new AgentRegistry();
  const calls: { id: string; method: string; params: unknown }[] = [];
  agent(registry, "old", [HOST_SESSIONS_FEATURE], undefined, calls);
  const app = hostSessionRoutes(registry);
  for (const reservedLabels of [["project.review"], []]) {
    expect(
      (
        await app.handle(
          start({ cwd: "/work/project", name: "review", reservedLabels }),
        )
      ).status,
    ).toBe(501);
    expect(calls).toEqual([]);
  }
  for (const reservedLabels of ["project.review", [42], ["bad label"]]) {
    expect(
      (
        await app.handle(
          start({ cwd: "/work/project", name: "review", reservedLabels }),
        )
      ).status,
    ).toBe(400);
    expect(calls).toEqual([]);
  }
  const body = { cwd: "/work/project", name: "review" };
  expect((await app.handle(start(body))).status).toBe(200);
  expect(calls).toEqual([
    { id: "old", method: "host.sessions.start", params: body },
  ]);
});

test("maps host permission and resume conflict errors to HTTP and rejects malformed launch requests", async () => {
  for (const [code, status] of [
    [-32003, 403],
    [-32002, 409],
    [-32001, 404],
  ] as const) {
    const registry = new AgentRegistry();
    agent(registry, "updated", [HOST_SESSIONS_FEATURE], {
      code,
      message: "Host refused launch",
    });
    const app = hostSessionRoutes(registry);
    expect(
      (
        await app.handle(
          start({ cwd: "/work/project", name: "", sessionId: "past-id" }),
        )
      ).status,
    ).toBe(status);
    for (const body of [
      null,
      [],
      {},
      { cwd: "/work", name: "bad;name" },
      { cwd: "/work", name: "ok", sessionId: "../../file" },
    ]) {
      expect((await app.handle(start(body))).status).toBe(400);
    }
  }
});

test("routes folder requests only to capable extensions", async () => {
  const registry = new AgentRegistry();
  const calls: { id: string; method: string; params: unknown }[] = [];
  const app = hostSessionRoutes(registry);
  expect((await app.handle(new Request(`${base}/folders`))).status).toBe(404);
  agent(registry, "old", [HOST_SESSIONS_FEATURE], undefined, calls);
  expect((await app.handle(new Request(`${base}/folders`))).status).toBe(501);
  agent(registry, "updated", [HOST_FOLDERS_FEATURE], undefined, calls);
  expect((await app.handle(new Request(`${base}/folders?path=${encodeURIComponent("~/work")}`))).status).toBe(200);
  expect((await app.handle(new Request(`${base}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "/work/new" }),
  }))).status).toBe(200);
  expect(calls).toEqual([
    { id: "updated", method: "host.folders.list", params: { path: "~/work" } },
    { id: "updated", method: "host.folders.mkdir", params: { path: "/work/new" } },
  ]);
});

test("validates folder creation and maps permission errors", async () => {
  const registry = new AgentRegistry();
  agent(registry, "updated", [HOST_FOLDERS_FEATURE], { code: -32003, message: "control required" });
  const app = hostSessionRoutes(registry);
  expect((await app.handle(new Request(`${base}/folders`))).status).toBe(403);
  expect((await app.handle(new Request(`${base}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "" }),
  }))).status).toBe(400);
});

test("folder requests have a separate bounded limit from session requests", async () => {
  const registry = new AgentRegistry();
  const calls: { id: string; method: string; params: unknown }[] = [];
  agent(registry, "updated", [HOST_FOLDERS_FEATURE, HOST_SESSIONS_FEATURE], undefined, calls);
  const app = hostSessionRoutes(registry);

  for (let i = 0; i < 60; i++) {
    expect((await app.handle(new Request(`${base}/folders?path=${i}`))).status).toBe(200);
  }
  const limitedFolder = await app.handle(new Request(`${base}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "/work/new" }),
  }));
  expect(limitedFolder.status).toBe(429);
  expect(limitedFolder.headers.get("retry-after")).toBe("1");
  expect(await limitedFolder.json()).toEqual({ error: "Rate limit: host folder requests (60 per 10s)" });

  expect((await app.handle(new Request(`${base}/session-history`))).status).toBe(200);
  expect((await app.handle(start({ cwd: "/work", name: "" }))).status).toBe(200);
  for (let i = 0; i < 18; i++) {
    expect((await app.handle(new Request(`${base}/session-history`))).status).toBe(200);
  }
  const limitedSession = await app.handle(start({ cwd: "/work", name: "" }));
  expect(limitedSession.status).toBe(429);
  expect(await limitedSession.json()).toEqual({ error: "Rate limit: host session requests (20 per 10s)" });
  expect(calls).toHaveLength(80);
});

test("session requests do not consume the folder request limit", async () => {
  const registry = new AgentRegistry();
  agent(registry, "updated", [HOST_FOLDERS_FEATURE, HOST_SESSIONS_FEATURE]);
  const app = hostSessionRoutes(registry);

  for (let i = 0; i < 20; i++) {
    expect((await app.handle(new Request(`${base}/session-history`))).status).toBe(200);
  }
  expect((await app.handle(new Request(`${base}/session-history`))).status).toBe(429);
  expect((await app.handle(new Request(`${base}/folders`))).status).toBe(200);
});
