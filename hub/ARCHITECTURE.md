# Architecture

## Module layout

```
src/
  server/   Elysia HTTP + WebSocket server: REST routes, /ws/agent native
            agent-message registry (also the only channel host-level
            Collab discovery has), serves webui/ at "/" and webui/collab
            at "/collab/".
  relay/    src/relay/relay.ts — the Collab terminal-byte relay (port 7466).
webui/
  (dashboard)   fleet dashboard served at "/".
  collab/       vendored Collab guest client, served at "/collab/".
```

`src/server` and `src/relay` never import from each other; the relay is a
standalone TCP/TLS process the server never talks to directly — the server
only ever hands out relay connection URLs (`wss://hub-host.your-tailnet.ts.net:7466/...`)
inside `CollabLinkResult.url`, which the browser guest then connects to.

## Agent protocol: `/ws/agent`

One WebSocket connection per `omp-connected` extension instance,
JSON-RPC 2.0 framed. The extension always speaks first with
`agent.register`; after that the server dispatches `agent.*` calls from
the extension (the agent, not the server, drives most calls), and the
server may itself push two kinds of server-initiated request over that
same connection: `agent.message` when another agent sends to this one,
and `collab.list`/`collab.link` to serve host-level Collab discovery
through whichever agent connection is currently live for a hostId —
there is no separate host-registration connection. Both push kinds are
JSON-RPC *requests*; the extension's `{result: ...}`/`{error: ...}`
reply, matched on the request's own id, is both the delivery
confirmation and (for collab.list/collab.link) the RPC result itself.

```ts
interface JsonRpcRequest<M extends string = string, P = unknown> { jsonrpc: "2.0"; id: string; method: M; params: P; }
interface JsonRpcResult<R = unknown> { jsonrpc: "2.0"; id: string; result: R; }
interface JsonRpcError { jsonrpc: "2.0"; id: string; error: { code: number; message: string }; }

// Extension -> Server, once per connection, must be the first message
interface AgentRegisterParams { hostId: string; instanceId: string; pid: number; cwd: string; token: string; }
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

// Server -> Extension (server-initiated call, forwarded to whichever
// agent connection is currently live for the target hostId; the
// extension answers directly against @oh-my-pi/pi-coding-agent's own
// Collab registry — no CLI subprocess involved)
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

**No independent identity check.** `agent.register` is token-gated
only: `hostId`, `instanceId`, and `cwd` are the extension's own claim,
used directly (`cwd` for the agent's display label). There is no second,
independent connection to confirm them against — unlike the Collab
relay's own trust model, this registry does not require a claimed
session to be independently observable elsewhere before admitting it.
Accepting the shared token is accepting the identity claim that comes
with it.

REST routes built on top of the same live registry:

- `GET /api/hosts` → `{ hostId: string }[]` — hostIds with at least one
  currently-connected agent. A host with zero connected agents has
  nothing that can answer collab.list/collab.link and does not appear
  here.
- `GET /api/hosts/:id/collab` → `{ sessions: HostCollabSession[] }` —
  forwards a `collab.list` call to any one agent connection currently
  live for that hostId.
- `POST /api/hosts/:id/collab/:instanceId/link` `{ generation, access }` →
  `{ access, url, expiresAt }` — forwards a `collab.link` call the same
  way.
- `GET /api/agents` → `{ agents: AgentSummary[] }`.
- `POST /api/agents/:id/send` `{ content, replyTo?, idempotencyKey }` →
  sends as `operator@<hub-host>` (dashboard-only; the dashboard is never
  a registered agent connection, so it can only send as this reserved
  principal, never spoof a real agent's identity); `:id` accepts a
  canonical ID or an unambiguous display label.
- `GET /` — the fleet dashboard webui.
- `/collab/` — the vendored Collab guest client.

## Security model

- **Shared-secret agent registration, self-attested identity.**
  `AgentRegisterParams.token` must match `OMP_HUB_HOST_TOKEN`, configured
  identically on the server and in every interactive OMP session's
  environment. If it doesn't match, registration is rejected and the
  socket is closed immediately. A session reachable on the tailnet is
  not implicitly trusted; only the shared token admits it — but the
  token is a single fleet-wide secret, not scoped per host or session,
  so it authenticates "some session in the fleet," not "this specific
  hostId/instanceId." Anything holding the token can register under any
  claimed identity.
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

## Scope

- This server does not launch, mirror, or otherwise manage OMP sessions
  itself. The local `omp` CLI (via the `omp-connected` extension loaded
  inside it) owns that; this server only ever talks to a *registered*
  agent's existing session through `/ws/agent`.
- Its own registry (agents, Collab sessions, brokered links) is fully
  independent and does not merge with, read, or depend on any other
  service's state.