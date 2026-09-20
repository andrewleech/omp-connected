# omp-hub

Standalone OMP Collab fleet dashboard, host broker, and private relay.
Inspired by [claude-net](https://github.com/apium/claude-net)'s semantics
(fleet presence, capability-safe session brokering), but a fresh
implementation with no source dependency on it — see
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full module layout, wire
protocol, and security model.

## What this is

- A `bin/omp-host` sidecar (lives in
  [`cc-pi-bridge/trial-omp/marketplace/plugins/omp-connected`](https://github.com/)
  as `bin/omp-host`) registers each OMP host with this server over
  `/ws/host` and answers `collab.list`/`collab.link` RPCs.
- The `omp-connected` extension (same plugin, `src/index.ts`) registers
  each OMP session with this server over `/ws/agent`, giving it a
  native, hub-stamped agent-to-agent messaging identity — see
  [ARCHITECTURE.md](./ARCHITECTURE.md) for the wire protocol.
- The server exposes both over REST (`/api/hosts/:id/collab`,
  `/api/hosts/:id/collab/:instanceId/link`, `/api/agents`,
  `/api/agents/:id/send`) and serves a small fleet dashboard webui at
  `/` plus the vendored OMP Collab guest client at `/collab/`.
- A private relay (`src/relay/relay.ts`) carries the actual encrypted
  Collab terminal bytes between a host and its guests, on its own port.

## `OMP_HUB_URL` and `OMP_HUB_HOST_TOKEN`

`OMP_HUB_URL` is **this server**. `bin/omp-host` uses it to register a
host and broker Collab session links; the `omp-connected` extension
uses the same two variables, set in every interactive OMP terminal, to
register that session's native agent-messaging identity over
`/ws/agent`. Both require `OMP_HUB_HOST_TOKEN` to match what this
server is configured with; the extension is a graceful no-op when
either variable is unset.

This project has no coupling of any kind to claude-net — no source
dependency, and no runtime/network dependency either. Agent-to-agent
messaging used to be deferred to a separate claude-net hub; it is now
implemented natively by this server (`AgentRegistry`, `/ws/agent`) with
no such coupling remaining anywhere in this repo.

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