# omp-hub

Standalone OMP Collab fleet dashboard, host broker, and private relay —
see [ARCHITECTURE.md](./ARCHITECTURE.md) for the full module layout,
wire protocol, and security model.

## What this is

- The `omp-connected` extension (lives in
  [`cc-pi-bridge/trial-omp/marketplace/plugins/omp-connected`](https://github.com/)
  as `src/index.ts`) registers each OMP session with this server over
  `/ws/agent`, giving it a native, hub-stamped agent-to-agent messaging
  identity — see [ARCHITECTURE.md](./ARCHITECTURE.md) for the wire
  protocol.
- That same connection is also how this server reaches host-level Collab
  discovery: `collab.list`/`collab.link` calls are forwarded to whichever
  agent connection is currently live for a hostId and answered directly
  against `@oh-my-pi/pi-coding-agent`'s own Collab registry — there is no
  separate host-registration process or connection.
- The server exposes both over REST (`/api/hosts/:id/collab`,
  `/api/hosts/:id/collab/:instanceId/link`, `/api/agents`,
  `/api/agents/:id/send`) and serves a small fleet dashboard webui at
  `/` plus the vendored OMP Collab guest client at `/collab/`.
- A private relay (`src/relay/relay.ts`) carries the actual encrypted
  Collab terminal bytes between a host and its guests, on its own port.

## `OMP_HUB_URL` and `OMP_HUB_HOST_TOKEN`

`OMP_HUB_URL` is **this server**. Set both in every interactive OMP
terminal (the `omp-connected` extension reads them at session start) to
register that session's native agent-messaging identity over
`/ws/agent` and make its host available for Collab discovery.
`OMP_HUB_HOST_TOKEN` must match what this server is configured with;
the extension is a graceful no-op when either variable is unset.

Registration is token-gated only — there is no independent connection
that confirms a session's claimed identity, so a session's display
identity is only as trustworthy as the extension reporting it. See
[ARCHITECTURE.md](./ARCHITECTURE.md)'s security model section.

Agent-to-agent messaging is implemented natively by this server
(`AgentRegistry`, `/ws/agent`) — see [ARCHITECTURE.md](./ARCHITECTURE.md)
for the wire protocol.

## Local development

```sh
bun install
OMP_HUB_HOST_TOKEN=dev-secret bun run dev   # watches src/server
bun run build                               # builds webui + vendors collab-web (see below)
bun test
bun run lint
```

`bun run build` runs two steps:
- `build:webui` — bundles `src/webui/app.ts` + `src/webui/index.html` into
  `dist/webui/`.
- `build:collab` — builds the vendored OMP Collab guest client from
  `cc-pi-bridge/trial-omp/webui/collab-web` (set `COLLAB_WEB_SRC` to
  override that path) into `dist/webui/collab/`. See
  `scripts/build-vendor-collab.sh` for why that source isn't vendored
  directly into this repo yet.

## Deploying

Deploy units live in [`deploy/`](./deploy):

- `omp-hub.service` — the main server. Orders after `tailscaled.service`
  and blocks on `tailscale ip -4` before starting, so it never races
  Tailscale interface readiness at boot (the root cause of a real outage
  this design fixes — see ARCHITECTURE.md).
- `omp-hub-relay.service` — the private relay.
- `omp-hub-cert-renew.service` / `.timer` — weekly Tailscale cert renewal,
  restarting both services above.

Copy `deploy/omp-hub.env.example` → `~/.config/omp-hub/omp-hub.env` and
`deploy/omp-hub-relay.env.example` → `~/.config/omp-hub/omp-hub-relay.env`,
fill in a real `OMP_HUB_HOST_TOKEN` and TLS cert paths, then:

```sh
systemctl --user enable --now omp-hub.service omp-hub-relay.service
systemctl --user enable --now omp-hub-cert-renew.timer
```

Set `OMP_HUB_URL` and `OMP_HUB_HOST_TOKEN` in every interactive OMP
terminal to point it at this deployment.