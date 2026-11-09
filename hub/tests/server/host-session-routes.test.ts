import { expect, test } from "bun:test";
import { AgentRegistry } from "@/server/agent-registry";
import { hostSessionRoutes } from "@/server/host-session-routes";
import {
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
