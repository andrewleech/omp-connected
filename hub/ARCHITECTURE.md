# Architecture

## Module layout

```
src/
  server/   Elysia HTTP + WebSocket server: REST routes, /ws/agent native
            agent-message registry (also the only channel host-level
            Collab discovery has), serves webui/ at "/" and webui/collab
            at "/collab/".
  relay/    src/relay/relay.ts — the Collab terminal-byte relay, started by
            the server on its own port (OMP_HUB_RELAY_PORT, e.g. 7466).
webui/
  (dashboard)   fleet dashboard served at "/".
  collab/       vendored Collab guest client, served at "/collab/".
```

The relay shares the hub process but no state: `src/server/index.ts`
starts it as a separate `Bun.serve()` listener and stops it on shutdown,
and nothing else crosses the boundary. The server only ever hands out
relay connection URLs (`wss://hub-host.your-tailnet.ts.net:7466/...`) inside
`CollabLinkResult.url`, which the browser guest then connects to.

## Agent protocol: `/ws/agent`

One WebSocket connection per `omp-connected` extension instance,
JSON-RPC 2.0 framed. The extension always speaks first with
`agent.register`; after that the server dispatches `agent.*` calls from
the extension (the agent, not the server, drives most calls), and the
server may itself push three kinds of server-initiated request over that
same connection: `agent.message` when another agent sends to this one,
`collab.list`/`collab.link` to serve host-level Collab discovery
through whichever agent connection is currently live for a hostId
(there is no separate host-registration connection), and `session.*`/`files.*`
calls addressed to one specific agent for the dashboard's Session and Files tabs.
All push kinds are JSON-RPC *requests*; the extension's `{result: ...}`/`{error: ...}`
reply, matched on the request's own id, is both the delivery
confirmation and (for the collab, session and files calls) the RPC result itself.

```ts
interface JsonRpcRequest<M extends string = string, P = unknown> { jsonrpc: "2.0"; id: string; method: M; params: P; }
interface JsonRpcResult<R = unknown> { jsonrpc: "2.0"; id: string; result: R; }
interface JsonRpcError { jsonrpc: "2.0"; id: string; error: { code: number; message: string }; }

// Extension -> Server, once per connection, must be the first message
// label: optional display label (ompc's tmux session name), /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
// features: optional capabilities the extension serves, at most 16 of /^[a-z][a-z0-9._-]{0,31}$/; absent means []
interface AgentRegisterParams { hostId: string; instanceId: string; pid: number; cwd: string; label?: string; features?: string[]; token: string; }
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
  hostId: string; instanceId: string; label: string; // registered label, else basename(cwd); not unique
  features: string[]; // advertised at registration
  status: "online" | "offline";
}

// Server -> Extension (server-initiated call, forwarded to whichever
// agent connection is currently live for the target hostId; the
// extension answers in-process from omp's `omp collab list|link --json`
// implementation (@oh-my-pi/pi-coding-agent/cli/collab-cli) — no subprocess)
interface CollabListParams {}
interface CollabListResult { sessions: HostCollabSession[] }
interface CollabLinkParams { instanceId: string; generation: number; access: "view" | "control"; }
interface CollabLinkResult { access: "view" | "control"; url: string; expiresAt: number }

interface HostCollabSession {
  instanceId: string; generation: number; access: "view" | "control"; pid: number;
  sessionId: string; sessionName: string | null; cwd: string;
  model: { provider: string; id: string } | null; startedAt: number;
  participants: number; relayConnected: boolean; inputRequired: boolean;
  label?: string; // hub-added from the registered agent, absent if none
  features: string[]; // hub-added from the registered agent, [] if none
}
```

### Session inspection and file transfer (`session.v1`)

An extension that registers with `features: ["session.v1"]` answers these calls for its own omp session. The hub sends each one to that agent's own connection (`AgentRegistry.callOnAgent`), never to another agent on the same host.

```ts
"session.info" {} -> { cwd; pid; sessionName; access: "view" | "control"; idle; model; thinkingLevel; thinkingLevels: string[]; contextUsage; models }
"session.abort" {} -> { ok: true }
"session.compact" { instructions?: string } -> { ok: true }  // starts compaction; busy while the session is working
"session.set_model" { provider: string; id: string } -> { ok: true }
"session.set_thinking" { level: string } -> { ok: true }
"files.list" { path } -> { path; entries: { name; type: "file" | "dir" | "symlink" | "other"; size; mtimeMs; target?: "file" | "dir" }[] }
"files.stat" { path } -> { path; type; size; mtimeMs }  // a symlink reports its resolved target's size and mtime
"files.read" { path; offset; length <= 262144; expect?: { size; mtimeMs } } -> { data: base64; size; mtimeMs; eof }
"files.write" { path; uploadId; offset; data: base64; final; overwrite } -> { ok: true; path; size }
"files.write_abort" { path; uploadId } -> { ok: true }
"files.mkdir" { path } -> { ok: true }
```

