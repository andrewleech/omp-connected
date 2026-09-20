// Wire types shared by the host-registration WebSocket, the REST broker
// routes, and the webui. Deliberately NOT byte-compatible with claude-net's
// old `/ws/host` `{action, request_id, ..._done}` envelope — this is a
// different protocol on a different server now, and pretending otherwise
// would invite someone to point a claude-net host client at it by mistake.

export type JsonRpcId = string;

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: M;
  params: P;
}

export interface JsonRpcResult<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorPayload;
}

export type JsonRpcResponse<R = unknown> = JsonRpcResult<R> | JsonRpcError;

export function isJsonRpcResult<R>(
  msg: JsonRpcResponse<R>,
): msg is JsonRpcResult<R> {
  return "result" in msg;
}

/** Host -> server, once per connection, must be the first message. */
export interface HostRegisterParams {
  hostId: string;
  user: string;
  hostname: string;
  ompVersion: string;
  /** Shared secret, checked against OMP_HUB_HOST_TOKEN. */
  token: string;
}

export interface HostRegisterResult {
  ok: true;
  hostId: string;
}

/** Summary of a connected host, for GET /api/hosts and host.connected/disconnected events. */
export interface HostSummary {
  hostId: string;
  user: string;
  hostname: string;
  ompVersion: string;
  connectedAt: string;
}

/** Metadata from `omp collab list --json`. Deliberately excludes a link. */
export interface HostCollabSession {
  instanceId: string;
  generation: number;
  access: "view" | "control";
  pid: number;
  sessionId: string;
  sessionName: string | null;
  cwd: string;
  model: { provider: string; id: string } | null;
  startedAt: number;
  participants: number;
  relayConnected: boolean;
  inputRequired: boolean;
}

export type CollabListParams = Record<string, never>;

export interface CollabListResult {
  sessions: HostCollabSession[];
}

export interface CollabLinkParams {
  instanceId: string;
  generation: number;
  access: "view" | "control";
}

export interface CollabLinkResult {
  access: "view" | "control";
  url: string;
  /** Epoch millis. Short-TTL by design — a link that leaks or goes unused
   *  has a bounded blast radius. Not present in the claude-net-hosted
   *  predecessor; added deliberately in this rewrite. */
  expiresAt: number;
}

/** Server -> dashboard push. Narrow and server-known-true only — no generic
 *  event bus. Collab *session* state is never pushed (the server only ever
 *  learns it by RPC-polling a host); the webui polls for that instead. */
export type DashboardEvent =
  | { event: "host.connected"; host: HostSummary }
  | { event: "host.disconnected"; hostId: string }
  | { event: "agent.registered"; agent: AgentSummary }
  | { event: "agent.disconnected"; agentId: string };

// ---------------------------------------------------------------------------
// Agent-to-agent messaging (native to omp-hub — no claude-net lineage).
// Canonical agent identity is `${hostId}:${instanceId}`; the display label
// (`basename(cwd)`) is a convenience address that resolves only when
// unambiguous across all currently-known agents. See
// cc-pi-bridge/planning/20260920_research_wire-protocol-spec.md.
// ---------------------------------------------------------------------------

export interface AgentSummary {
  id: string; // canonical: `${hostId}:${instanceId}`
  hostId: string;
  instanceId: string;
  label: string; // basename(cwd), server-derived, never self-reported
  cwd: string; // from the host's collab.list, confirmed at registration
  pid: number;
  connectedAt: string;
  teams: string[];
}

export type AgentMessageType = "message" | "reply";

export interface AgentMessage {
  messageId: string; // server-assigned monotonic, decimal string
  from: string;
  to: string;
  type: AgentMessageType;
  content: string;
  replyTo?: string;
  team?: string;
  timestamp: string; // ISO 8601
}

export interface AgentTeamMember {
  id: string;
  label: string;
  status: "online" | "offline";
}

export interface AgentTeamSummary {
  name: string;
  members: AgentTeamMember[];
}

export interface AgentHubEvent {
  timestamp: number; // epoch ms
  event:
    | "agent.registered"
    | "agent.disconnected"
    | "message.sent"
    | "message.team"
    | "team.joined"
    | "team.left";
  data: Record<string, string | number | boolean | null>;
}

export interface AgentAddressCandidate {
  id: string;
  cwd: string;
}

export interface AgentAddressAmbiguousErrorData {
  address: string;
  candidates: AgentAddressCandidate[];
}

/** Extension -> server, once per connection, must be the first message. */
export interface AgentRegisterParams {
  hostId: string;
  instanceId: string;
  pid: number;
  /** Shared secret, checked against OMP_HUB_HOST_TOKEN — the same token the
   *  omp-host sidecar uses for /ws/host. */
  token: string;
}

export interface AgentRegisterResult {
  ok: true;
  agent: AgentSummary;
}

export interface AgentSendParams {
  to: string; // canonical ID or unambiguous display label
  content: string;
  replyTo?: string;
  idempotencyKey: string; // client-supplied, reused verbatim on retry
}

export interface AgentSendResult {
  ok: true;
  messageId: string;
  to: string; // resolved canonical ID
  recipientOnline: boolean;
}

export interface AgentSendTeamParams {
  team: string;
  content: string;
  replyTo?: string;
  idempotencyKey: string;
}

export interface AgentSendTeamResult {
  ok: true;
  messageId: string;
  team: string;
  recipientCount: number;
  onlineRecipientCount: number;
}

export interface AgentJoinTeamParams {
  team: string;
}

export interface AgentJoinTeamResult {
  ok: true;
  team: AgentTeamSummary;
}

export interface AgentLeaveTeamParams {
  team: string;
}

export interface AgentLeaveTeamResult {
  ok: true;
  team: string;
  deleted: boolean;
  remainingMembers: AgentTeamMember[];
}

export type AgentListAgentsParams = Record<string, never>;

export interface AgentListAgentsResult {
  agents: AgentSummary[];
}

export type AgentListTeamsParams = Record<string, never>;

export interface AgentListTeamsResult {
  teams: AgentTeamSummary[];
}

export interface AgentGetMailboxParams {
  agent?: string;
}

export interface AgentGetMailboxResult {
  agentId: string;
  messages: AgentMessage[];
}

export interface AgentQueryEventsParams {
  event?: string; // dot-prefix filter
  since?: number; // epoch ms, exclusive
  limit?: number;
  agent?: string; // filter by canonical ID or label
}

export interface AgentQueryEventsResult {
  events: AgentHubEvent[];
  count: number;
  oldestTimestamp: number;
  capacity: number;
}

/** Server -> extension push. Sent as a JSON-RPC *request*; the extension's
 *  reply IS the delivery receipt — there is no separate ack method. */
export type AgentMessageParams = AgentMessage;

export interface AgentMessageResult {
  received: true;
}

export const AGENT_RPC_ERRORS = {
  invalidToken: -32001,
  registrationRequired: -32002,
  hostSessionNotFound: -32003,
  reservedIdentity: -32004,
  addressAmbiguous: -32010,
  teamNotFound: -32011,
  idempotencyConflict: -32012,
  rateLimited: -32013,
} as const;