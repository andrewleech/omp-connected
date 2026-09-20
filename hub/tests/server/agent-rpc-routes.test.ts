import { describe, expect, test } from "bun:test";
import { type AgentConn, AgentRegistry } from "@/server/agent-registry";
import { agentRpcRoutes } from "@/server/agent-rpc-routes";

const HUB_HOST = "hub-host";

function fakeConn(onSend?: (data: string) => void): AgentConn {
  return { send: (data) => onSend?.(data), close: () => {} };
}

function registerFakeAgent(
  registry: AgentRegistry,
  overrides: Partial<{ instanceId: string; cwd: string }> = {},
  conn: AgentConn = fakeConn(),
) {
  return registry.register(
    {
      hostId: "user@hub-host",
      instanceId: overrides.instanceId ?? "inst-1",
      pid: 4242,
      cwd: overrides.cwd ?? "/home/user/api",
    },
    conn,
  );
}

describe("agent-rpc-routes", () => {
  test("GET / returns the current roster", async () => {
    const registry = new AgentRegistry();
    registerFakeAgent(registry);
    const app = agentRpcRoutes(registry, HUB_HOST);

    const response = await app.handle(
      new Request("http://localhost/api/agents"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agents: unknown[] };
    expect(body.agents).toHaveLength(1);
  });

  test("POST /:id/send delivers a message tagged with the operator principal", async () => {
    const registry = new AgentRegistry();
    const pushed: string[] = [];
    registerFakeAgent(
      registry,
      {},
      fakeConn((d) => pushed.push(d)),
    );
    const app = agentRpcRoutes(registry, HUB_HOST);

    const response = await app.handle(
      new Request("http://localhost/api/agents/user@hub-host:inst-1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello", idempotencyKey: "k1" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      recipientOnline: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.recipientOnline).toBe(true);
    expect(pushed).toHaveLength(1);
    const frame = JSON.parse(pushed[0] ?? "{}");
    expect(frame.params.from).toBe(`operator@${HUB_HOST}`);
  });

  test("POST /:id/send to a nonexistent agent 404s", async () => {
    const registry = new AgentRegistry();
    const app = agentRpcRoutes(registry, HUB_HOST);

    const response = await app.handle(
      new Request("http://localhost/api/agents/nobody/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello", idempotencyKey: "k1" }),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("POST /:id/send with an ambiguous label 409s with candidates", async () => {
    const registry = new AgentRegistry();
    registerFakeAgent(registry, { instanceId: "a", cwd: "/home/x/api" });
    registerFakeAgent(registry, { instanceId: "b", cwd: "/home/y/api" });
    const app = agentRpcRoutes(registry, HUB_HOST);

    const response = await app.handle(
      new Request("http://localhost/api/agents/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello", idempotencyKey: "k1" }),
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(2);
  });

  test("POST /:id/send without content 400s", async () => {
    const registry = new AgentRegistry();
    registerFakeAgent(registry);
    const app = agentRpcRoutes(registry, HUB_HOST);

    const response = await app.handle(
      new Request("http://localhost/api/agents/user@hub-host:inst-1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "k1" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("the rate limiter 429s after the operator's send quota is exhausted", async () => {
    const registry = new AgentRegistry();
    registerFakeAgent(registry);
    const app = agentRpcRoutes(registry, HUB_HOST);

    let last: Response | undefined;
    for (let i = 0; i < 21; i++) {
      last = await app.handle(
        new Request("http://localhost/api/agents/user@hub-host:inst-1/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: `msg-${i}`,
            idempotencyKey: `k${i}`,
          }),
        }),
      );
    }
    expect(last?.status).toBe(429);
  });
});