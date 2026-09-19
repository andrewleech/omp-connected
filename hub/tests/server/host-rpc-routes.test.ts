import { describe, expect, test } from "bun:test";
import { type HostConn, HostRegistry } from "@/server/host-registry";
import { hostRpcRoutes } from "@/server/host-rpc-routes";

function registerFakeHost(registry: HostRegistry, hostId: string): void {
  const conn: HostConn = {
    send: (data) => {
      const frame = JSON.parse(data) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      // Reply on the next microtask, mimicking a real host round-trip.
      queueMicrotask(() => {
        if (frame.method === "collab.list") {
          registry.resolve(hostId, frame.id, { sessions: [] }, undefined);
        } else if (frame.method === "collab.link") {
          registry.resolve(
            hostId,
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
    { hostId, user: "user", hostname: "hub-host", ompVersion: "1" },
    conn,
  );
}

describe("host-rpc-routes", () => {
  test("GET /:id/collab 404s for an unregistered host", async () => {
    const app = hostRpcRoutes(new HostRegistry());
    const response = await app.handle(
      new Request("http://localhost/api/hosts/nobody/collab"),
    );
    expect(response.status).toBe(404);
  });

  test("GET /:id/collab relays a registered host's session list", async () => {
    const registry = new HostRegistry();
    registerFakeHost(registry, "user@hub-host");
    const app = hostRpcRoutes(registry);
    const response = await app.handle(
      new Request("http://localhost/api/hosts/user@hub-host/collab"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: [] });
  });

  test("POST /:id/collab/:instanceId/link rejects an invalid instance id before touching the host", async () => {
    const registry = new HostRegistry();
    registerFakeHost(registry, "user@hub-host");
    const app = hostRpcRoutes(registry);
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
    const registry = new HostRegistry();
    registerFakeHost(registry, "user@hub-host");
    const app = hostRpcRoutes(registry);
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
    const registry = new HostRegistry();
    registerFakeHost(registry, "user@hub-host");
    const app = hostRpcRoutes(registry);
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
    const registry = new HostRegistry();
    registerFakeHost(registry, "user@hub-host");
    const app = hostRpcRoutes(registry);
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