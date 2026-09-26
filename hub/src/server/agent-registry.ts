// Registry of connected agent-messaging sessions — individual OMP sessions
// that opted into agent-to-agent messaging via the omp-connected extension.
//
// Also the only channel host-level Collab discovery has: there is no
// separate host-registration connection. `callOnHost()` forwards
// collab.list/collab.link to whichever agent connection is currently live
// for a given hostId (any one — the answer is host-wide, not
// session-specific) and the extension answers it directly against
// `@oh-my-pi/pi-coding-agent`'s own Collab registry. A host with zero
// connected agents cannot answer these calls and does not appear in
// listHostIds() — there is nothing else on that host to ask.
//
// `register()` takes `cwd` as the extension's own claim: there is no
// independent process to confirm it against, so this registry does not
// try to.
//
// `callOnAgent()` addresses one specific agent connection instead: the
// session.* / files.* methods act on that session's own omp process.

import { basename } from "node:path";
import {
  AGENT_RPC_ERRORS,
  type AgentAddressAmbiguousErrorData,
  type AgentHubEvent,
  type AgentJoinTeamResult,
  type AgentLeaveTeamResult,
  type AgentMessage,
  type AgentMessageType,
  type AgentQueryEventsResult,
  type AgentSendResult,
  type AgentSendTeamResult,
  type AgentSummary,
  type AgentTeamMember,
  type AgentTeamSummary,
  type CollabMethod,
  type CollabMethodParams,
  type CollabMethodResult,
  type DashboardEvent,
  type JsonRpcRequest,
  type SessionMethod,
  type SessionMethodParams,
  type SessionMethodResult,
} from "./types";

export interface AgentConn {
  send(data: string): void;
  close(): void;
}

/** `operator@<hub-host>` is the reserved principal the dashboard uses as
 *  `from` when it sends a message (see agent-rpc-routes.ts, Phase 8B). No
 *  extension may register a hostId under that namespace. */
const RESERVED_HOST_ID_RE = /^operator@/;

export function isReservedAgentHostId(hostId: string): boolean {
  return RESERVED_HOST_ID_RE.test(hostId);
}

/** How long a disconnected agent's entry (and its queued mailbox) survives
 *  before being purged. Long enough to ride out a reconnect (network blip,
 *  extension reload) without losing queued messages; short enough that a
 *  genuinely dead session doesn't linger forever. */
const DEFAULT_DISCONNECTED_TTL_MS = 5 * 60 * 1000;

/** Bounded event log capacity. Metadata only (no message bodies), so this
 *  can afford to be generous. */
const EVENTS_CAPACITY = 1000;

export class AgentRegistryError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Why a server-initiated call on an agent connection failed. `remote`
 *  carries the extension's JSON-RPC error `code`; the others are local
 *  (no reply in time, or the connection went away / could not be written). */
export type AgentCallFailure = "remote" | "timeout" | "disconnected";

export class AgentCallError extends Error {
  constructor(
    message: string,
    public readonly kind: AgentCallFailure,
    /** The extension's JSON-RPC error code; only set when `kind` is
     *  "remote" and the reply carried a numeric code. */
    public readonly code?: number,
  ) {
    super(message);
  }
}

/** The error half of a JSON-RPC reply, as relayed by the ws-agent layer. */
export interface AgentCallErrorReply {
  code?: number;
  message: string;
}

interface AgentEntry {
  id: string;
  hostId: string;
  instanceId: string;
  label: string;
  cwd: string;
  pid: number;
  features: string[];
  connectedAt: Date;
  /** undefined while disconnected-but-within-TTL. */
  conn: AgentConn | undefined;
  disconnectedAt: number | undefined;
  teams: Set<string>;
  /** FIFO, unbounded. Rate limiting (at the ws-agent layer) bounds input
   *  rate; TTL purge of the owning entry bounds long-term accumulation. */
  mailbox: AgentMessage[];
}

interface PendingHostCall {
  resolve(result: unknown): void;
  reject(error: AgentCallError): void;
  timer: ReturnType<typeof setTimeout>;
  /** Canonical id of the agent connection this call is outstanding
   *  against, so unregister() can reject it if that specific connection
   *  drops before replying. */
  agentId: string;
}

