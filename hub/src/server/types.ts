// Wire types shared by the agent-registration WebSocket, the REST broker
// routes, and the webui.

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
  /** Hub-added: the registered agent's display label (ompc session name,
   *  else basename(cwd)). Absent for Collab sessions with no registered
   *  omp-connected agent. */
  label?: string;
  /** Hub-added: the features the registered agent advertised at
   *  registration; `[]` when no omp-connected agent is registered. */
  features?: string[];
  /** Hub-added: the ompc session name the agent explicitly registered with,
   *  also while it reconnects. Absent when it registered none. */
  ompcLabel?: string;
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
   *  has a bounded blast radius. */
  expiresAt: number;
}

/** Host-level Collab discovery through a connected extension. */
export interface CollabMethodParams {
  "collab.list": CollabListParams;
  "collab.link": CollabLinkParams;
}

export interface CollabMethodResult {
  "collab.list": CollabListResult;
  "collab.link": CollabLinkResult;
}

export const HOST_SESSIONS_FEATURE = "host.sessions.v1";
export const HOST_SESSIONS_RESERVED_LABELS_FEATURE =
  "host.sessions.reserved-labels";

export interface PastSession {
  sessionId: string;
  cwd: string;
  title: string;
  modifiedAt: number;
  /** ompc suffix, not the conversation title; absent when unknown. */
  name?: string;
}

export interface HostMethodParams extends CollabMethodParams {
  "host.sessions.list": Record<string, never>;
  "host.sessions.start": {
    cwd: string;
    name: string;
    sessionId?: string;
    reservedLabels?: string[];
  };
}

export interface HostMethodResult extends CollabMethodResult {
  "host.sessions.list": { sessions: PastSession[] };
  "host.sessions.start": { ok: true; label: string };
}

export type HostMethod = keyof HostMethodParams;

/** A dashboard session group. `sessions` holds stable member keys:
 *  `${hostId}:label:${label}` or `${hostId}:instance:${instanceId}`. */
export interface SessionGroup {
  id: string;
  name: string;
  sessions: string[];
}

/** All session groups; `revision` increments with every change, so a
 *  client can ignore a list older than one it already has. */
export interface SessionGroupList {
  revision: number;
  groups: SessionGroup[];
  order: string[];
}

/** Server -> dashboard push. Narrow and server-known-true only — no generic
 *  event bus. Collab *session* state is never pushed (the server only ever
 *  learns it by RPC-polling a host); the webui polls for that instead. */
export type DashboardEvent =
  | { event: "agent.registered"; agent: AgentSummary }
  | { event: "agent.disconnected"; agentId: string }
  | {
      event: "agent.activity";
      agentId: string;
      busy: boolean;
      waiting: boolean;
      compacting: boolean;
    }
  | ({ event: "groups.changed" } & SessionGroupList)
  | { event: "transfer.changed"; transfer: TransferView };

// ---------------------------------------------------------------------------
// Agent-to-agent messaging.
// Canonical agent identity is `${hostId}:${instanceId}`. Recipient addresses
// accept that canonical ID, `ompc(${label}:${hostId})`, `ompc(${label}:${hostId}#${instanceId})`, or an unambiguous label (the `ompc(...)` wrapper is optional).
// See cc-pi-bridge/planning/20260920_research_wire-protocol-spec.md.
// ---------------------------------------------------------------------------

export interface AgentSummary {
  id: string; // canonical: `${hostId}:${instanceId}`
  displayName: string; // `ompc(${label}:${hostId}#${instanceId})`
  hostId: string;
  instanceId: string;
  label: string; // extension-reported ompc session name, else basename(cwd)
  cwd: string; // from the host's collab.list, confirmed at registration
  pid: number;
  connectedAt: string;
  teams: string[];
  features: string[]; // advertised at registration, [] if none
  /** Whether the session is mid-turn; omitted until the extension reports it. */
  busy?: boolean;
  /** Whether a turn is blocked on a question to the user; omitted until reported. */
  waiting?: boolean;
  /** Whether a compaction is running; omitted until reported. */
  compacting?: boolean;
  /** Terminal is available only for an OMPC_SESSION-backed tmux session. */
  terminal?: { available: true };
}

