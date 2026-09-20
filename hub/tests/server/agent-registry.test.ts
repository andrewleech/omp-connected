import { describe, expect, test } from "bun:test";
import {
  type AgentConn,
  AgentRegistry,
  AgentRegistryError,
} from "@/server/agent-registry";
import type { DashboardEvent } from "@/server/types";

function fakeConn(onSend?: (data: string) => void): AgentConn {
  return { send: (data) => onSend?.(data), close: () => {} };
}

function registerAgent(
  registry: AgentRegistry,
  overrides: Partial<{
    hostId: string;
    instanceId: string;
    pid: number;
    cwd: string;
  }> = {},
  conn: AgentConn = fakeConn(),
) {
  return registry.register(
    {
      hostId: overrides.hostId ?? "user@hub-host",
      instanceId: overrides.instanceId ?? "inst-1",
      pid: overrides.pid ?? 1234,
      cwd: overrides.cwd ?? "/home/user/api",
    },
    conn,
  );
}

describe("AgentRegistry — identity resolution", () => {
  test("register with an unambiguous label resolves by that label", () => {
    const registry = new AgentRegistry();
    const summary = registerAgent(registry);

    const resolved = registry.resolve("api");
    expect(resolved).toEqual({ kind: "found", agent: summary });
  });

  test("two agents sharing a label resolve ambiguously with both candidates", () => {
    const registry = new AgentRegistry();
    registerAgent(registry, {
      hostId: "user@hub-host",
      instanceId: "inst-1",
      cwd: "/home/user/api",
    });
    registerAgent(registry, {
      hostId: "user@worker-host",
      instanceId: "inst-2",
      cwd: "/srv/api",
    });

    const resolved = registry.resolve("api");
    expect(resolved.kind).toBe("ambiguous");
    if (resolved.kind !== "ambiguous") throw new Error("unreachable");
    expect(resolved.data.address).toBe("api");
    expect(resolved.data.candidates).toEqual(
      expect.arrayContaining([
        { id: "user@hub-host:inst-1", cwd: "/home/user/api" },
        { id: "user@worker-host:inst-2", cwd: "/srv/api" },
      ]),
    );
    expect(resolved.data.candidates).toHaveLength(2);
  });

  test("canonical id always resolves regardless of label collisions", () => {
    const registry = new AgentRegistry();
    registerAgent(registry, {
      hostId: "user@hub-host",
      instanceId: "inst-1",
      cwd: "/home/user/api",
    });
    registerAgent(registry, {
      hostId: "user@worker-host",
      instanceId: "inst-2",
      cwd: "/srv/api",
    });

    const resolved = registry.resolve("user@hub-host:inst-1");
    expect(resolved.kind).toBe("found");
    if (resolved.kind !== "found") throw new Error("unreachable");
    expect(resolved.agent.id).toBe("user@hub-host:inst-1");
  });

  test("resolving a nonexistent address returns not_found", () => {
    const registry = new AgentRegistry();
    expect(registry.resolve("nothing-here")).toEqual({ kind: "not_found" });
  });
});