Paths are POSIX, relative to the session's working directory at start (realpath'd); the extension refuses absolute paths, NUL bytes, `..` above the root and anything whose realpath (including through a symlink) is outside the root. `session.info` is always answered; every other method needs the session's own Collab share to have `control` access. Uploads go to a temp file `.<name>.omp-upload-<uploadId>` next to the target and are renamed into place on the final chunk; unfinished uploads are discarded after 10 minutes without a chunk and when the session shuts down.

Error codes and their REST mapping: -32001 not found (404), -32002 exists (409), -32003 forbidden (403), -32004 invalid (400), -32005 changed during a download (409), -32006 busy (409), -32601 unknown method (501, an extension without `session.v1`), anything else 502. A call with no reply in 15 s answers 504.

**No independent identity check.** `agent.register` is token-gated
only: `hostId`, `instanceId`, `cwd`, and `label` are the extension's own
claim, used directly (`label`, else `cwd`, for the agent's display label). There is no second,
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
  live for that hostId, and adds each session's registered agent `label`.
- `POST /api/hosts/:id/collab/:instanceId/link` `{ generation, access }` →
  `{ access, url, expiresAt }` — forwards a `collab.link` call the same
  way.
- `/api/hosts/:id/sessions/:instanceId/...`: the `session.v1` calls for the agent `${id}:${instanceId}`: 404 when it isn't connected, 501 when it didn't advertise `session.v1`.
  - `GET info`, `POST abort`, `POST compact` `{ instructions? }`, `POST model` `{ provider, id }`, `POST thinking` `{ level }`.
  - `GET files?path=` lists a directory, `POST files/mkdir` `{ path }` creates one.
  - `GET files/download?path=[&inline=1]` streams a file as `files.read` chunks of 256 KiB, each checked against the size and mtime of the initial `files.stat`, so a file that changes mid-download errors the stream instead of mixing versions. The response is always `attachment` with `content-security-policy: sandbox` and `nosniff`; `inline=1` only applies to PNG, JPEG, GIF and WebP.
  - `PUT files/upload?path=&overwrite=0|1` streams the raw body into `files.write` chunks of 256 KiB, awaiting each before reading on; over 256 MiB answers 413 and aborts the upload.
  - Control actions (abort, compact, model, thinking, mkdir) share a limit of 20 per 10 s per session, and each session has at most 4 transfers in flight; both answer 429.
- `GET /api/agents` → `{ agents: AgentSummary[] }`.
- `POST /api/agents/:id/send` `{ content, replyTo?, idempotencyKey }` →
  sends as `operator@<hub-host>` (dashboard-only; the dashboard is never
  a registered agent connection, so it can only send as this reserved
  principal, never spoof a real agent's identity); `:id` accepts a
  canonical ID or an unambiguous display label.
- `GET /` — the fleet dashboard webui.
- `GET /manifest.webmanifest`, `GET /sw.js` — PWA manifest and service
  worker, served `cache-control: no-cache` (outside the static plugin's
  day-long max-age) so installed clients pick up changes. `sw.js` only
  intercepts top-level navigations, falling back to a cached
  `/offline.html` when the hub is unreachable.
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
- **Session controls and files follow the Collab share.** The dashboard's `session.v1` routes have no authentication of their own beyond reaching the hub, like the rest of the REST API. What they can do is decided by the omp session: only `session.info` works on a view-only share, and file access is confined to the session's working directory by realpath. Downloads are always served with `content-security-policy: sandbox` and `x-content-type-options: nosniff`, and only raster images may be shown inline, so a file from a session cannot run script in the dashboard's origin.

## Scope

- This server does not launch, mirror, or otherwise manage OMP sessions
  itself. The local `omp` CLI (via the `omp-connected` extension loaded
  inside it) owns that; this server only ever talks to a *registered*
  agent's existing session through `/ws/agent`.
- Its own registry (agents, Collab sessions, brokered links) is fully
  independent and does not merge with, read, or depend on any other
  service's state.