type ResolvedEntry =
  | { kind: "found"; entry: AgentEntry }
  | { kind: "ambiguous"; data: AgentAddressAmbiguousErrorData }
  | { kind: "not_found" };

export type AgentResolution =
  | { kind: "found"; agent: AgentSummary }
  | { kind: "ambiguous"; data: AgentAddressAmbiguousErrorData }
  | { kind: "not_found" };

interface IdempotencyEntry {
  /** JSON-stable fingerprint of the request fields, to detect key reuse
   *  with different content. */
  fingerprint: string;
  result: AgentSendResult | AgentSendTeamResult;
}

export interface AgentRegistryOptions {
  /** Clock override for tests. Defaults to Date.now. */
  now?: () => number;
  /** TTL override for tests, so a purge test doesn't wait 5 real minutes. */
  disconnectedTtlMs?: number;
}

export class AgentRegistry {
  private agents = new Map<string, AgentEntry>();
  private events: AgentHubEvent[] = [];
  private nextMessageId = 1;
  private idempotency = new Map<string, IdempotencyEntry>();
  private onChangeFn: (event: DashboardEvent) => void = () => {};
  private readonly now: () => number;
  private readonly disconnectedTtlMs: number;
  private pendingHostCalls = new Map<string, PendingHostCall>();

  constructor(options: AgentRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.disconnectedTtlMs =
      options.disconnectedTtlMs ?? DEFAULT_DISCONNECTED_TTL_MS;
  }

  onChange(fn: (event: DashboardEvent) => void): void {
    this.onChangeFn = fn;
  }

  /** Registers an agent, replacing (and closing) any prior live connection
   *  for the same canonical identity, or reclaiming a disconnected-but-
   *  not-yet-purged entry (preserving and redelivering its queued
   *  mailbox). Rejects the reserved `operator@*` hostId namespace. */
  register(
    params: {
      hostId: string;
      instanceId: string;
      pid: number;
      cwd: string;
      label?: string;
      features?: string[];
    },
    conn: AgentConn,
  ): AgentSummary {
    this.pruneExpired();
    if (isReservedAgentHostId(params.hostId)) {
      throw new AgentRegistryError(
        AGENT_RPC_ERRORS.reservedIdentity,
        `hostId '${params.hostId}' is reserved for the dashboard operator principal`,
      );
    }
    const id = `${params.hostId}:${params.instanceId}`;
    const existing = this.agents.get(id);
    if (existing?.conn) {
      try {
        existing.conn.close();
      } catch {
        // already closing
      }
      // The replaced socket is closing and its unregister() will be a
      // no-op (it no longer owns the entry), so fail its calls now.
      this.rejectPendingHostCallsFor(id);
    }
    const entry: AgentEntry = {
      id,
      hostId: params.hostId,
      instanceId: params.instanceId,
      label: params.label ?? basename(params.cwd),
      cwd: params.cwd,
      pid: params.pid,
      features: [...(params.features ?? [])],
      connectedAt: new Date(this.now()),
      conn,
      disconnectedAt: undefined,
      teams: existing?.teams ?? new Set(),
      mailbox: existing?.mailbox ?? [],
    };
    this.agents.set(id, entry);
    for (const queued of entry.mailbox) this.pushToRecipient(entry, queued);
    const summary = this.toSummary(entry);
    this.recordEvent("agent.registered", {
      agentId: id,
      label: entry.label,
      hostId: entry.hostId,
    });
    this.onChangeFn({ event: "agent.registered", agent: summary });
    return summary;
  }

  /** Marks an agent's live connection gone. The entry (and its mailbox) is
   *  retained for `disconnectedTtlMs` to survive a reconnect race; it drops
   *  out of `listAgents()` immediately. Idempotent — a stale `conn` (e.g.
   *  from a socket that already lost a re-registration race) is a no-op. */
  unregister(id: string, conn: AgentConn): void {
    const entry = this.agents.get(id);
    if (!entry || entry.conn !== conn) return;
    entry.conn = undefined;
    entry.disconnectedAt = this.now();
    this.rejectPendingHostCallsFor(id);
    this.recordEvent("agent.disconnected", { agentId: id });
    this.onChangeFn({ event: "agent.disconnected", agentId: id });
  }

