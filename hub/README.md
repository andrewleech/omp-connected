# omp-hub

Standalone OMP Collab fleet dashboard, host broker, and private relay —
see [ARCHITECTURE.md](./ARCHITECTURE.md) for the full module layout,
wire protocol, and security model.

## What this is

- The `omp-connected` extension ([`../extension/`](../extension/))
  registers each OMP session with this server over
  `/ws/agent`, giving it a native, hub-stamped agent-to-agent messaging
  identity — see [ARCHITECTURE.md](./ARCHITECTURE.md) for the wire
  protocol.
- That same connection is also how this server reaches host-level Collab
  discovery: `collab.list`/`collab.link` calls are forwarded to whichever
  agent connection is currently live for a hostId and answered in-process
  from OMP's `omp collab list|link --json` implementation — there is no
  separate host-registration process or connection.
- The server exposes both over REST (`/api/hosts/:id/collab`,
  `/api/hosts/:id/collab/:instanceId/link`, `/api/agents`,
  `/api/agents/:id/send`) and serves a small fleet dashboard webui at
  `/` plus the vendored OMP Collab guest client at `/collab/`.
- A private relay (`src/relay/relay.ts`) carries the actual encrypted
  Collab terminal bytes between a host and its guests. It runs in the hub
  process on its own port when `OMP_HUB_RELAY_PORT` is set.

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
  `dist/webui/`, along with the PWA files (manifest, icons, offline page,
  service worker).
- `build:collab`: installs the dependencies of the pinned upstream Collab guest (`vendor/collab-web`, from its lockfile) and builds it into `dist/webui/collab/`. Initialise the submodule first with `git submodule update --init --depth 1 vendor/collab-web`, or set `COLLAB_WEB_SRC` to another OMP checkout's `packages/collab-web`. See `scripts/build-vendor-collab.sh` for details.

### Installing as an app (PWA)

The dashboard is an installable web app: Chrome on Android offers **Add to
Home screen → Install** (desktop Chrome shows the install icon in the
address bar). It needs the hub's valid HTTPS certificate. On Android the
phone needs internet access at install time so Google can mint the WebAPK;
`about://webapks` on the phone lists it when that worked (otherwise you get
a plain shortcut).

Install it from its own hostname, `https://ompc.your-tailnet.ts.net` (see
`omp-hub-ts.service` below), not `hub-host…:4816`. A WebAPK registers with
Android by scheme, host and path only, so any installed web app scoped to
`/` on the same host claims every port there, and Chrome then treats the
dashboard as already installed (Paseo on `hub-host:443` does exactly this).

The service worker only handles top-level page loads: when the hub can't be
reached (device off the tailnet, hub stopped) it shows a cached "can't
reach the hub" page instead of the browser error. Everything else, including
the API, WebSockets and the Collab frame, always goes to the network.

App icons are rendered from `src/webui/icon.svg`; after editing it, run
`bun run scripts/render-icons.ts` and commit the regenerated PNGs.

## Deploying

Deploy units live in [`deploy/`](./deploy):

- `omp-hub.service` — the hub server and its Collab relay listener.
  Orders after `tailscaled.service` and blocks on `tailscale ip -4` before
  starting, so it never races Tailscale interface readiness at boot (the
  root cause of a real outage this design fixes — see ARCHITECTURE.md).
- `omp-hub-cert-renew.service` / `.timer` — weekly Tailscale cert renewal,
  restarting the service above.
- `omp-hub-ts.service` — a second, unprivileged `tailscaled`
  (userspace networking) that joins the tailnet as node `ompc`, giving the
  dashboard the hostname `ompc.<tailnet>.ts.net` for installing as an app.
  `tailscale serve` on that node terminates TLS and proxies to the hub's
  existing listener. Agents keep using `hub-host…:4816`. Tailscale Services
  would give the same name without a second node, but its hosts have to be
  tagged devices.

Copy `deploy/omp-hub.env.example` → `~/.config/omp-hub/omp-hub.env`,
fill in a real `OMP_HUB_HOST_TOKEN`, TLS cert paths, and relay settings,
then:

```sh
systemctl --user enable --now omp-hub.service
systemctl --user enable --now omp-hub-cert-renew.timer
```

One-off setup for the `ompc` node (the login needs a browser approval; its
state then persists in `~/.local/state/omp-hub-ts`):

```sh
systemctl --user enable --now omp-hub-ts.service
ts="tailscale --socket=$XDG_RUNTIME_DIR/omp-hub-ts/tailscaled.sock"
$ts up --hostname=ompc --accept-dns=false
$ts serve --bg https://hub-host.your-tailnet.ts.net:4816
```

Disable key expiry for `ompc` in the admin console, or it drops off the
tailnet after the tailnet's key expiry period. `OMP_HUB_RELAY_ALLOWED_ORIGINS`
must include `https://ompc.<tailnet>.ts.net`.

Set `OMP_HUB_URL` and `OMP_HUB_HOST_TOKEN` in every interactive OMP
terminal to point it at this deployment.