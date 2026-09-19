# Architecture

## Module layout

```
src/
  server/   Elysia HTTP + WebSocket server: REST routes, /ws/host host
            registry, serves webui/ at "/" and webui/collab at "/collab/".
  relay/    src/relay/relay.ts — the Collab terminal-byte relay (port 7466),
            copied verbatim from claude-net's collab-relay.ts. Unchanged
            protocol, unchanged behavior.
webui/
  (dashboard)   fleet dashboard served at "/" (was "/omp" on claude-net;
                this project has its own dedicated origin, so it is now
                server root).
  collab/       vendored Collab guest client, served at "/collab/" (was
                "/omp/collab/" on claude-net).
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

## Security model

- **Shared-secret host registration.** `HostRegisterParams.token` must match
  `OMP_HUB_HOST_TOKEN`, configured identically on the server and on every
  `bin/omp-host` sidecar. If it doesn't match, registration is rejected and
  the socket is closed immediately — the host never enters the registry and
  never receives `collab.list`/`collab.link` calls. This is new: the old
  claude-net-hosted version relied only on Tailscale network position
  (any host reachable on the tailnet could register), which is not safe to
  keep now that this server is not gated behind claude-net's own perimeter.
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
- It has no concept of "teams" or a mailbox. Agent-to-agent messaging is
  claude-net's job exclusively; when the dashboard shows roster or
  messaging context it does so purely as an HTTP client of a claude-net
  instance's own API (via the optional `CLAUDE_NET_HUB` env var) — never by
  sharing source, importing claude-net code, or duplicating its data model.
- It does not persist or proxy claude-net's own hub state beyond that
  read-only client relationship; omp-hub's own registry (hosts, Collab
  sessions, brokered links) is independent and does not merge with or
  depend on claude-net's.