  /** Currently connected agents only — same "live only" contract as
   *  listAgents(). A hostId with zero live agents has nothing that can
   *  answer collab.list/collab.link, so it does not appear here. */
  listHostIds(): string[] {
    this.pruneExpired();
    const ids = new Set<string>();
    for (const entry of this.agents.values()) {
      if (entry.conn !== undefined) ids.add(entry.hostId);
    }
    return [...ids].sort();
  }

  /** Forwards a Collab RPC to one currently-connected agent on `hostId` and
   *  awaits its JSON-RPC reply. The answer is host-wide (Collab session
   *  state, not agent-messaging state), so any live connection can answer;
   *  the longest-connected one is asked, because an agent that keeps
   *  reconnecting always has a fresh `connectedAt` and would otherwise drop
   *  every call routed to it. */
  async callOnHost<M extends CollabMethod>(
    hostId: string,
    method: M,
    params: CollabMethodParams[M],
    timeoutMs: number,
  ): Promise<CollabMethodResult[M]> {
    this.pruneExpired();
    let entry: AgentEntry | undefined;
    for (const candidate of this.agents.values()) {
      if (candidate.hostId !== hostId || candidate.conn === undefined) continue;
      if (!entry || candidate.connectedAt < entry.connectedAt)
        entry = candidate;
    }
    const conn = entry?.conn;
    if (!entry || !conn)
      throw new AgentCallError(
        `no connected agent on host '${hostId}'`,
        "disconnected",
      );
    return this.callOnConn(entry.id, conn, method, params, timeoutMs);
  }

  /** Sends a session.* / files.* request to the live connection of one
   *  specific agent and awaits its reply. Rejects with an AgentCallError:
   *  `remote` (with the extension's code) on an error reply, `timeout`
   *  after `timeoutMs`, `disconnected` if the agent is not live or its
   *  connection drops or is replaced before replying. */
  async callOnAgent<M extends SessionMethod>(
    agentId: string,
    method: M,
    params: SessionMethodParams[M],
    timeoutMs: number,
  ): Promise<SessionMethodResult[M]> {
    const conn = this.agents.get(agentId)?.conn;
    if (!conn)
      throw new AgentCallError(
        `agent '${agentId}' is not connected`,
        "disconnected",
      );
    return this.callOnConn(agentId, conn, method, params, timeoutMs);
  }

