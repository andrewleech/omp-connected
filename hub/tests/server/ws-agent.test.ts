import { afterEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "@/server/agent-registry";
import { dashboardEventsPlugin } from "@/server/dashboard-events";
import { type HostConn, HostRegistry } from "@/server/host-registry";
import type { DashboardEvent } from "@/server/types";
import { wsAgentPlugin } from "@/server/ws-agent";
import { Elysia } from "elysia";

const HOST_TOKEN = "test-token";

let stopServer: (() => void) | undefined;

afterEach(() => {
  stopServer?.();
  stopServer = undefined;
});

function start(
  agentRegistry: AgentRegistry,
  hostRegistry: HostRegistry,
): { url: string; dashboardUrl: string } {
  const app = new Elysia()
    .use(wsAgentPlugin(agentRegistry, hostRegistry, HOST_TOKEN))
    .use(dashboardEventsPlugin(hostRegistry, agentRegistry));
  app.listen(0);
  const port = app.server?.port;
  if (!port) throw new Error("server did not report a port");
  stopServer = () => app.stop();
  return {
    url: `ws://localhost:${port}/ws/agent`,
    dashboardUrl: `ws://localhost:${port}/ws/dashboard`,
  };
}

function waitOpen(socket: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.onopen = () => resolve();
  return promise;
}

interface Frame {
  jsonrpc?: string;
  id?: string;
  method?: string;
  params?: { content?: string; from?: string };
  result?: { ok?: boolean; recipientOnline?: boolean; agent?: unknown };
  error?: {
    code: number;
    message?: string;
    data?: { candidates: unknown[] };
  };
}

function waitForMessage<T = Frame>(socket: WebSocket): Promise<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  socket.onmessage = (event) => resolve(JSON.parse(String(event.data)) as T);
  return promise;
}

function collectFrames<T = Frame>(
  socket: WebSocket,
  count: number,
  timeoutMs = 2000,
): Promise<T[]> {
  const frames: T[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<T[]>();
  const timer = setTimeout(() => {
    reject(
      new Error(`timed out waiting for ${count} frames, got ${frames.length}`),
    );
  }, timeoutMs);
  socket.onmessage = (event) => {
    frames.push(JSON.parse(String(event.data)) as T);
    if (frames.length >= count) {
      clearTimeout(timer);
      resolve(frames);
    }
  };
  return promise;
}

interface FakeSession {
  instanceId: string;
  cwd: string;
}

/** Registers a fake omp-host sidecar connection that answers collab.list
 *  with a fixed session list, mimicking the real omp-host sidecar's
 *  round-trip reply. */
function registerFakeHost(
  hostRegistry: HostRegistry,
  hostId: string,
  sessions: FakeSession[],
): void {
  const conn: HostConn = {
    send: (data) => {
      const frame = JSON.parse(data) as { id: string; method: string };
      if (frame.method !== "collab.list") return;
      queueMicrotask(() => {
        hostRegistry.resolve(
          hostId,
          frame.id,
          {
            sessions: sessions.map((s) => ({
              instanceId: s.instanceId,
              generation: 0,
              access: "control" as const,
              pid: 111,
              sessionId: "s1",
              sessionName: null,
              cwd: s.cwd,
              model: null,
              startedAt: Date.now(),
              participants: 1,
              relayConnected: true,
              inputRequired: false,
            })),
          },
          undefined,
        );
      });
    },
    close: () => {},
  };
  hostRegistry.register(
    { hostId, user: "user", hostname: "hub-host", ompVersion: "1" },
    conn,
  );
}

function registerParams(
  overrides: Partial<{
    hostId: string;
    instanceId: string;
    pid: number;
    token: string;
  }> = {},
) {
  return {
    hostId: overrides.hostId ?? "user@hub-host",
    instanceId: overrides.instanceId ?? "inst-1",
    pid: overrides.pid ?? 4242,
    token: overrides.token ?? HOST_TOKEN,
  };
}

async function connectAndRegister(
  url: string,
  params: ReturnType<typeof registerParams>,
): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await waitOpen(socket);
  const reply = waitForMessage(socket);
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "reg",
      method: "agent.register",
      params,
    }),
  );
  const result = await reply;
  if (!result.result?.ok) {
    throw new Error(`registration failed: ${JSON.stringify(result)}`);
  }
  return socket;
}

