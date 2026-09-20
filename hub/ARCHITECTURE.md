# Architecture

## Module layout

```
src/
  server/   Elysia HTTP + WebSocket server: REST routes, /ws/host host
            registry, /ws/agent native agent-message registry, serves
            webui/ at "/" and webui/collab at "/collab/".
  relay/    src/relay/relay.ts — the Collab terminal-byte relay (port 7466).
webui/
  (dashboard)   fleet dashboard served at "/".
  collab/       vendored Collab guest client, served at "/collab/".
```

`src/server` and `src/relay` never import from each other; the relay is a
standalone TCP/TLS process the server never talks to directly — the server
only ever hands out relay connection URLs (`wss://hub-host.your-tailnet.ts.net:7466/...`)
inside `CollabLinkResult.url`, which the browser guest then connects to.

## Host protocol: `/ws/host`

One WebSocket connection per host, JSON-RPC 2.0 framed. The host (a
`bin/omp-host` sidecar) always speaks first with `host_register`; after
that, the server drives the connection with server-initiated RPC calls
(`collab.list`, `collab.link`) and the host replies with a matching
`JsonRpcResult`/`JsonRpcError` using the same `id`.

```ts
interface JsonRpcRequest<M extends string = string, P = unknown> { jsonrpc: "2.0"; id: string; method: M; params: P; }
interface JsonRpcResult<R = unknown> { jsonrpc: "2.0"; id: string; result: R; }
interface JsonRpcError { jsonrpc: "2.0"; id: string; error: { code: number; message: string }; }

// Host -> Server, once per connection, must be the first message
interface HostRegisterParams { hostId: string; user: string; hostname: string; ompVersion: string; token: string; }
interface HostRegisterResult { ok: true; hostId: string }

// Server -> Host (server-initiated RPC call, host replies with JsonRpcResult/JsonRpcError using the same id)
interface CollabListParams {}
interface CollabListResult { sessions: HostCollabSession[] }
interface CollabLinkParams { instanceId: string; generation: number; access: "view" | "control"; }
interface CollabLinkResult { access: "view" | "control"; url: string; expiresAt: number }

interface HostCollabSession {
  instanceId: string; generation: number; access: "view" | "control"; pid: number;
  sessionId: string; sessionName: string | null; cwd: string;
  model: { provider: string; id: string } | null; startedAt: number;
  participants: number; relayConnected: boolean; inputRequired: boolean;
}
```

REST routes built on top of the same live registry:

- `GET /api/hosts/:id/collab` → `{ sessions: HostCollabSession[] }` — proxies
  a `collab.list` call to that host's open `/ws/host` connection.
- `POST /api/hosts/:id/collab/:instanceId/link` `{ generation, access }` →
  `{ access, url, expiresAt }` — proxies a `collab.link` call.
- `GET /` — the fleet dashboard webui.
- `/collab/` — the vendored Collab guest client.

## Agent protocol: `/ws/agent`

One WebSocket connection per `omp-connected` extension instance,
JSON-RPC 2.0 framed. The
extension always speaks first with `agent.register`; after that the
server dispatches `agent.*` calls from the extension (this is the
inverse of `/ws/host`: the agent, not the server, drives most calls),
and the server may itself push a server-initiated `agent.message`
request when another agent sends to a currently-connected recipient.

```ts
// Extension -> Server, once per connection, must be the first message
interface AgentRegisterParams { hostId: string; instanceId: string; pid: number; token: string; }
interface AgentRegisterResult { ok: true; agent: AgentSummary }

// Extension -> Server
interface AgentSendParams { to: string; content: string; replyTo?: string; idempotencyKey: string; }
interface AgentSendResult { ok: true; messageId: string; to: string; recipientOnline: boolean }
interface AgentSendTeamParams { team: string; content: string; replyTo?: string; idempotencyKey: string; }
interface AgentJoinTeamParams { team: string; }
interface AgentLeaveTeamParams { team: string; }
// agent.list_agents, agent.list_teams take no params
interface AgentGetMailboxParams { agent?: string; } // defaults to caller
interface AgentQueryEventsParams { event?: string; since?: number; limit?: number; agent?: string; }

// Server -> Extension (server-initiated push; the extension's {result: ...}
// reply is its delivery receipt, matched on the message's own id)
interface AgentMessagePush { messageId: string; from: string; to: string; content: string; replyTo?: string; }

interface AgentSummary {
  id: string; // canonical: `${hostId}:${instanceId}`
  hostId: string; instanceId: string; label: string; // basename(cwd), disambiguated on collision
  status: "online" | "offline";
}
```

**Cross-validation.** `agent.register` is never trusted at face value.
The server calls `HostRegistry.call(hostId, "collab.list", ...)` over
that host's already-open `/ws/host` connection and only admits the
registration if a session with the claimed `instanceId` is live on
that host right now — the same trust boundary `GET
/api/hosts/:id/collab` already crosses. `cwd` (used for the agent's
display label) comes from that server-confirmed `collab.list` result,
never from the extension's own claim.

REST routes built on top of the same live registry (dashboard-only;
the dashboard is never a registered agent connection, so it can only
send as the reserved `operator@<hub-host>` principal, never spoof a
real agent's identity):

- `GET /api/agents` → `{ agents: AgentSummary[] }`.
- `POST /api/agents/:id/send` `{ content, replyTo?, idempotencyKey }` →
  sends as `operator@<hub-host>`; `:id` accepts a canonical ID or an
  unambiguous display label.

## Security model

- **Shared-secret host registration.** `HostRegisterParams.token` must match
  `OMP_HUB_HOST_TOKEN`, configured identically on the server and on every
  `bin/omp-host` sidecar. If it doesn't match, registration is rejected and
  the socket is closed immediately — the host never enters the registry and
  never receives `collab.list`/`collab.link` calls. A host reachable on the
  tailnet is not implicitly trusted; only the shared secret admits it.
- **Capability URLs stay client-side only.** The `url` returned by
  `collab.link` (a short-TTL, capability-bearing relay URL) is handed to the
  browser and lives only in the URL fragment (`#...`), which is never sent
  to any server in an HTTP request line and is excluded from all
  server-side request/access logging. The server itself never logs the
  URLs it mints.
- **Short-TTL links.** Every `CollabLinkResult.expiresAt` is a near-term
  timestamp; expired links are rejected by the relay on connect. A fresh
  link must be requested (and freshly authorized by the host) for each new
  guest session — links are not long-lived bearer tokens.

## What this project deliberately does NOT do

- It does not launch, mirror, or otherwise manage Claude Code sessions.
  `bin/omp-host` and the local `omp` CLI own that; this server only ever
  talks to a *registered* host's existing sessions through `/ws/host`.
- It does not depend on claude-net for anything, source or runtime.
  Agent-to-agent messaging (`AgentRegistry`, `/ws/agent`, teams,
  mailbox — see "Agent protocol" above) is implemented natively.
- Its own registry (hosts, Collab sessions, brokered links) is fully
  independent and does not merge with, read, or depend on any other
  service's state.