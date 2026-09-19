import { describe, expect, test } from "bun:test";
import { type HostConn, HostRegistry } from "@/server/host-registry";
import type { DashboardEvent } from "@/server/types";

function fakeConn(onSend?: (data: string) => void): HostConn {
  return { send: (data) => onSend?.(data), close: () => {} };
}

describe("HostRegistry", () => {
  test("register broadcasts host.connected and list() reflects it", () => {
    const registry = new HostRegistry();
    const events: DashboardEvent[] = [];
    registry.onChange((event) => events.push(event));

    const summary = registry.register(
      {
        hostId: "user@hub-host",
        user: "user",
        hostname: "hub-host",
        ompVersion: "18.1.22",
      },
      fakeConn(),
    );

    expect(summary.hostId).toBe("user@hub-host");
    expect(registry.get("user@hub-host")).toBe(true);
    expect(registry.list()).toEqual([summary]);
    expect(events).toEqual([{ event: "host.connected", host: summary }]);
  });

  test("a fresh registration for the same hostId closes and replaces the prior connection", () => {
    const registry = new HostRegistry();
    let firstClosed = false;
    const first: HostConn = {
      send: () => {},
      close: () => {
        firstClosed = true;
      },
    };
    registry.register(
      {
        hostId: "user@hub-host",
        user: "user",
        hostname: "hub-host",
        ompVersion: "1",
      },
      first,
    );
    registry.register(
      {
        hostId: "user@hub-host",
        user: "user",
        hostname: "hub-host",
        ompVersion: "2",
      },
      fakeConn(),
    );

    expect(firstClosed).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.ompVersion).toBe("2");
  });

  test("unregister only removes the matching connection identity and broadcasts host.disconnected", () => {
    const registry = new HostRegistry();
    const events: DashboardEvent[] = [];
    registry.onChange((event) => events.push(event));
    const conn = fakeConn();
    const staleConn = fakeConn();
    registry.register(
      {
        hostId: "user@hub-host",
        user: "user",
        hostname: "hub-host",
        ompVersion: "1",
      },
      conn,
    );

    registry.unregister("user@hub-host", staleConn); // stale identity — must not remove the live entry
    expect(registry.get("user@hub-host")).toBe(true);

    registry.unregister("user@hub-host", conn);
    expect(registry.get("user@hub-host")).toBe(false);
    expect(events.at(-1)).toEqual({
      event: "host.disconnected",
      hostId: "user@hub-host",
    });
  });

  test("call() resolves when the host replies via resolve() with the same id it was sent", async () => {
    const registry = new HostRegistry();
    let sentId = "";
    const conn = fakeConn((data) => {
      sentId = (JSON.parse(data) as { id: string }).id;
    });
    registry.register(
      {
        hostId: "user@hub-host",
        user: "user",
        hostname: "hub-host",
        ompVersion: "1",
      },
      conn,
    );

    const pending = registry.call("user@hub-host", "collab.list", {}, 1_000);
    // Give the send() callback a tick to run before resolving.
    await Promise.resolve();
    registry.resolve("user@hub-host", sentId, { sessions: [] }, undefined);

    expect(await pending).toEqual({ sessions: [] });
  });

  test("call() rejects on host RPC error and on timeout", async () => {
    const registry = new HostRegistry();
    let sentId = "";
    const conn = fakeConn((data) => {
      sentId = (JSON.parse(data) as { id: string }).id;
    });
    registry.register(
      {
        hostId: "user@hub-host",
        user: "user",
        hostname: "hub-host",
        ompVersion: "1",
      },
      conn,
    );

    const pending = registry.call("user@hub-host", "collab.list", {}, 1_000);
    await Promise.resolve();
    registry.resolve("user@hub-host", sentId, undefined, "boom");
    await expect(pending).rejects.toThrow("boom");

    await expect(
      registry.call("user@hub-host", "collab.list", {}, 5),
    ).rejects.toThrow(/timed out/);
  });

  test("call() rejects immediately for a host that never registered", async () => {
    const registry = new HostRegistry();
    await expect(
      registry.call("nobody@nowhere", "collab.list", {}, 1_000),
    ).rejects.toThrow(/not connected/);
  });

  test("disconnecting a host rejects its still-pending calls instead of hanging", async () => {
    const registry = new HostRegistry();
    const conn = fakeConn();
    registry.register(
      {
        hostId: "user@hub-host",
        user: "user",
        hostname: "hub-host",
        ompVersion: "1",
      },
      conn,
    );

    const pending = registry.call("user@hub-host", "collab.list", {}, 5_000);
    registry.unregister("user@hub-host", conn);

    await expect(pending).rejects.toThrow(/disconnected/);
  });
});