describe("wsAgentPlugin — registration", () => {
  test("valid registration cross-validated against a live collab session succeeds", async () => {
    const agentRegistry = new AgentRegistry();
    const hostRegistry = new HostRegistry();
    registerFakeHost(hostRegistry, "user@hub-host", [
      { instanceId: "inst-1", cwd: "/home/user/api" },
    ]);
    const { url } = start(agentRegistry, hostRegistry);

    const socket = new WebSocket(url);
    await waitOpen(socket);
    const reply = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "agent.register",
        params: registerParams(),
      }),
    );

    const result = await reply;
    expect(result).toEqual({
      jsonrpc: "2.0",
      id: "1",
      result: {
        ok: true,
        agent: expect.objectContaining({
          id: "user@hub-host:inst-1",
          label: "api",
          cwd: "/home/user/api",
        }),
      },
    });
    expect(agentRegistry.listAgents()).toHaveLength(1);
    socket.close();
  });

  test("registration is rejected when instanceId isn't in the host's live collab.list", async () => {
    const agentRegistry = new AgentRegistry();
    const hostRegistry = new HostRegistry();
    registerFakeHost(hostRegistry, "user@hub-host", []); // no live sessions
    const { url } = start(agentRegistry, hostRegistry);

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
        method: "agent.register",
        params: registerParams(),
      }),
    );

    const result = await reply;
    expect(result.error?.code).toBe(-32003);
    await closed;
    expect(agentRegistry.listAgents()).toHaveLength(0);
  });

  test("an invalid host token is rejected with -32001 and the socket is closed", async () => {
    const agentRegistry = new AgentRegistry();
    const hostRegistry = new HostRegistry();
    registerFakeHost(hostRegistry, "user@hub-host", [
      { instanceId: "inst-1", cwd: "/x" },
    ]);
    const { url } = start(agentRegistry, hostRegistry);

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
        method: "agent.register",
        params: registerParams({ token: "wrong" }),
      }),
    );

    const result = await reply;
    expect(result.error?.code).toBe(-32001);
    await closed;
  });

  test("registering against a host that never connected is rejected with -32003", async () => {
    const agentRegistry = new AgentRegistry();
    const hostRegistry = new HostRegistry();
    const { url } = start(agentRegistry, hostRegistry);

    const socket = new WebSocket(url);
    await waitOpen(socket);
    const reply = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "agent.register",
        params: registerParams(),
      }),
    );

    const result = await reply;
    expect(result.error?.code).toBe(-32003);
  });

  test("any method sent before agent.register is rejected with -32002", async () => {
    const agentRegistry = new AgentRegistry();
    const hostRegistry = new HostRegistry();
    const { url } = start(agentRegistry, hostRegistry);

    const socket = new WebSocket(url);
    await waitOpen(socket);
    const reply = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "agent.list_agents",
        params: {},
      }),
    );

    const result = await reply;
    expect(result.error?.code).toBe(-32002);
  });
});