export type AgentMessageType = "message" | "reply";

export interface AgentMessage {
  messageId: string; // server-assigned monotonic, decimal string
  from: string; // registered agent: `ompc(${label}:${hostId})`; operator: `operator@<hub-host>`
  fromId?: string; // canonical registered agent ID for exact replies; absent for operator
  fromDisplayName?: string; // registered agent display name, includes instance ID
  to: string;
  type: AgentMessageType;
  content: string;
  replyTo?: string;
  team?: string;
  timestamp: string; // ISO 8601
}

export interface AgentTeamMember {
  id: string;
  displayName: string;
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
  displayName: string;
  cwd: string;
}

export interface AgentAddressAmbiguousErrorData {
  address: string;
  candidates: AgentAddressCandidate[];
}

/** Extension -> server, once per connection, must be the first message.
 *  `cwd` and `label` are the extension's own claims, used directly for the
 *  display label — the server has no independent way to confirm they
 *  correspond to a real session, so a session's display identity is only
 *  as trustworthy as the extension reporting it. */
export interface AgentRegisterParams {
  hostId: string;
  instanceId: string;
  pid: number;
  cwd: string;
  /** Display label (the ompc tmux session name); must match
   *  AGENT_LABEL_PATTERN. Absent → basename(cwd). */
  label?: string;
  /** Optional capabilities the extension serves (e.g. "session.v1"); at
   *  most AGENT_FEATURES_MAX entries, each matching AGENT_FEATURE_PATTERN.
   *  Absent → []. */
  features?: string[];
  /** Shared secret, checked against OMP_HUB_HOST_TOKEN. */
  token: string;
}

/** ompc's session-name rule. Excludes `@` and `:`, so a label can never be
 *  mistaken for a canonical `${hostId}:${instanceId}` address. */
export const AGENT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export const AGENT_FEATURE_PATTERN = /^[a-z][a-z0-9._-]{0,31}$/;
export const AGENT_FEATURES_MAX = 16;

export interface AgentRegisterResult {
  ok: true;
  agent: AgentSummary;
}

export interface AgentSendParams {
  to: string; // canonical ID, `ompc(...)` address, or unambiguous label
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
  agent?: string; // filter by canonical ID, `ompc(...)` address, or label
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
  reservedIdentity: -32004,
  addressAmbiguous: -32010,
  teamNotFound: -32011,
  idempotencyConflict: -32012,
  rateLimited: -32013,
} as const;

// ---------------------------------------------------------------------------
// Session inspection and file transfer.
// Server -> extension JSON-RPC requests sent to ONE agent connection (see
// AgentRegistry.callOnAgent), served by extensions that advertise the
// "session.v1" feature. Paths are POSIX, relative to the session root.
// ---------------------------------------------------------------------------

export const SESSION_FEATURE = "session.v1";
/** Advertised with SESSION_FEATURE by extensions that serve the
 *  session.schedule_prompt / session.scheduled / session.cancel_scheduled
 *  methods (prompts the session sends itself at a later time). */
export const SCHEDULE_FEATURE = "session.schedule.v1";
/** Advertised with SESSION_FEATURE by extensions that can exit their owner. */
export const EXIT_FEATURE = "session.exit.v1";
/** Advertised by sessions that can fork their current transcript. */
export const SESSION_FORK_FEATURE = "session.fork.v1";
/** Advertised by sessions that expose provider quota reports to control guests. */
export const USAGE_FEATURE = "session.usage.v1";
/** Advertised by sessions that serve the session.auth_* provider login and
 *  logout methods. */
export const AUTH_FEATURE = "session.auth.v1";
/** Largest value accepted for a login prompt answer. */
export const MAX_AUTH_INPUT = 100_000;

