# Design: web terminal attached to a session's tmux

Date: 2026-10-31
HEAD: bc7ab5140a
Status: implemented and deployed (commits `0534347`, `1a5e59b` and the Session tab layout change). The Terminal action is the **Open terminal** button in the Session tab's Tools section. Phase 0 findings below replace the original assumptions.

## Summary

The dashboard shows a Terminal action for control-shared sessions advertising `terminal.v1`. It connects xterm.js to `tmux -L <OMPC_SESSION> attach-session` on the host. When a direct TLS endpoint is available, the browser tries it first; otherwise it uses the hub relay.

- The extension starts a PTY with `Bun.spawn` and attaches tmux using the registered `OMPC_SESSION` name.
- The hub issues a random, short-lived relay capability over trusted agent RPC. When direct TLS is available, the extension returns a separate direct ticket in the same single-use capability group. Neither ticket is signed with the shared registration token.
- If both direct and relay connection attempts fail, the browser requests a new endpoint and retries the relay with its new ticket.
- The browser loads terminal packages with dynamic imports when opening the terminal.
- PTY output callbacks cannot be paused. The extension bounds queued output and closes the connection if the queue exceeds its limit.

## Phase 0 - Verified findings

- The runtime's `Bun.spawn` supports the `terminal` option used by the extension; no helper binary is required.
- The extension invokes `tailscale status --json` and `tailscale cert` to find the host's MagicDNS name and obtain a certificate. It checks the certificate hostname and expiry before advertising the direct URL. This is automatic detection, not a verified fleet-wide availability claim.
- The terminal attaches with `tmux -L <socket> attach-session`; it does not pass `-f ignore-size`. tmux applies its normal attached-client sizing behavior.
- Bun's PTY callback does not provide a way to pause PTY reads. The service queues output, applies bounded output and websocket buffering, and closes on overflow; it does not use PTY pause/resume flow control.
- The hub has no dashboard authentication. Terminal HTTP requests and hub client websocket upgrades accept the configured public origin, the request's own origin when no public origin is configured, or configured allowed origins. The terminal request also requires a Collab control share. These checks are not user authentication.
- The hub creates a random relay ticket and sends it to the extension with `terminal.open`. If direct TLS is available, the extension creates a distinct direct ticket in the same single-use capability group. The hub ticket expires after 30 seconds; the extension keeps the ticket group locally for up to 35 seconds. These tickets are not HMAC tickets and do not use `OMP_HUB_HOST_TOKEN` as a signing key.
- The browser dynamically imports xterm.js, Fit, and Unicode 11 on terminal open.
- The terminal route has its own per-agent request limiter.

## Constraints

- Sessions on remote hosts connect outbound to the hub over `/ws/agent`; terminal setup is requested on that connection.
- A session without a tmux-backed `OMPC_SESSION` does not advertise `terminal.v1`.
- A browser page can use the direct route only when the host obtains a TLS certificate trusted by that browser; otherwise it uses the hub relay.
- The hub does not authenticate dashboard users. Same-origin checks and Collab control access do not establish a user identity.


The browser blocks insecure websocket connections from an HTTPS page. A direct connection therefore needs a browser-trusted TLS certificate. The hub has no dashboard authentication; the same-origin check and the session's Collab control access are not user authentication.

## Design

### Capability registration

The extension advertises `terminal.v1` only when `OMPC_SESSION` is set. The dashboard shows the Terminal action only for sessions with this feature and control access. A direct URL and a distinct direct ticket are returned in the response to `POST /api/agents/:id/terminal` only when a direct TLS listener is available; neither is part of agent registration.

### Wire protocol

One websocket per terminal, binary frames, first byte is the type. Both routes carry the same frames.

| Type | Direction | Body |
|---|---|---|
| `0x00` hello | peers | browser and relay host send protocol version and their route ticket; hub or direct host replies with version and status |
| `0x01` out | host to browser | raw pty bytes |
| `0x02` in | browser to host | raw key bytes |
| `0x03` resize | browser to host | cols, rows (u16 each) |
| `0x04` ack | browser to host | bytes processed since last ack (u32) |
| `0x05` exit | host to browser | exit code (i16); tmux ended or detached |

Compression:
- permessage-deflate is enabled on hub relay and direct listener websockets.
- The extension coalesces PTY reads on a 12 ms timer, and sends frames up to 16 KiB. xterm.js acknowledges output in 32 KiB batches.

