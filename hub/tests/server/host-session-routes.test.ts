import { expect, test } from "bun:test";
import { AgentRegistry } from "@/server/agent-registry";
import { hostSessionRoutes } from "@/server/host-session-routes";
import { HOST_SESSIONS_FEATURE } from "@/server/types";

const base = "http://localhost/api/hosts/user@worker-host";
function agent(
  registry: AgentRegistry,
  id: string,
  features: string[],
  error?: { code: number; message: string },
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