  private callOnConn<R>(
    agentId: string,
    conn: AgentConn,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<R> {
    const id = crypto.randomUUID();
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHostCalls.delete(id);
        reject(new AgentCallError(`agent RPC ${method} timed out`, "timeout"));
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.pendingHostCalls.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
        agentId,
      });
      try {
        conn.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pendingHostCalls.delete(id);
        reject(new AgentCallError((err as Error).message, "disconnected"));
      }
    });
  }

  /** Called by the ws-agent handler when a JSON-RPC result/error arrives
   *  that isn't a message-delivery ack. Returns false when `id` doesn't
   *  match an outstanding callOnHost()/callOnAgent(); the caller falls
   *  back to treating the frame as an ack in that case. */
  resolveHostCall(
    id: string,
    result: unknown | undefined,
    error: AgentCallErrorReply | undefined,
  ): boolean {
    const pending = this.pendingHostCalls.get(id);
    if (!pending) return false;
    this.pendingHostCalls.delete(id);
    clearTimeout(pending.timer);
    if (error !== undefined)
      pending.reject(new AgentCallError(error.message, "remote", error.code));
    else pending.resolve(result);
    return true;
  }

  /** The live agent with this canonical id, or undefined when it is not
   *  currently connected. */
  liveAgent(agentId: string): AgentSummary | undefined {
    const entry = this.agents.get(agentId);
    return entry?.conn ? this.toSummary(entry) : undefined;
  }

  /** Currently connected agents only — disconnected-but-within-TTL
   *  entries stay resolvable (resolve()/send()) but drop out of the
   *  roster immediately. */
  listAgents(): AgentSummary[] {
    this.pruneExpired();
    return [...this.agents.values()]
      .filter((e) => e.conn !== undefined)
      .map((e) => this.toSummary(e));
  }

  listTeams(): AgentTeamSummary[] {
    this.pruneExpired();
    const names = new Set<string>();
    for (const entry of this.agents.values()) {
      for (const team of entry.teams) names.add(team);
    }
    return [...names].map((team) => this.teamSummary(team));
  }

  /** Address resolution: exact canonical ID always wins; otherwise an
   *  unambiguous display-label match; otherwise ambiguous or not-found.
   *  Scans all known entries, connected or within their disconnect TTL —
   *  a recently-disconnected agent is still a valid send/mailbox target. */
  resolve(address: string): AgentResolution {
    this.pruneExpired();
    const resolved = this.resolveEntry(address);
    if (resolved.kind === "found") {
      return { kind: "found", agent: this.toSummary(resolved.entry) };
    }
    return resolved;
  }

  /** Sends a direct message. `from` is stored verbatim (it may be a
   *  registered agent's canonical id or the dashboard's `operator@<host>`
   *  principal) — the caller is responsible for confirming the real
   *  sender identity from its own connection/request context. */
  send(params: {
    from: string;
    to: string;
    content: string;
    replyTo?: string;
    idempotencyKey: string;
  }): AgentSendResult {
    this.pruneExpired();
    const fingerprint = JSON.stringify({
      to: params.to,
      content: params.content,
      replyTo: params.replyTo ?? null,
    });
    const idemKey = `${params.from}:${params.idempotencyKey}`;
    const prior = this.idempotency.get(idemKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new AgentRegistryError(
          AGENT_RPC_ERRORS.idempotencyConflict,
          `idempotency key '${params.idempotencyKey}' reused with different parameters`,
        );
      }
      return prior.result as AgentSendResult;
    }

    const resolved = this.resolveEntry(params.to);
    if (resolved.kind === "ambiguous") {
      throw new AgentRegistryError(
        AGENT_RPC_ERRORS.addressAmbiguous,
        `address '${params.to}' is ambiguous`,
        resolved.data,
      );
    }
    if (resolved.kind === "not_found") {
      throw new AgentRegistryError(-32602, `agent '${params.to}' not found`);
    }
    const recipient = resolved.entry;
    const message = this.buildMessage({
      from: params.from,
      to: recipient.id,
      content: params.content,
      replyTo: params.replyTo,
    });
    recipient.mailbox.push(message);
    const recipientOnline = recipient.conn !== undefined;
    if (recipientOnline) this.pushToRecipient(recipient, message);

    const result: AgentSendResult = {
      ok: true,
      messageId: message.messageId,
      to: recipient.id,
      recipientOnline,
    };
    this.idempotency.set(idemKey, { fingerprint, result });
    this.recordEvent("message.sent", {
      from: params.from,
      to: recipient.id,
      messageId: message.messageId,
    });
    return result;
  }

  /** Sends to every current member of a team except the sender. */
  sendTeam(params: {
    from: string;
    team: string;
    content: string;
    replyTo?: string;
    idempotencyKey: string;
  }): AgentSendTeamResult {
    this.pruneExpired();
    const fingerprint = JSON.stringify({
      team: params.team,
      content: params.content,
      replyTo: params.replyTo ?? null,
    });
    const idemKey = `${params.from}:${params.idempotencyKey}`;
    const prior = this.idempotency.get(idemKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new AgentRegistryError(
          AGENT_RPC_ERRORS.idempotencyConflict,
          `idempotency key '${params.idempotencyKey}' reused with different parameters`,
        );
      }
      return prior.result as AgentSendTeamResult;
    }
    if (!this.teamExists(params.team)) {
      throw new AgentRegistryError(
        AGENT_RPC_ERRORS.teamNotFound,
        `team '${params.team}' not found`,
      );
    }

    const recipients = [...this.agents.values()].filter(
      (e) => e.teams.has(params.team) && e.id !== params.from,
    );
    const messageId = String(this.nextMessageId++);
    const timestamp = new Date(this.now()).toISOString();
    const type: AgentMessageType =
      params.replyTo !== undefined ? "reply" : "message";
    let onlineRecipientCount = 0;
    for (const entry of recipients) {
      const message: AgentMessage = {
        messageId,
        from: params.from,
        to: entry.id,
        type,
        content: params.content,
        ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
        team: params.team,
        timestamp,
      };
      entry.mailbox.push(message);
      if (entry.conn !== undefined) {
        onlineRecipientCount++;
        this.pushToRecipient(entry, message);
      }
    }

    const result: AgentSendTeamResult = {
      ok: true,
      messageId,
      team: params.team,
      recipientCount: recipients.length,
      onlineRecipientCount,
    };
    this.idempotency.set(idemKey, { fingerprint, result });
    this.recordEvent("message.team", {
      from: params.from,
      team: params.team,
      messageId,
      recipientCount: recipients.length,
    });
    return result;
  }

  /** Team membership is derived entirely from `entry.teams` — no separate
   *  team table to keep in sync. A team exists iff some entry has joined
   *  it; it is implicitly deleted the moment the last member leaves. */
  joinTeam(agentId: string, team: string): AgentJoinTeamResult {
    this.pruneExpired();
    const entry = this.agents.get(agentId);
    if (!entry) {
      throw new AgentRegistryError(
        AGENT_RPC_ERRORS.registrationRequired,
        `agent '${agentId}' is not registered`,
      );
    }
    const isNew = !entry.teams.has(team);
    entry.teams.add(team);
    if (isNew) this.recordEvent("team.joined", { agentId, team });
    return { ok: true, team: this.teamSummary(team) };
  }

  leaveTeam(agentId: string, team: string): AgentLeaveTeamResult {
    this.pruneExpired();
    const entry = this.agents.get(agentId);
    if (!entry || !entry.teams.has(team)) {
      throw new AgentRegistryError(
        AGENT_RPC_ERRORS.teamNotFound,
        `agent '${agentId}' is not a member of team '${team}'`,
      );
    }
    entry.teams.delete(team);
    this.recordEvent("team.left", { agentId, team });
    const remainingMembers = this.teamMembers(team);
    return {
      ok: true,
      team,
      deleted: remainingMembers.length === 0,
      remainingMembers,
    };
  }

  /** Read-only — does not drain. Callers ack individual messages via
   *  `ackMessage()` once delivery is confirmed. */
  getMailbox(agentId: string): AgentMessage[] {
    const entry = this.agents.get(agentId);
    return entry ? [...entry.mailbox] : [];
  }

  /** Removes one acked message from an agent's mailbox. No-op if the
   *  agent or the message is unknown (e.g. already acked, already purged). */
  ackMessage(agentId: string, messageId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    const index = entry.mailbox.findIndex((m) => m.messageId === messageId);
    if (index !== -1) entry.mailbox.splice(index, 1);
  }

  queryEvents(
    filter: {
      event?: string;
      since?: number;
      limit?: number;
      agent?: string;
    } = {},
  ): AgentQueryEventsResult {
    let matches = this.events;
    if (filter.since !== undefined) {
      const since = filter.since;
      matches = matches.filter((e) => e.timestamp > since);
    }
    if (filter.event !== undefined) {
      const prefix = filter.event;
      matches = matches.filter((e) => e.event.startsWith(prefix));
    }
    if (filter.agent !== undefined) {
      const resolved = this.resolveEntry(filter.agent);
      const agentId =
        resolved.kind === "found" ? resolved.entry.id : filter.agent;
      matches = matches.filter((e) =>
        Object.values(e.data).some((v) => v === agentId),
      );
    }
    const count = matches.length;
    const events =
      filter.limit !== undefined ? matches.slice(-filter.limit) : matches;
    return {
      events,
      count,
      oldestTimestamp: this.events[0]?.timestamp ?? 0,
      capacity: EVENTS_CAPACITY,
    };
  }

  private resolveEntry(address: string): ResolvedEntry {
    const exact = this.agents.get(address);
    if (exact) return { kind: "found", entry: exact };
    const candidates = [...this.agents.values()].filter(
      (e) => e.label === address,
    );
    if (candidates.length === 1) {
      const only = candidates[0];
      if (only) return { kind: "found", entry: only };
    }
    if (candidates.length > 1) {
      return {
        kind: "ambiguous",
        data: {
          address,
          candidates: candidates.map((e) => ({ id: e.id, cwd: e.cwd })),
        },
      };
    }
    return { kind: "not_found" };
  }

  private teamExists(team: string): boolean {
    for (const entry of this.agents.values()) {
      if (entry.teams.has(team)) return true;
    }
    return false;
  }

  private teamMembers(team: string): AgentTeamMember[] {
    return [...this.agents.values()]
      .filter((e) => e.teams.has(team))
      .map((e) => ({
        id: e.id,
        label: e.label,
        status: e.conn !== undefined ? "online" : "offline",
      }));
  }

  private teamSummary(team: string): AgentTeamSummary {
    return { name: team, members: this.teamMembers(team) };
  }

  private buildMessage(params: {
    from: string;
    to: string;
    content: string;
    replyTo?: string;
  }): AgentMessage {
    return {
      messageId: String(this.nextMessageId++),
      from: params.from,
      to: params.to,
      type: params.replyTo !== undefined ? "reply" : "message",
      content: params.content,
      ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
      timestamp: new Date(this.now()).toISOString(),
    };
  }

  /** Best-effort live push of a queued message as a JSON-RPC *request* to
   *  the recipient. The message's own `messageId` doubles as the JSON-RPC
   *  request id, so the extension's `{result: {received: true}}` reply
   *  correlates directly to `ackMessage()` without a separate pending-push
   *  table. A send failure leaves the message in the mailbox for the next
   *  reconnect or `get_mailbox` poll to pick up. */
  private pushToRecipient(entry: AgentEntry, message: AgentMessage): void {
    if (!entry.conn) return;
    const request: JsonRpcRequest<"agent.message", AgentMessage> = {
      jsonrpc: "2.0",
      id: message.messageId,
      method: "agent.message",
      params: message,
    };
    try {
      entry.conn.send(JSON.stringify(request));
    } catch {
      // delivery attempt failed; message remains in mailbox for redelivery
    }
  }

  private toSummary(entry: AgentEntry): AgentSummary {
    return {
      id: entry.id,
      hostId: entry.hostId,
      instanceId: entry.instanceId,
      label: entry.label,
      cwd: entry.cwd,
      pid: entry.pid,
      connectedAt: entry.connectedAt.toISOString(),
      teams: [...entry.teams],
      features: [...entry.features],
    };
  }

  private recordEvent(
    event: AgentHubEvent["event"],
    data: AgentHubEvent["data"],
  ): void {
    this.events.push({ timestamp: this.now(), event, data });
    if (this.events.length > EVENTS_CAPACITY) {
      this.events.splice(0, this.events.length - EVENTS_CAPACITY);
    }
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.disconnectedTtlMs;
    for (const [id, entry] of this.agents) {
      if (
        entry.conn === undefined &&
        entry.disconnectedAt !== undefined &&
        entry.disconnectedAt <= cutoff
      ) {
        this.agents.delete(id);
        this.purgeIdempotencyFor(id);
      }
    }
  }

  private purgeIdempotencyFor(agentId: string): void {
    const prefix = `${agentId}:`;
    for (const key of this.idempotency.keys()) {
      if (key.startsWith(prefix)) this.idempotency.delete(key);
    }
  }

  private rejectPendingHostCallsFor(agentId: string): void {
    for (const [id, pending] of this.pendingHostCalls) {
      if (pending.agentId !== agentId) continue;
      this.pendingHostCalls.delete(id);
      clearTimeout(pending.timer);
      pending.reject(
        new AgentCallError(`agent '${agentId}' disconnected`, "disconnected"),
      );
    }
  }
}