describe("AgentRegistry — registration", () => {
  test("register returns a server-derived AgentSummary", () => {
    const registry = new AgentRegistry();
    const summary = registerAgent(registry, {
      hostId: "user@hub-host",
      instanceId: "inst-1",
      pid: 4242,
      cwd: "/home/user/projects/api",
    });

    expect(summary).toEqual({
      id: "user@hub-host:inst-1",
      hostId: "user@hub-host",
      instanceId: "inst-1",
      label: "api",
      cwd: "/home/user/projects/api",
      pid: 4242,
      connectedAt: summary.connectedAt,
      teams: [],
    });
  });

  test("re-registering the same canonical id closes and replaces the prior connection", () => {
    const registry = new AgentRegistry();
    let firstClosed = false;
    const first: AgentConn = {
      send: () => {},
      close: () => {
        firstClosed = true;
      },
    };
    registerAgent(registry, {}, first);
    registerAgent(registry, { pid: 9999 });

    expect(firstClosed).toBe(true);
    expect(registry.listAgents()).toHaveLength(1);
    expect(registry.listAgents()[0]?.pid).toBe(9999);
  });

  test("registering under the reserved operator@ hostId namespace is rejected", () => {
    const registry = new AgentRegistry();
    expect(() =>
      registerAgent(registry, { hostId: "operator@hub-host" }),
    ).toThrow(AgentRegistryError);
    try {
      registerAgent(registry, { hostId: "operator@hub-host" });
    } catch (err) {
      expect((err as AgentRegistryError).code).toBe(-32004);
    }
    expect(registry.listAgents()).toHaveLength(0);
  });

  test("unregister removes the agent from the roster and fires agent.disconnected", () => {
    const registry = new AgentRegistry();
    const events: DashboardEvent[] = [];
    registry.onChange((event) => events.push(event));
    const conn = fakeConn();
    registerAgent(registry, {}, conn);
    events.length = 0;

    registry.unregister("user@hub-host:inst-1", conn);

    expect(registry.listAgents()).toHaveLength(0);
    expect(events).toEqual([
      { event: "agent.disconnected", agentId: "user@hub-host:inst-1" },
    ]);
  });

  test("unregister with a stale connection (already replaced) is a no-op", () => {
    const registry = new AgentRegistry();
    const stale = fakeConn();
    registerAgent(registry, {}, stale);
    registerAgent(registry, {}); // replaces with a new connection

    registry.unregister("user@hub-host:inst-1", stale);

    expect(registry.listAgents()).toHaveLength(1);
  });
});

describe("AgentRegistry — mailbox", () => {
  test("sending to an online agent delivers via conn.send() as a JSON-RPC push", () => {
    const registry = new AgentRegistry();
    const pushed: string[] = [];
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "inst-1" },
      fakeConn((data) => pushed.push(data)),
    );

    const result = registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "hello",
      idempotencyKey: "k1",
    });

    expect(result.recipientOnline).toBe(true);
    expect(pushed).toHaveLength(1);
    const frame = JSON.parse(pushed[0] ?? "{}");
    expect(frame).toMatchObject({
      jsonrpc: "2.0",
      id: result.messageId,
      method: "agent.message",
      params: { from: "operator@hub-host", content: "hello" },
    });
  });

  test("sending to an offline agent queues the message in its mailbox", () => {
    const registry = new AgentRegistry();
    const conn = fakeConn();
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "inst-1" },
      conn,
    );
    registry.unregister("user@hub-host:inst-1", conn);

    const result = registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "queued",
      idempotencyKey: "k2",
    });

    expect(result.recipientOnline).toBe(false);
    expect(registry.getMailbox("user@hub-host:inst-1")).toEqual([
      expect.objectContaining({ content: "queued" }),
    ]);
  });

  test("getMailbox returns messages oldest-first without draining", () => {
    const registry = new AgentRegistry();
    const conn = fakeConn();
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "inst-1" },
      conn,
    );
    registry.unregister("user@hub-host:inst-1", conn);

    registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "first",
      idempotencyKey: "k1",
    });
    registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "second",
      idempotencyKey: "k2",
    });

    const mailbox = registry.getMailbox("user@hub-host:inst-1");
    expect(mailbox.map((m) => m.content)).toEqual(["first", "second"]);
    // Not drained.
    expect(registry.getMailbox("user@hub-host:inst-1")).toHaveLength(2);
  });

  test("ackMessage removes only the acked message from the mailbox", () => {
    const registry = new AgentRegistry();
    const conn = fakeConn();
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "inst-1" },
      conn,
    );
    registry.unregister("user@hub-host:inst-1", conn);

    const first = registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "first",
      idempotencyKey: "k1",
    });
    registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "second",
      idempotencyKey: "k2",
    });

    registry.ackMessage("user@hub-host:inst-1", first.messageId);

    const mailbox = registry.getMailbox("user@hub-host:inst-1");
    expect(mailbox.map((m) => m.content)).toEqual(["second"]);
  });

  test("a disconnected agent's entry and mailbox are purged after the TTL", () => {
    let now = 1_000_000;
    const registry = new AgentRegistry({
      now: () => now,
      disconnectedTtlMs: 5000,
    });
    const conn = fakeConn();
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "inst-1" },
      conn,
    );
    registry.unregister("user@hub-host:inst-1", conn);

    now += 5001;
    // Any registry call sweeps expired entries lazily.
    expect(registry.resolve("user@hub-host:inst-1")).toEqual({
      kind: "not_found",
    });
  });

  test("sending to an agent purged past its TTL returns not_found", () => {
    let now = 1_000_000;
    const registry = new AgentRegistry({
      now: () => now,
      disconnectedTtlMs: 5000,
    });
    const conn = fakeConn();
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "inst-1" },
      conn,
    );
    registry.unregister("user@hub-host:inst-1", conn);
    now += 5001;

    expect(() =>
      registry.send({
        from: "operator@hub-host",
        to: "user@hub-host:inst-1",
        content: "too late",
        idempotencyKey: "k1",
      }),
    ).toThrow(/not found/);
  });

  test("reconnecting within the TTL redelivers the queued mailbox", () => {
    const registry = new AgentRegistry({ disconnectedTtlMs: 5000 });
    const firstConn = fakeConn();
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "inst-1" },
      firstConn,
    );
    registry.unregister("user@hub-host:inst-1", firstConn);
    registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "while offline",
      idempotencyKey: "k1",
    });

    const pushed: string[] = [];
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "inst-1" },
      fakeConn((data) => pushed.push(data)),
    );

    expect(pushed).toHaveLength(1);
    const frame = JSON.parse(pushed[0] ?? "{}");
    expect(frame.params.content).toBe("while offline");
    // Still in the mailbox until acked.
    expect(registry.getMailbox("user@hub-host:inst-1")).toHaveLength(1);
  });
});

