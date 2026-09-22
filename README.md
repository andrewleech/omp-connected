<p align="center">
  <img src="OMPC.png" alt="OMPC logo" width="128">
</p>

# omp-connected

Fleet presence, agent-to-agent messaging, and a browser dashboard for
[Oh My Pi](https://github.com/can1357/oh-my-pi) sessions.

Two components, one repo:

| Component | Path | What it does |
|---|---|---|
| **Extension** | `extension/` | OMP plugin — registers each session with the hub, handles Collab discovery, provides agent-messaging tools |
| **Hub** | `hub/` | Always-on Bun server — fleet dashboard, agent registry, Collab link broker, and private relay |

## What it looks like

1. Launch an OMP session with `ompc` (the bundled session launcher).
2. The extension auto-registers the session with the hub over WebSocket.
3. Open the hub's dashboard in a browser to see all active sessions.
4. Click a session to view its live terminal output via Collab.
5. Send messages between sessions using the `ompc_send_message` tool.

## Prerequisites

- [OMP](https://github.com/can1357/oh-my-pi) (the official CLI)
- [Bun](https://bun.sh) (runtime for the hub server)
- [tmux](https://github.com/tmux/tmux) (session persistence for `ompc`)

```sh
# Install OMP (official installer)
curl -fsSL https://omp.sh/install | sh

# Install Bun
curl -fsSL https://bun.sh/install | bash
```

## Install

### 1. Clone

```sh
git clone https://github.com/alelec/omp-connected.git ~/omp-connected
```

### 2. Install the extension

Link the extension as an OMP plugin:

```sh
omp plugin link ~/omp-connected/extension
```

Verify it appears in `omp plugin list`.

### 3. Deploy the hub

Install dependencies and build the dashboard:

```sh
cd ~/omp-connected/hub
bun install
bun run scripts/build-webui.ts
```

Generate a shared secret for agent registration:

```sh
openssl rand -hex 32
```

Create the environment file:

```sh
mkdir -p ~/.config/omp-hub
cat > ~/.config/omp-hub/omp-hub.env << 'EOF'
OMP_HUB_PORT=4816
OMP_HUB_HOST=127.0.0.1
OMP_HUB_HOST_TOKEN=<paste-your-secret-here>

# TLS (required for non-localhost access)
# OMP_HUB_TLS_CERT=/path/to/cert.pem
# OMP_HUB_TLS_KEY=/path/to/key.pem
EOF
```

**Test it manually first:**

```sh
source ~/.config/omp-hub/omp-hub.env && bun run hub/src/server/index.ts
```

Then visit `https://<host>:<port>/health`.

**Install as a systemd user service:**

```sh
cp ~/omp-connected/hub/deploy/omp-hub.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now omp-hub.service
```

### 4. Configure OMP sessions

Every OMP session needs two environment variables to register with the hub.
Add to your shell profile (`.bashrc`, `.zshrc`, etc.):

```sh
export OMP_HUB_URL=https://<your-hub-host>:<port>
export OMP_HUB_HOST_TOKEN=<same-secret-as-hub>
```

The extension is a graceful no-op when either is unset.

### 5. Use the session launcher

`ompc` is the everyday entry point. It wraps each OMP session in its own
tmux server for persistence and reattach:

```sh
# Start or reattach to a session (named after the current directory)
~/omp-connected/extension/bin/ompc

# With a suffix
~/omp-connected/extension/bin/ompc feature-branch

# Detached (for background/agent-spawned sessions)
~/omp-connected/extension/bin/ompc -d worker
```

Add `~/omp-connected/extension/bin` to your `PATH` for convenience.

## Collab relay

The hub process also runs a private Collab relay that routes encrypted
session traffic between hosts and browser/terminal guests. It listens on its
own port, shares the hub's bind address and TLS certificate, and starts when
`OMP_HUB_RELAY_PORT` is set in `omp-hub.env`:

```sh
OMP_HUB_RELAY_PORT=7466
# Browser origins allowed to open relay WebSockets (comma-separated)
OMP_HUB_RELAY_ALLOWED_ORIGINS=https://<hub-host>:4816
```

Configure OMP to use your relay:

```
# In OMP settings
collab.relayUrl = wss://<your-relay-host>:7466
```

## OMP settings

| Setting | Value | Purpose |
|---|---|---|
| `collab.relayUrl` | `wss://<relay-host>:7466` | Your private relay |
| `collab.autoStart` | `control` | Auto-host a Collab room for every session |
| `collab.displayName` | Your name | Shown to Collab guests |

`collab.autoStart: control` creates bearer capability links that permit
prompting and interruption. Enable only after your hub and relay are
access-controlled.

## Agent messaging

Once two sessions are registered with the same hub, they can exchange messages:

| Tool | Purpose |
|---|---|
| `ompc_identity` | Show this session's agent identity |
| `ompc_list_agents` | List all registered agents |
| `ompc_send_message` | Send a message to another agent |
| `ompc_send_team` | Broadcast to a team |
| `ompc_join_team` / `ompc_leave_team` | Manage team membership |
| `ompc_mailbox` | Fetch recent messages |
| `ompc_events` | Query hub events |

## TLS

Non-localhost deployments require TLS. If you're on a Tailscale network:

```sh
mkdir -p ~/.config/omp-hub/certs
tailscale cert --cert-file ~/.config/omp-hub/certs/cert.pem \
               --key-file ~/.config/omp-hub/certs/key.pem \
               $(tailscale cert)
```

Set `OMP_HUB_TLS_CERT` and `OMP_HUB_TLS_KEY` in both env files, then use the
cert renewal timer for automated rotation:

```sh
cp ~/omp-connected/hub/deploy/omp-hub-cert-renew.{service,timer} ~/.config/systemd/user/
systemctl --user enable --now omp-hub-cert-renew.timer
```

## Development

```sh
cd ~/omp-connected/hub
bun install
bun test                          # 75 tests
bun run scripts/build-webui.ts    # rebuild dashboard
```

## Architecture

See [hub/ARCHITECTURE.md](hub/ARCHITECTURE.md) for the full wire protocol,
security model, and module layout. See
[extension/ARCHITECTURE.md](extension/ARCHITECTURE.md) for the extension's
registration and Collab handling.

## Security model

- **Shared-secret registration.** A single fleet-wide token
  (`OMP_HUB_HOST_TOKEN`) gates agent registration. It authenticates "some
  session in the fleet," not a specific identity — the extension's claimed
  `hostId`/`instanceId` is accepted at face value.
- **Capability URLs.** Collab links are short-TTL bearer capabilities. The room
  key lives only in the URL fragment (never sent to a server in an HTTP
  request). The hub never logs the links it brokers.
- **The relay is content-blind.** It forwards encrypted binary frames between
  host and guests. It cannot read session content.

## License

[MIT](LICENSE)
