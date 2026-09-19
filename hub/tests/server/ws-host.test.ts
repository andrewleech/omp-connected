import { afterEach, describe, expect, test } from "bun:test";
import { HostRegistry } from "@/server/host-registry";
import type { DashboardEvent } from "@/server/types";
import { wsHostPlugin } from "@/server/ws-host";
import { Elysia } from "elysia";

const HOST_TOKEN = "test-token";

let stopServer: (() => void) | undefined;

afterEach(() => {
  stopServer?.();
  stopServer = undefined;
});

function start(registry: HostRegistry): { url: string } {
  const app = new Elysia().use(wsHostPlugin(registry, HOST_TOKEN));
  app.listen(0);
  const port = app.server?.port;
  if (!port) throw new Error("server did not report a port");
  stopServer = () => app.stop();
  return { url: `ws://localhost:${port}/ws/host` };
}

function waitOpen(socket: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.onopen = () => resolve();
  return promise;
}

/** Resolves once `events` has accumulated at least `count` entries — driven
 *  by the actual registry callback, not a guessed sleep duration. */
function waitForEventCount(
  registry: HostRegistry,
  events: DashboardEvent[],
  count: number,
): Promise<void> {
  if (events.length >= count) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  registry.onChange((event) => {
    events.push(event);
    if (events.length >= count) resolve();
  });
  return promise;
}

function waitForMessage(socket: WebSocket): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  socket.onmessage = (event) => resolve(JSON.parse(String(event.data)));
  return promise;
}

describe("wsHostPlugin", () => {
  test("register then disconnect: the registry actually forgets the host", async () => {
    const registry = new HostRegistry();
    const events: DashboardEvent[] = [];
    const gotBoth = waitForEventCount(registry, events, 2);
    const { url } = start(registry);

    const socket = new WebSocket(url);
    await waitOpen(socket);
    const registerReply = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "host.register",
        params: {
          hostId: "user@hub-host",
          user: "user",
          hostname: "hub-host",
          ompVersion: "1",
          token: HOST_TOKEN,
        },
      }),
    );
    expect(await registerReply).toEqual({
      jsonrpc: "2.0",
      id: "1",
      result: { ok: true, hostId: "user@hub-host" },
    });
    expect(registry.get("user@hub-host")).toBe(true);

    socket.close();
    await gotBoth;

    // Regression: an earlier version constructed a fresh HostConn object at
    // register time and another fresh one at close time, so HostRegistry's
    // identity check (`entry.conn !== conn`) never matched and unregister
    // silently no-opped — the host stayed listed forever after disconnect.
    expect(registry.get("user@hub-host")).toBe(false);
    expect(events).toEqual([
      {
        event: "host.connected",
        host: expect.objectContaining({ hostId: "user@hub-host" }),
      },
      { event: "host.disconnected", hostId: "user@hub-host" },
    ]);
  });

  test("an invalid host token is rejected and the socket is closed", async () => {
    const registry = new HostRegistry();
    const { url } = start(registry);
    const socket = new WebSocket(url);
    await waitOpen(socket);
    const reply = waitForMessage(socket);
    const { promise: closed, resolve: onClosed } =
      Promise.withResolvers<void>();
    socket.onclose = () => onClosed();
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "host.register",
        params: {
          hostId: "user@hub-host",
          user: "user",
          hostname: "hub-host",
          ompVersion: "1",
          token: "wrong",
        },
      }),
    );

    expect(await reply).toEqual({
      jsonrpc: "2.0",
      id: "1",
      error: { code: -32001, message: "invalid host token" },
    });
    await closed;
    expect(registry.get("user@hub-host")).toBe(false);
  });
});