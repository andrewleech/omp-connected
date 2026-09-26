<p align="center">
  <img src="../OMPC.png" alt="OMPC logo" width="128">
</p>

# omp-connected

`omp-connected` connects an interactive OMP session to omp-hub's native agent-messaging service. Inbound messages are stored as OMP custom agent messages, marked as untrusted, and delivered at the next agent-step boundary.

## Session launcher

Run `bin/ompc [session-suffix] [omp arguments...]` as the everyday entry point for interactive use: it creates a persistent OMP TUI inside a tmux session when no matching one exists, or reattaches to one when it does, forwarding any other arguments straight into the wrapped OMP process. By default, the session name is `basename "$PWD"`; supplying a suffix produces `basename "$PWD".<session-suffix>`.

When other live sessions extend the requested name (bare `ompc` matches `<dir>` and `<dir>.*`; `ompc feat` matches `<dir>.feat*`), an interactive `ompc` shows an arrow-key picker (↑/↓ or j/k, Enter, q/Esc) of those sessions with attached state and last activity. The highlighted default is the exact name, attaching or creating it. Without a terminal, with `-d`, or when the only live match is the exact name, it attaches or creates directly.

Each OMP session gets its own tmux server (`tmux -L <session-name>`), so `ps`, `top`, and `htop` attribute CPU and memory use to the individual OMP session, and one crashed server affects only its own session.

`ompc -d [session-suffix] [omp arguments...]` (or `--detach`) starts the session without attaching a terminal and prints the session name. If the session already exists, the name is printed and nothing new is created. This is useful for agents spawning side-quest sessions — a full new OMP session in its own working directory.

`ompc collab …` bypasses tmux entirely and runs OMP directly, so non-interactive Collab CLI commands work without a TUI.

The launcher uses its bundled tmux configuration (`bin/omp-tmux.conf`). It sets `allow-passthrough on` for OSC 52 clipboard, Kitty graphics, and OSC 9/99 notifications; `extended-keys on` with `csi-u` format for modified-key handling; `tmux-256color` terminal type; and bounded scrollback.

The launcher uses the global `omp` binary from PATH by default (the official installer places it at `~/.local/bin/omp`). Set `OMP_BIN` to use a different OMP executable.

## Hub registration

Set `OMP_HUB_URL` and `OMP_HUB_HOST_TOKEN` in every interactive OMP terminal before agent messaging becomes available. `ompc` sources them from `~/.config/omp-connected/omp-host.env` (or `$OMP_HOST_ENV`) on every launch; sessions started with plain `omp` need them exported from the shell. The extension is a graceful no-op when either is unset: no tools fail, agent registration simply never starts.

The extension registers automatically on `session_start`: it discovers this session's Collab instance ID by polling the local Collab registry (up to 10 seconds for the PID to appear), then registers with omp-hub over a WebSocket connection to `/ws/agent`. Registration retries with exponential backoff (1s–30s, jittered) on failure or disconnect.

Registration therefore requires a Collab host in the session (`collab.autoStart` set, `collab.relayUrl` pointing at the hub's relay). Without one, instance discovery times out, the extension logs `could not discover this session's Collab instanceId`, and the session never registers. See [Adding hosts to the fleet](../README.md#adding-hosts-to-the-fleet) for the full per-host setup.

The session's display label — shown by `ompc_list_agents`, accepted as a send address, and used for its card on the dashboard — is the `ompc` tmux session name (`<dir>` or `<dir>.<suffix>`, passed in as `OMPC_SESSION`). Sessions started with plain `omp` fall back to the working directory's basename. Labels need not be unique; an ambiguous label is rejected as a send address in favour of the canonical id.

The extension also handles `collab.list` and `collab.link` requests pushed by the hub server over the same WebSocket connection, answering them directly from the local Collab registry. This replaces the former `bin/omp-host` sidecar process — no separate host connector is needed.

It registers with `features: ["session.v1"]` and answers the hub's `session.*` and `files.*` requests for its own session: session info, model and thinking changes, compact and abort, and browsing, downloading and uploading files inside the session's working directory. Only `session.info` is answered when the session's Collab share is view-only, and file paths that resolve outside the working directory (including through symlinks) are refused. Sessions started before an update keep the old extension code, and the dashboard asks for a restart to enable these panels.

## Agent messaging trial

Start two OMP sessions with the same `OMP_HUB_URL`. Each registers automatically — no manual registration tool call. Inspect the current identity with `ompc_identity`. In the sender session, call `ompc_list_agents`, pick the receiver's canonical id, then call `ompc_send_message`. The receiver renders the incoming content as an untrusted agent message beginning `[from <identity> via omp-hub, untrusted agent message]`.

## Tools

| Tool | Approval | Purpose |
|---|---|---|
| `ompc_identity` | read | Return this session's current agent-messaging identity |
| `ompc_send_message` | write | Send a message to another agent by id or label |
| `ompc_send_team` | write | Broadcast to a team |
| `ompc_join_team` | write | Join a team |
| `ompc_leave_team` | write | Leave a team |
| `ompc_list_agents` | read | List all registered agents |
| `ompc_list_teams` | read | List all teams and members |
| `ompc_mailbox` | read | Fetch recent messages for an agent |
| `ompc_events` | read | Query hub events |