export interface AuthAccount {
  credentialId: number;
  label: string;
  detail: string;
  type: "api_key" | "oauth";
  active: boolean;
}

export interface AuthProvider {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
  accounts: AuthAccount[];
}

export interface AuthLoginStatus {
  loginId: string;
  providerId: string;
  state:
    | "starting"
    | "awaiting_auth"
    | "awaiting_input"
    | "done"
    | "failed"
    | "cancelled";
  url?: string;
  launchUrl?: string;
  instructions?: string;
  progress: string[];
  prompt?: { message: string; placeholder?: string; secret: boolean };
  identity?: string;
  error?: string;
}
/** The extension's limits for a scheduled prompt. */
export const MAX_SCHEDULED_TEXT = 100_000;
export const MAX_SCHEDULE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Error codes the extension replies with for session.* / files.* calls. */
export const SESSION_RPC_ERRORS = {
  notFound: -32001,
  exists: -32002,
  forbidden: -32003,
  invalid: -32004,
  changed: -32005,
  busy: -32006,
  methodNotFound: -32601,
} as const;

export interface SessionModelRef {
  provider: string;
  id: string;
  name: string;
}

export interface SessionInfoResult {
  cwd: string;
  pid: number;
  sessionName: string | null;
  access: "view" | "control";
  idle: boolean;
  model: SessionModelRef | null;
  thinkingLevel: string | null;
  thinkingLevels: string[];
  contextUsage: {
    tokens: number | null;
    contextWindow: number | null;
    percent: number | null;
  } | null;
  cacheUsage?: { hitTokens: number; missTokens: number } | null;
  models: SessionModelRef[];
}
export interface SessionUsageLimitResult {
  label: string;
  unit: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  usedFraction: number | null;
  status: string | null;
  window: {
    label: string;
    resetsAt: number | null;
    resetLabel: string | null;
  } | null;
}

export interface SessionUsageResult {
  generatedAt: number;
  reports: Array<{
    provider: string;
    fetchedAt: number | null;
    limits: SessionUsageLimitResult[];
  }>;
}

export type SessionFileType = "file" | "dir" | "symlink" | "other";

export interface SessionFileEntry {
  name: string;
  type: SessionFileType;
  size: number;
  mtimeMs: number;
  target?: "file" | "dir";
}

export interface FilesListResult {
  path: string;
  entries: SessionFileEntry[];
}

export interface FilesStatResult {
  path: string;
  type: SessionFileType;
  size: number;
  mtimeMs: number;
}

export interface FilesReadParams {
  path: string;
  offset: number;
  length: number;
  expect?: { size: number; mtimeMs: number };
}

export interface FilesReadResult {
  data: string; // base64
  size: number;
  mtimeMs: number;
  eof: boolean;
}

export interface FilesWriteParams {
  path: string;
  uploadId: string;
  offset: number;
  data: string; // base64
  final: boolean;
  overwrite: boolean;
  destination?: "temp";
}

export interface FilesWriteResult {
  ok: true;
  path: string;
  size: number;
}

export interface OkResult {
  ok: true;
}

export interface ScheduledPromptResult {
  id: string;
  text: string;
  /** Epoch ms by the session host's clock. */
  fireAt: number;
  createdAt: number;
}

export const TERMINAL_FEATURE = "terminal.v1";
export const FILES_TEMP_UPLOAD_FEATURE = "files.temp_upload.v1";

/** Advertised by sessions that serve the transfer.* methods (send to host). */
export const SESSION_TRANSFER_FEATURE = "session.transfer.v1";

// ---------------------------------------------------------------------------
// Send to host. The hub keeps one record per operation, creates the worker's
// credentials, and relays progress and recovery commands. Secrets are
// 32 random bytes (base64url); only their SHA-256 verifiers are stored.
// ---------------------------------------------------------------------------

