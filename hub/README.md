# omp-hub

Standalone OMP Collab fleet dashboard, host broker, and private relay.
Inspired by [claude-net](https://github.com/apium/claude-net)'s semantics
(fleet presence, capability-safe session brokering), but a fresh
implementation with no source dependency on it — see
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full module layout, wire
protocol, and security model.

## What this is

- A `bin/omp-host` sidecar (lives in
  [`cc-pi-bridge/trial-omp/marketplace/plugins/claude-net-omp`](https://github.com/)
  as `bin/omp-host`) registers each OMP host with this server over
  `/ws/host` and answers `collab.list`/`collab.link` RPCs.
- The server exposes that over REST (`/api/hosts/:id/collab`,
  `/api/hosts/:id/collab/:instanceId/link`) and serves a small fleet
  dashboard webui at `/` plus the vendored OMP Collab guest client at
  `/collab/`.
- A private relay (`src/relay/relay.ts`) carries the actual encrypted
  Collab terminal bytes between a host and its guests, on its own port.

## `OMP_HUB_URL` and `OMP_HUB_HOST_TOKEN`

`OMP_HUB_URL` is **this server**, used only by `bin/omp-host` to register a
host and broker Collab session links. Requires `OMP_HUB_HOST_TOKEN` to match
what this server is configured with.

This project has no coupling of any kind to claude-net — no source
dependency, and no runtime/network dependency either. `bin/omp-host` (in
`cc-pi-bridge/trial-omp/marketplace/plugins/claude-net-omp`) also registers
with a separate claude-net hub for its own agent-to-agent messaging tools,
but that is a wholly separate concern this server never talks to, proxies,
or depends on.

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
  restarting both services above. Never touches claude-net's deployment.

Copy `deploy/omp-hub.env.example` → `~/.config/omp-hub/omp-hub.env` and
`deploy/omp-hub-relay.env.example` → `~/.config/omp-hub/omp-hub-relay.env`,
fill in a real `OMP_HUB_HOST_TOKEN` and TLS cert paths, then:

```sh
systemctl --user enable --now omp-hub.service omp-hub-relay.service
systemctl --user enable --now omp-hub-cert-renew.timer
```

Point every `bin/omp-host` sidecar's `OMP_HUB_URL` and
`OMP_HUB_HOST_TOKEN` at this deployment.