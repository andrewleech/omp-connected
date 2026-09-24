import { afterEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "@/server/agent-registry";
import { dashboardEventsPlugin } from "@/server/dashboard-events";
import type { DashboardEvent } from "@/server/types";
import { wsAgentPlugin } from "@/server/ws-agent";
import { Elysia } from "elysia";

const HOST_TOKEN = "test-token";

let stopServer: (() => void) | undefined;

afterEach(() => {
  stopServer?.();
  stopServer = undefined;
});

function start(agentRegistry: AgentRegistry): {
  url: string;
  dashboardUrl: string;
} {
  const app = new Elysia()
    .use(wsAgentPlugin(agentRegistry, HOST_TOKEN))
    .use(dashboardEventsPlugin(agentRegistry));
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
  result?: {
    ok?: boolean;
    recipientOnline?: boolean;
    agent?: unknown;
    sessions?: unknown[];
  };
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

function fakeSession(overrides: Partial<{ instanceId: string }> = {}) {
  return {
    instanceId: overrides.instanceId ?? "inst-1",
    generation: 0,
    access: "control" as const,
    pid: 111,
    sessionId: "s1",
    sessionName: null,
    cwd: "/home/user/api",
    model: null,
    startedAt: Date.now(),
    participants: 1,
    relayConnected: true,
    inputRequired: false,
  };
}

function registerParams(
  overrides: Partial<{
    hostId: string;
    instanceId: string;
    pid: number;
    cwd: string;
    token: string;
    label: string;
  }> = {},
) {
  return {
    hostId: overrides.hostId ?? "user@hub-host",
    instanceId: overrides.instanceId ?? "inst-1",
    pid: overrides.pid ?? 4242,
    cwd: overrides.cwd ?? "/home/user/api",
    token: overrides.token ?? HOST_TOKEN,
    ...(overrides.label === undefined ? {} : { label: overrides.label }),
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
  test("a valid token registers the extension's own claimed hostId/instanceId/cwd", async () => {
    const agentRegistry = new AgentRegistry();
    const { url } = start(agentRegistry);

    const socket = new WebSocket(url);
    await waitOpen(socket);
    const reply = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "agent.register",
        params: registerParams({ cwd: "/home/user/api" }),
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

  test("an invalid host token is rejected with -32001 and the socket is closed", async () => {
    const agentRegistry = new AgentRegistry();
    const { url } = start(agentRegistry);

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

  test("registration missing cwd is rejected with -32602 and the socket is closed", async () => {
    const agentRegistry = new AgentRegistry();
    const { url } = start(agentRegistry);

    const socket = new WebSocket(url);
    await waitOpen(socket);
    const reply = waitForMessage(socket);
    const { promise: closed, resolve: onClosed } =
      Promise.withResolvers<void>();
    socket.onclose = () => onClosed();
    const { cwd: _omit, ...withoutCwd } = registerParams();
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "agent.register",
        params: withoutCwd,
      }),
    );

    const result = await reply;
    expect(result.error?.code).toBe(-32602);
    await closed;
    expect(agentRegistry.listAgents()).toHaveLength(0);
  });

  test("a reported ompc label replaces basename(cwd) and is addressable", async () => {
    const agentRegistry = new AgentRegistry();
    const { url } = start(agentRegistry);

    const socket = await connectAndRegister(
      url,
      registerParams({ cwd: "/home/user/api", label: "api.install" }),
    );

    expect(agentRegistry.listAgents()[0]?.label).toBe("api.install");
    expect(agentRegistry.resolve("api.install").kind).toBe("found");
    expect(agentRegistry.resolve("api").kind).toBe("not_found");
    socket.close();
  });

  test("a label that could pass for a canonical id is rejected with -32602", async () => {
    const agentRegistry = new AgentRegistry();
    const { url } = start(agentRegistry);

    const socket = new WebSocket(url);
    await waitOpen(socket);
    const reply = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "agent.register",
        params: registerParams({ label: "user@worker-host:inst-9" }),
      }),
    );

    const result = await reply;
    expect(result.error?.code).toBe(-32602);
    expect(agentRegistry.listAgents()).toHaveLength(0);
  });

  test("any method sent before agent.register is rejected with -32002", async () => {
    const agentRegistry = new AgentRegistry();
    const { url } = start(agentRegistry);

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
    const { url } = start(agentRegistry);

    const socketA = await connectAndRegister(
      url,
      registerParams({ instanceId: "a", cwd: "/home/user/alpha" }),
    );
    const socketB = await connectAndRegister(
      url,
      registerParams({ instanceId: "b", cwd: "/home/user/beta" }),
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
    const { url } = start(agentRegistry);

    const socketA = await connectAndRegister(
      url,
      registerParams({ instanceId: "a", cwd: "/home/user/alpha" }),
    );
    const socketB = await connectAndRegister(
      url,
      registerParams({ instanceId: "b", cwd: "/home/user/beta" }),
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
        params: registerParams({ instanceId: "b", cwd: "/home/user/beta" }),
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
    const { url } = start(agentRegistry);

    const socketA = await connectAndRegister(
      url,
      registerParams({
        hostId: "user@hub-host",
        instanceId: "a",
        cwd: "/home/user/api",
      }),
    );
    await connectAndRegister(
      url,
      registerParams({
        hostId: "user@worker-host",
        instanceId: "b",
        cwd: "/srv/api",
      }),
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

describe("wsAgentPlugin — host-level collab RPC forwarding", () => {
  test("callOnHost forwards to the connected agent's socket and resolves from its reply", async () => {
    const agentRegistry = new AgentRegistry();
    const { url } = start(agentRegistry);

    const socket = await connectAndRegister(
      url,
      registerParams({ hostId: "user@hub-host", instanceId: "inst-1" }),
    );
    const push = waitForMessage(socket);

    const callResult = agentRegistry.callOnHost(
      "user@hub-host",
      "collab.list",
      {},
      2000,
    );

    const pushFrame = await push;
    expect(pushFrame.method).toBe("collab.list");
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pushFrame.id,
        result: { sessions: [fakeSession({ instanceId: "inst-1" })] },
      }),
    );

    expect(await callResult).toEqual({
      sessions: [fakeSession({ instanceId: "inst-1" })],
    });
    socket.close();
  });

  test("callOnHost rejects when the agent replies with an error", async () => {
    const agentRegistry = new AgentRegistry();
    const { url } = start(agentRegistry);

    const socket = await connectAndRegister(
      url,
      registerParams({ hostId: "user@hub-host", instanceId: "inst-1" }),
    );
    const push = waitForMessage(socket);

    const callResult = agentRegistry.callOnHost(
      "user@hub-host",
      "collab.link",
      { instanceId: "inst-1", generation: 0, access: "view" },
      2000,
    );

    const pushFrame = await push;
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pushFrame.id,
        error: {
          code: -32000,
          message: "stale or invalid Collab link response",
        },
      }),
    );

    await expect(callResult).rejects.toThrow(
      "stale or invalid Collab link response",
    );
    socket.close();
  });

  test("callOnHost rejects immediately when no agent is connected for the host", async () => {
    const agentRegistry = new AgentRegistry();
    start(agentRegistry);

    await expect(
      agentRegistry.callOnHost("user@nowhere", "collab.list", {}, 2000),
    ).rejects.toThrow("no connected agent on host");
  });

  test("a collab-call reply is not mistaken for a message-delivery ack", async () => {
    const agentRegistry = new AgentRegistry();
    const { url } = start(agentRegistry);

    const socket = await connectAndRegister(
      url,
      registerParams({ hostId: "user@hub-host", instanceId: "inst-1" }),
    );
    const push = waitForMessage(socket);
    const callResult = agentRegistry.callOnHost(
      "user@hub-host",
      "collab.list",
      {},
      2000,
    );
    const pushFrame = await push;
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pushFrame.id,
        result: { sessions: [] },
      }),
    );
    await callResult;

    // The agent's mailbox is untouched by the collab-call reply above — it
    // was resolved as a host call, never reached ackMessage().
    agentRegistry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "hello",
      idempotencyKey: "k1",
    });
    expect(agentRegistry.getMailbox("user@hub-host:inst-1")).toHaveLength(1);
    socket.close();
  });
});

describe("wsAgentPlugin — dashboard events", () => {
  test("agent register/disconnect propagate to /ws/dashboard clients", async () => {
    const agentRegistry = new AgentRegistry();
    const { url, dashboardUrl } = start(agentRegistry);

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