/** Operation states, in the order of a successful transfer. */
export const TRANSFER_STATES = [
  "prepared",
  "source-stopping",
  "source-stopped",
  "staged",
  "publishing",
  "source-departed",
  "destination-starting",
  "completed",
  "aborting",
  "rolled-back",
] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];
/** States that end an operation. */
export const TRANSFER_TERMINAL_STATES: readonly TransferState[] = [
  "completed",
  "rolled-back",
];
export const TRANSFER_PROJECT_MODES = [
  "create",
  "session-only",
  "update",
] as const;
export type TransferProjectMode = (typeof TRANSFER_PROJECT_MODES)[number];
export const TRANSFER_RECOVER_ACTIONS = [
  "resume",
  "retry-launch",
  "rollback-source",
  "restore-project",
  "cleanup",
] as const;
export type TransferRecoverAction = (typeof TRANSFER_RECOVER_ACTIONS)[number];
/** Worker credential lifetime; the renewal secret obtains the next one. */
export const TRANSFER_TOKEN_TTL_MS = 10 * 60 * 1000;
/** An operation whose worker has been silent this long may be abandoned. */
export const TRANSFER_ABANDON_AFTER_MS = 15 * 60 * 1000;
/** Finished terminal operations are dropped from the state file after this. */
export const TRANSFER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export interface TransferError {
  code: string;
  message: string;
  /** ISO 8601, set by the hub when it records the error. */
  at: string;
}

export interface TransferHistoryEntry {
  state: TransferState;
  at: string;
  detail?: string;
}

/** A control request for the worker; `seq` increases per operation from 1. */
export interface TransferCommand {
  seq: number;
  type: "cancel" | "recover";
  payload: Record<string, unknown>;
  createdAt: string;
  /** ISO 8601; set once the worker acknowledged the command. */
  ackedAt?: string;
}

/** One operation as persisted in transfers.json. */
export interface TransferRecord {
  id: string;
  sessionId: string;
  host: string;
  instance: string;
  destination: string;
  state: TransferState;
  lastConfirmedState: TransferState;
  history: TransferHistoryEntry[];
  error?: TransferError;
  planDigest: string;
  projectMode: TransferProjectMode;
  /** Latest worker progress report; free-form, bounded in size. */
  progress?: Record<string, unknown>;
  /** True once the worker has reported any event. */
  workerStarted: boolean;
  createdAt: string;
  updatedAt: string;
  commands: TransferCommand[];
  /** SHA-256 (base64url) of the current worker token. */
  tokenVerifier: string;
  /** Epoch ms. */
  tokenExpiresAt: number;
  /** SHA-256 (base64url) of the renewal secret; "" once revoked. */
  renewalVerifier: string;
  /** The worker called finish: no more renewals. */
  finished: boolean;
}

/** What REST and the dashboard socket expose: no verifiers. */
export type TransferView = Omit<
  TransferRecord,
  "tokenVerifier" | "tokenExpiresAt" | "renewalVerifier"
>;

export interface TransferDestination {
  name: string;
  hostId: string;
}
export interface TransferDestinationsResult {
  enabled: boolean;
  destinations: TransferDestination[];
}
export interface TransferPlanParams {
  destination: string;
  projectMode?: TransferProjectMode;
  destinationPath?: string;
}
/** `plan` and `preflight` are produced by the extension and shown by the
 *  dashboard; the hub does not interpret them. */
export interface TransferPlanResult {
  planId: string;
  digest: string;
  plan: unknown;
  preflight: unknown;
}
export interface TransferCommitParams {
  planId: string;
  planDigest: string;
  projectMode: TransferProjectMode;
  acceptIncomplete: boolean;
  operation: {
    id: string;
    token: string;
    renewalSecret: string;
    hubUrl: string;
  };
}
export interface TransferCommitResult {
  operationId: string;
}

/** Worker -> hub: `POST /api/transfers/:id/worker/events`. */
export interface TransferEventPayload {
  state: TransferState;
  detail?: string;
  error?: { code: string; message: string };
  progress?: Record<string, unknown>;
}

