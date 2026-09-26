import { describe, expect, test } from "bun:test";
import { type AgentConn, AgentRegistry } from "@/server/agent-registry";
import { collabRpcRoutes } from "@/server/collab-rpc-routes";

/** Registers a fake connected agent that answers collab.list/collab.link
 *  pushes, mimicking a real omp-connected extension's reply. */
function registerFakeAgent(registry: AgentRegistry, hostId: string): void {
  const conn: AgentConn = {
    send: (data) => {
      const frame = JSON.parse(data) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      // Reply on the next microtask, mimicking a real round trip.
      queueMicrotask(() => {
        if (frame.method === "collab.list") {
          // inst-1 is this agent's own session; "other" is a Collab session
          // on the same host with no registered omp-connected agent.
          registry.resolveHostCall(
            frame.id,
            { sessions: [{ instanceId: "inst-1" }, { instanceId: "other" }] },
            undefined,
          );
        } else if (frame.method === "collab.link") {
          registry.resolveHostCall(
            frame.id,
            {
              access: frame.params.access,
              url: "https://relay.example/r/room#key.token",
              expiresAt: Date.now() + 60_000,
            },
            undefined,
          );
        }
      });
    },
    close: () => {},
  };
  registry.register(
    {
      hostId,
      instanceId: "inst-1",
      pid: 111,
      cwd: "/x",
      label: "x.install",
      features: ["session.v1"],
    },
    conn,
  );
}

describe("collab-rpc-routes", () => {
  test("GET /:id/collab 404s for a host with no connected agent", async () => {
    const app = collabRpcRoutes(new AgentRegistry());
    const response = await app.handle(
      new Request("http://localhost/api/hosts/nobody/collab"),
    );
    expect(response.status).toBe(404);
  });

  test("GET / lists hostIds derived from currently connected agents", async () => {
    const registry = new AgentRegistry();
    registerFakeAgent(registry, "user@hub-host");
    const app = collabRpcRoutes(registry);
    const response = await app.handle(
      new Request("http://localhost/api/hosts/"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ hostId: "user@hub-host" }]);
  });

  test("GET /:id/collab relays the host's sessions, adding registered labels and features", async () => {
    const registry = new AgentRegistry();
    registerFakeAgent(registry, "user@hub-host");
    const app = collabRpcRoutes(registry);
    const response = await app.handle(
      new Request("http://localhost/api/hosts/user@hub-host/collab"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [
        { instanceId: "inst-1", label: "x.install", features: ["session.v1"] },
        { instanceId: "other", features: [] },
      ],
    });
  });

  test("POST /:id/collab/:instanceId/link rejects an invalid instance id before touching the host", async () => {
    const registry = new AgentRegistry();
    registerFakeAgent(registry, "user@hub-host");
    const app = collabRpcRoutes(registry);
    const response = await app.handle(
      new Request(
        "http://localhost/api/hosts/user@hub-host/collab/bad%20id/link",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: 1, access: "view" }),
        },
      ),
    );
    expect(response.status).toBe(400);
  });

  test("POST /:id/collab/:instanceId/link rejects a negative or non-integer generation", async () => {
    const registry = new AgentRegistry();
    registerFakeAgent(registry, "user@hub-host");
    const app = collabRpcRoutes(registry);
    const response = await app.handle(
      new Request(
        "http://localhost/api/hosts/user@hub-host/collab/room1/link",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: -1, access: "view" }),
        },
      ),
    );
    expect(response.status).toBe(400);
  });

  test("POST /:id/collab/:instanceId/link rejects an access value outside view|control", async () => {
    const registry = new AgentRegistry();
    registerFakeAgent(registry, "user@hub-host");
    const app = collabRpcRoutes(registry);
    const response = await app.handle(
      new Request(
        "http://localhost/api/hosts/user@hub-host/collab/room1/link",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: 1, access: "root" }),
        },
      ),
    );
    expect(response.status).toBe(400);
  });

  test("POST /:id/collab/:instanceId/link brokers a valid request end to end", async () => {
    const registry = new AgentRegistry();
    registerFakeAgent(registry, "user@hub-host");
    const app = collabRpcRoutes(registry);
    const response = await app.handle(
      new Request(
        "http://localhost/api/hosts/user@hub-host/collab/room1/link",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: 1, access: "view" }),
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access: string;
      url: string;
      expiresAt: number;
    };
    expect(body.access).toBe("view");
    expect(body.url).toContain("#key.token");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });
});