describe("AgentRegistry — idempotency", () => {
  test("retrying the same idempotency key with identical fields returns the original result without duplicating the message", () => {
    const registry = new AgentRegistry();
    const conn = fakeConn();
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "inst-1" },
      conn,
    );

    const first = registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "hello",
      idempotencyKey: "same-key",
    });
    const retry = registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "hello",
      idempotencyKey: "same-key",
    });

    expect(retry).toEqual(first);
    expect(registry.getMailbox("user@hub-host:inst-1")).toHaveLength(1);
  });

  test("reusing an idempotency key with different fields is an error", () => {
    const registry = new AgentRegistry();
    registerAgent(registry, { hostId: "user@hub-host", instanceId: "inst-1" });

    registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "hello",
      idempotencyKey: "same-key",
    });

    expect(() =>
      registry.send({
        from: "operator@hub-host",
        to: "user@hub-host:inst-1",
        content: "different content",
        idempotencyKey: "same-key",
      }),
    ).toThrow(AgentRegistryError);
    try {
      registry.send({
        from: "operator@hub-host",
        to: "user@hub-host:inst-1",
        content: "different content",
        idempotencyKey: "same-key",
      });
    } catch (err) {
      expect((err as AgentRegistryError).code).toBe(-32012);
    }
  });
});

describe("AgentRegistry — teams", () => {
  test("joinTeam creates the team on first join", () => {
    const registry = new AgentRegistry();
    registerAgent(registry, { hostId: "user@hub-host", instanceId: "inst-1" });

    const result = registry.joinTeam("user@hub-host:inst-1", "eng");

    expect(result.team).toEqual({
      name: "eng",
      members: [{ id: "user@hub-host:inst-1", label: "api", status: "online" }],
    });
    expect(registry.listTeams()).toEqual([result.team]);
  });

  test("leaveTeam deletes the team once the last member leaves", () => {
    const registry = new AgentRegistry();
    registerAgent(registry, { hostId: "user@hub-host", instanceId: "inst-1" });
    registry.joinTeam("user@hub-host:inst-1", "eng");

    const result = registry.leaveTeam("user@hub-host:inst-1", "eng");

    expect(result).toEqual({
      ok: true,
      team: "eng",
      deleted: true,
      remainingMembers: [],
    });
    expect(registry.listTeams()).toEqual([]);
  });

  test("sendTeam delivers to every member except the sender", () => {
    const registry = new AgentRegistry();
    const pushedA: string[] = [];
    const pushedB: string[] = [];
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "a", cwd: "/a" },
      fakeConn((d) => pushedA.push(d)),
    );
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "b", cwd: "/b" },
      fakeConn((d) => pushedB.push(d)),
    );
    registry.joinTeam("user@hub-host:a", "eng");
    registry.joinTeam("user@hub-host:b", "eng");

    const result = registry.sendTeam({
      from: "user@hub-host:a",
      team: "eng",
      content: "standup",
      idempotencyKey: "k1",
    });

    expect(result.recipientCount).toBe(1);
    expect(result.onlineRecipientCount).toBe(1);
    expect(pushedA).toHaveLength(0); // sender excluded
    expect(pushedB).toHaveLength(1);
  });

  test("team members report correct online/offline status", () => {
    const registry = new AgentRegistry();
    const connA = fakeConn();
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "a", cwd: "/a" },
      connA,
    );
    registerAgent(registry, {
      hostId: "user@hub-host",
      instanceId: "b",
      cwd: "/b",
    });
    registry.joinTeam("user@hub-host:a", "eng");
    registry.joinTeam("user@hub-host:b", "eng");
    registry.unregister("user@hub-host:a", connA);

    const summary = registry.leaveTeam("user@hub-host:b", "eng");
    // leaveTeam's remainingMembers reflects who's left (agent a, offline).
    expect(summary.remainingMembers).toEqual([
      { id: "user@hub-host:a", label: "a", status: "offline" },
    ]);
  });
});