describe("wsAgentPlugin — message routing", () => {
  test("A sends to B by label; B acks; A's result reports recipientOnline", async () => {
    const agentRegistry = new AgentRegistry();
    const hostRegistry = new HostRegistry();
    registerFakeHost(hostRegistry, "user@hub-host", [
      { instanceId: "a", cwd: "/home/user/alpha" },
      { instanceId: "b", cwd: "/home/user/beta" },
    ]);
    const { url } = start(agentRegistry, hostRegistry);

    const socketA = await connectAndRegister(
      url,
      registerParams({ instanceId: "a" }),
    );
    const socketB = await connectAndRegister(
      url,
      registerParams({ instanceId: "b" }),
    );

    const bPush = waitForMessage(socketB);
    const aReply = waitForMessage(socketA);
    socketA.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "send1",
        method: "agent.send",
        params: { to: "beta", content: "hi", idempotencyKey: "k1" },
      }),
    );

    const pushFrame = await bPush;
    expect(pushFrame.method).toBe("agent.message");
    expect(pushFrame.params?.content).toBe("hi");
    expect(pushFrame.params?.from).toBe("user@hub-host:a");
    socketB.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pushFrame.id,
        result: { received: true },
      }),
    );

    const sendResult = await aReply;
    expect(sendResult.result?.recipientOnline).toBe(true);

    socketA.close();
    socketB.close();
  });

  test("a message sent while the recipient is offline is delivered on reconnect", async () => {
    const agentRegistry = new AgentRegistry();
    const hostRegistry = new HostRegistry();
    registerFakeHost(hostRegistry, "user@hub-host", [
      { instanceId: "a", cwd: "/home/user/alpha" },
      { instanceId: "b", cwd: "/home/user/beta" },
    ]);
    const { url } = start(agentRegistry, hostRegistry);

    const socketA = await connectAndRegister(
      url,
      registerParams({ instanceId: "a" }),
    );
    const socketB = await connectAndRegister(
      url,
      registerParams({ instanceId: "b" }),
    );
    const bClosed = new Promise<void>((resolve) => {
      socketB.onclose = () => resolve();
    });
    socketB.close();
    await bClosed;

    const aReply = waitForMessage(socketA);
    socketA.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "send1",
        method: "agent.send",
        params: { to: "beta", content: "queued", idempotencyKey: "k1" },
      }),
    );
    const sendResult = await aReply;
    expect(sendResult.result?.recipientOnline).toBe(false);

    const socketB2 = new WebSocket(url);
    await waitOpen(socketB2);
    const frames = collectFrames(socketB2, 2);
    socketB2.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reg2",
        method: "agent.register",
        params: registerParams({ instanceId: "b" }),
      }),
    );

    const [first, second] = await frames;
    const pushed = [first, second].find((f) => f?.method === "agent.message");
    expect(pushed?.params?.content).toBe("queued");

    socketA.close();
    socketB2.close();
  });

  test("sending to an ambiguous label returns -32010 with both candidates", async () => {
    const agentRegistry = new AgentRegistry();
    const hostRegistry = new HostRegistry();
    registerFakeHost(hostRegistry, "user@hub-host", [
      { instanceId: "a", cwd: "/home/user/api" },
    ]);
    registerFakeHost(hostRegistry, "user@worker-host", [
      { instanceId: "b", cwd: "/srv/api" },
    ]);
    const { url } = start(agentRegistry, hostRegistry);

    const socketA = await connectAndRegister(
      url,
      registerParams({ hostId: "user@hub-host", instanceId: "a" }),
    );
    await connectAndRegister(
      url,
      registerParams({ hostId: "user@worker-host", instanceId: "b" }),
    );

    const reply = waitForMessage(socketA);
    socketA.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "send1",
        method: "agent.send",
        params: { to: "api", content: "hi", idempotencyKey: "k1" },
      }),
    );

    const result = await reply;
    expect(result.error?.code).toBe(-32010);
    expect(result.error?.data?.candidates).toHaveLength(2);
  });
});

describe("wsAgentPlugin — dashboard events", () => {
  test("agent register/disconnect propagate to /ws/dashboard clients", async () => {
    const agentRegistry = new AgentRegistry();
    const hostRegistry = new HostRegistry();
    registerFakeHost(hostRegistry, "user@hub-host", [
      { instanceId: "inst-1", cwd: "/home/user/api" },
    ]);
    const { url, dashboardUrl } = start(agentRegistry, hostRegistry);

    const dashboard = new WebSocket(dashboardUrl);
    await waitOpen(dashboard);
    const frames = collectFrames<DashboardEvent>(dashboard, 2);

    const socket = await connectAndRegister(url, registerParams());
    const closed = new Promise<void>((resolve) => {
      socket.onclose = () => resolve();
    });
    socket.close();
    await closed;

    const [registered, disconnected] = await frames;
    expect(registered).toEqual({
      event: "agent.registered",
      agent: expect.objectContaining({ id: "user@hub-host:inst-1" }),
    });
    expect(disconnected).toEqual({
      event: "agent.disconnected",
      agentId: "user@hub-host:inst-1",
    });

    dashboard.close();
  });
});