export interface SessionMethodParams {
  "session.info": Record<string, never>;
  "session.abort": Record<string, never>;
  "session.exit": Record<string, never>;
  "session.fork": { name: string };
  "session.compact": { instructions?: string };
  "session.set_model": { provider: string; id: string };
  "session.set_thinking": { level: string };
  "files.list": { path: string };
  "files.stat": { path: string };
  "files.read": FilesReadParams;
  "files.write": FilesWriteParams;
  "files.write_abort": { path: string; uploadId: string; destination?: "temp" };
  "files.mkdir": { path: string };
  "session.schedule_prompt": { text: string; delayMs: number };
  "session.scheduled": Record<string, never>;
  "session.cancel_scheduled": { id: string };
  "session.auth_providers": Record<string, never>;
  "session.auth_login_start": { providerId: string };
  "session.auth_login_status": { loginId: string };
  "session.auth_login_input": { loginId: string; value: string };
  "session.auth_login_cancel": { loginId: string };
  "session.auth_logout": { providerId: string; credentialId: number };
  "session.model_roles": Record<string, never>;
  "session.agent_roles": Record<string, never>;
  "session.set_model_role": SetModelRoleParams;
  "session.usage": Record<string, never>;
  "terminal.open": { ticket: string; relayUrl: string };
  "transfer.destinations": Record<string, never>;
  "transfer.plan": TransferPlanParams;
  "transfer.commit": TransferCommitParams;
}

export interface SessionMethodResult {
  "session.info": SessionInfoResult;
  "session.abort": OkResult;
  "session.fork": { ok: true; label: string };
  "session.exit": OkResult;
  "session.compact": OkResult;
  "session.set_model": OkResult;
  "session.set_thinking": OkResult;
  "files.list": FilesListResult;
  "files.stat": FilesStatResult;
  "files.read": FilesReadResult;
  "files.write": FilesWriteResult;
  "files.write_abort": OkResult;
  "files.mkdir": OkResult;
  "session.schedule_prompt": ScheduledPromptResult;
  "session.scheduled": { prompts: ScheduledPromptResult[] };
  "session.cancel_scheduled": OkResult;
  "session.auth_providers": { providers: AuthProvider[] };
  "session.auth_login_start": AuthLoginStatus;
  "session.auth_login_status": AuthLoginStatus;
  "session.auth_login_input": OkResult;
  "session.auth_login_cancel": OkResult;
  "session.auth_logout": { ok: true; remainingSource: string | null };
  "session.model_roles": ModelRolesInfo;
  "session.agent_roles": AgentRolesInfo;
  "session.usage": SessionUsageResult;
  "session.set_model_role": ModelRolesInfo;
  "terminal.open": { ok: true; directUrl?: string; directTicket?: string };
  "transfer.destinations": TransferDestinationsResult;
  "transfer.plan": TransferPlanResult;
  "transfer.commit": TransferCommitResult;
}

export type SessionMethod = keyof SessionMethodParams;

export const MODEL_ROLES_FEATURE = "session.model_roles.v1";

export interface RoleModel {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: string[];
}

export interface ModelRoleInfo {
  id: string;
  name: string;
  selector: string | null;
  provenance: string | null;
  globalSelector: string | null;
  projectSelector: string | null;
  resolvedModel: SessionModelRef | null;
  models: RoleModel[];
}

export interface ModelRolesInfo {
  access: "view" | "control";
  storage: "global" | "project";
  roles: ModelRoleInfo[];
}

export interface SetModelRoleParams {
  role: string;
  selector: string | null;
  scope?: "global" | "project";
}

export const AGENT_ROLES_FEATURE = "session.agent_roles.v1";

export interface AgentRoleInfo {
  name: string;
  description: string;
  source: string;
  filePath: string | null;
  disabled: boolean;
  frontmatterModel: string[];
  overrideModel: string | null;
  origin: "override" | "frontmatter" | "session";
  role: string | null;
  patterns: string[];
  resolvedModel: SessionModelRef | null;
  thinking: string | null;
}

export interface AgentRolesInfo {
  agents: AgentRoleInfo[];
}