describe("AgentRegistry — events", () => {
  test("register, disconnect, send, and team operations each log an event", () => {
    const registry = new AgentRegistry();
    const conn = fakeConn();
    registerAgent(
      registry,
      { hostId: "user@hub-host", instanceId: "inst-1" },
      conn,
    );
    registry.send({
      from: "operator@hub-host",
      to: "user@hub-host:inst-1",
      content: "hi",
      idempotencyKey: "k1",
    });
    registry.joinTeam("user@hub-host:inst-1", "eng");
    registry.leaveTeam("user@hub-host:inst-1", "eng");
    registry.unregister("user@hub-host:inst-1", conn);

    const { events } = registry.queryEvents();
    expect(events.map((e) => e.event)).toEqual([
      "agent.registered",
      "message.sent",
      "team.joined",
      "team.left",
      "agent.disconnected",
    ]);
  });

  test("queryEvents filters by event prefix, since, agent, and limit", () => {
    let now = 0;
    const registry = new AgentRegistry({ now: () => now });
    registerAgent(registry, {
      hostId: "user@hub-host",
      instanceId: "a",
      cwd: "/a",
    });
    now = 10;
    registerAgent(registry, {
      hostId: "user@hub-host",
      instanceId: "b",
      cwd: "/b",
    });
    now = 20;
    registry.joinTeam("user@hub-host:a", "eng");

    expect(
      registry.queryEvents({ event: "agent." }).events.map((e) => e.event),
    ).toEqual(["agent.registered", "agent.registered"]);
    expect(registry.queryEvents({ since: 10 }).count).toBe(1);
    expect(
      registry
        .queryEvents({ agent: "user@hub-host:a" })
        .events.map((e) => e.event),
    ).toEqual(["agent.registered", "team.joined"]);
    expect(registry.queryEvents({ limit: 1 }).events).toHaveLength(1);
  });

  test("the event log is bounded and drops the oldest entries once over capacity", () => {
    const registry = new AgentRegistry();
    registerAgent(registry, { hostId: "user@hub-host", instanceId: "inst-1" });
    for (let i = 0; i < 501; i++) {
      registry.joinTeam("user@hub-host:inst-1", `team-${i}`);
      registry.leaveTeam("user@hub-host:inst-1", `team-${i}`);
    }

    // 1 register + 501*2 join/leave = 1003 events, capped to 1000.
    expect(registry.queryEvents().count).toBe(1000);
  });
});

describe("AgentRegistry — dashboard events", () => {
  test("agent.registered is pushed to onChange on register", () => {
    const registry = new AgentRegistry();
    const events: DashboardEvent[] = [];
    registry.onChange((event) => events.push(event));

    const summary = registerAgent(registry);

    expect(events).toEqual([{ event: "agent.registered", agent: summary }]);
  });

  test("agent.disconnected is pushed to onChange on unregister", () => {
    const registry = new AgentRegistry();
    const conn = fakeConn();
    registerAgent(registry, {}, conn);
    const events: DashboardEvent[] = [];
    registry.onChange((event) => events.push(event));

    registry.unregister("user@hub-host:inst-1", conn);

    expect(events).toEqual([
      { event: "agent.disconnected", agentId: "user@hub-host:inst-1" },
    ]);
  });
});