Flow control:
- PTY callbacks cannot pause reads. The extension bounds queued output to 1 MiB and closes when it exceeds that limit. It limits unacknowledged output to 128 KiB and checks websocket buffering before sending.
- The hub bounds websocket buffering and closes sockets on overflow.
- Reconnect is manual. A new tmux attachment redraws the current screen; there is no replay buffer.

### Capability and access checks

- The browser posts to `/api/agents/<id>/terminal`. The route accepts the configured public origin, the request's own origin when no public origin is configured, or a configured allowed origin. It checks that the target session has Collab control access.
- The hub has no dashboard authentication. The request does not identify or authenticate a user.
- The hub creates a random 32-byte base64url relay ticket, stores it with the target agent and a 30-second expiry, then sends it to the extension through `terminal.open` on `/ws/agent`.
- When direct TLS is available, the extension returns a separate direct ticket in the same capability group. Claiming either ticket consumes the group.
- The capability group expires locally after 35 seconds. The tickets are not signed with `OMP_HUB_HOST_TOKEN`. The hub does not log terminal user identities, durations or byte counts.
- The route limits requests to 20 per 10 seconds and four active terminals per agent.

1. The hub sends `terminal.open {ticket, relayUrl}` to the extension over the existing agent websocket.
2. The extension dials `relayUrl` (`/ws/terminal/host`).
3. The browser connects to `/ws/terminal/client` with the relay ticket.
4. The hub pairs the client and host sockets by relay ticket and relays binary frames. It closes connections when websocket backpressure exceeds its configured limit.

Each terminal uses separate websockets, not the `/ws/agent` socket, for PTY traffic.

### Direct route (optional)

The extension starts direct TLS setup when its terminal service starts. It reads `Self.DNSName` from `tailscale status --json`, asks `tailscale cert` to issue certificate and key files in a temporary directory, and validates the certificate hostname and expiry. A terminal request retries setup if needed but does not wait for an in-progress attempt; it includes a direct URL and ticket only if the listener is already available. Certificate renewal is attempted every 24 hours.

The direct websocket accepts the hub origin or a client origin associated with an unexpired terminal capability. The browser tries the direct URL with a 1.5-second timeout and a separate direct ticket. If direct fails, it tries the original relay ticket; if that fails, it requests a new endpoint and tries relay again. Claiming either direct or relay ticket consumes both tickets in their capability group.

### Extension and hub

The extension service is created for sessions with `OMPC_SESSION`. On `terminal.open`, it stores the relay ticket for up to 35 seconds, opens the relay websocket, and returns an optional direct URL and separate ticket. It starts a `Bun.spawn` PTY for `tmux -L <name> attach-session` when a route claims a ticket. The PTY closes when its websocket ends; tmux remains running.


### Web UI

The browser dynamically imports `@xterm/xterm`, `@xterm/addon-fit`, and `@xterm/addon-unicode11` when opening the terminal. It opens a terminal dialog with a mobile key bar, sends resize and input frames, and acknowledges output after xterm.js processes it. On disconnect, it offers manual reconnect; it does not reconnect automatically.

## Planned validation

- Unit and integration coverage: frame handling, capability expiry/claim, PTY output buffering, relay pairing, and terminal input/resize.
- Browser coverage: control-and-feature-gated action, open/close, direct-first connection, relay fallback with the original relay ticket, and retrying relay with a fresh endpoint ticket if that fails.

## Phases

0. **Assumption review - complete.** Confirmed Bun PTY support; documented capability and same-origin checks, bounded PTY output, and automatic optional direct TLS behavior. A fleet-wide Tailscale certificate availability survey was not performed; direct TLS remains opportunistic and relay is the fallback.
1. **Relay and browser terminal - implementation in progress.** Implement the extension PTY service, hub capability and relay routes, UI, and tests.
2. **Direct TLS route - implementation in progress.** Attempt Tailscale certificate acquisition, offer direct websocket service when available, and retain relay fallback.
3. **Documentation and field checks.** Document behavior and validate relay/direct use where available.

## Phase 0 decisions

- Bun's PTY `terminal` option is used; no PTY helper is required.
- PTY reads are not paused. Output is buffered within configured bounds, and the connection closes on overflow.
- The implementation uses normal tmux client sizing; it does not use `attach-session -f ignore-size`.
- Read-only terminal access is not implemented. Opening a terminal requires Collab control access.
- Direct TLS availability is not assumed across hosts. The extension attempts Tailscale status and certificate issuance, and only returns a direct URL when it can start the TLS listener.
