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
  | { event: "host.disconnected"; hostId: string };