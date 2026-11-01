# Design: web terminal attached to a session's tmux

Date: 2026-10-31
HEAD: bc7ab5140a
Status: plan, no code written. Open questions 1 to 5 are settled in phase 0.

## Summary

Add a "Terminal" button to the session view in the dashboard. It opens an xterm.js window attached to the session's own tmux server, so the user gets the real omp TUI (`/settings`, dialogs, anything the Collab view does not show).

- Every `ompc` session already runs in its own tmux server (`tmux -L <name>`), and exports the name as `OMPC_SESSION`. The extension in the omp process knows the exact socket to attach to.
- The extension spawns `tmux -L <name> attach-session` on a pty and streams it over a websocket.
- One wire protocol, two routes. The browser connects directly to the host when it can, and through the hub relay when it cannot. The browser code and the extension code are the same for both.
- The stream uses permessage-deflate, output coalescing and credit-based flow control.
- On by default on every host. No per-host configuration. Authorisation is a short-lived ticket signed with the host token that every host already has.

## Constraints

- Sessions on remote hosts only connect outbound to the hub (`/ws/agent`). The hub cannot dial them.
- A session without `OMPC_SESSION` has no tmux. The button is hidden for those sessions.
- The dashboard is served over HTTPS, so the browser blocks plain `ws://` to a host (mixed content). A direct connection needs `wss://` with a certificate the browser trusts.
- A terminal gives no more access than the agent session on the same host already gives (the agent runs bash tools). It needs no extra gate beyond the existing dashboard authentication.

## Design

### Registration

The extension adds a `terminal` field to its registration message:

```
terminal: { tmuxSocket: string, direct?: { url: string } } | undefined
```

- `tmuxSocket` is the `OMPC_SESSION` value. It is absent when there is no tmux.
- `direct.url` is the `wss://` URL of the extension's own terminal listener, present only when the listener started and has a usable certificate (see "Direct route").
- The hub copies the field into the agent summary, and the dashboard shows the button when `terminal` exists.

### Wire protocol

One websocket per terminal, binary frames, first byte is the type. Both routes carry the same frames.

| Type | Direction | Body |
|---|---|---|
| `0x00` hello | both | protocol version, ticket (browser to host only) |
| `0x01` out | host to browser | raw pty bytes |
| `0x02` in | browser to host | raw key bytes |
| `0x03` resize | browser to host | cols, rows (u16 each) |
| `0x04` ack | browser to host | bytes processed since last ack (u32) |
| `0x05` exit | host to browser | exit code (i16); tmux ended or detached |

Compression:
- permessage-deflate with context takeover on every hop (browser to host, browser to hub, hub to host). Browsers negotiate it natively. Bun supports it on the server (`perMessageDeflate`); phase 0 checks the client side in omp's embedded Bun.
- The host coalesces pty reads into one `out` frame per 8 to 16 ms, or 16 KiB, whichever comes first. Larger frames compress better and cut per-frame overhead.
- No application-level compression layer. Browsers have no native zstd, and `CompressionStream` has no streaming dictionary reuse across frames, so it would do worse than context takeover.
- `in`, `resize` and `ack` frames are a few bytes each and are not worth compressing.

Flow control:
- The host stops reading the pty when unacknowledged bytes exceed 128 KiB. It resumes when they drop under 32 KiB.
- The browser sends `ack` from xterm.js's `write` callback, batched every 32 KiB. This keeps a runaway command from filling the websocket buffer and stalling input.
- Reconnect needs no replay buffer. Re-attaching to tmux makes tmux redraw the screen.

### Authorisation

- The browser asks the hub: `POST /api/agents/<id>/terminal`. This route is behind the same authentication as the other `/api` routes.
- The hub returns a ticket and the candidate routes. The ticket is `{agentId, instance, exp, nonce}` plus an HMAC-SHA256 signature. It expires after 30 seconds and works once per host process.
- The signing key is the host token (`OMP_HUB_HOST_TOKEN`) the host already uses to register, so the host can verify the ticket with no new configuration. The hub knows each host's token.
- A direct listener without a valid ticket closes the socket before it sends any terminal data.
- The hub logs open and close per terminal (agent, user, duration, bytes).
- Limit: four concurrent terminals per session. The existing `RateLimiter` covers the ticket route.

### Relay route (default path, works everywhere)

1. The hub sends `terminal.open {ticketId, relayUrl}` to the extension over the existing control websocket.
2. The extension dials `relayUrl` (`/ws/terminal/host`) outbound, and sends the ticket.
3. The browser connects to `/ws/terminal/client` on the hub with the same ticket.
4. The hub pairs the two sockets by ticket id and pipes frames both ways without parsing them. It applies backpressure per socket pair.

Each terminal has its own websocket. It is not multiplexed onto `/ws/agent`, so terminal output cannot delay control traffic, and backpressure applies per stream.

### Direct route (optional, auto-detected)

The extension starts one `Bun.serve` listener on an ephemeral port when the session starts, and registers `direct.url` if it can serve TLS.

- Certificate: the extension looks for a Tailscale certificate for the host's MagicDNS name (`tailscale cert`). If one is available and readable, it serves `wss://<host>.your-tailnet.ts.net:<port>`. If not, `direct` is absent and the session uses the relay. No configuration is needed in either case.
- The dashboard tries the direct URL first with a short timeout (1.5 s), then falls back to the relay with the same ticket (the host accepts one ticket per route attempt, so the ticket carries two nonces).
- The dashboard remembers the winning route per host for the page's lifetime to avoid repeating the failed attempt.
- The direct route removes the hub from the data path. Data flows browser to host only, so a terminal costs the hub nothing.

### Extension

New module `extension/src/terminal.ts`:
- Spawns `tmux -L <name> attach-session` on a pty (`Bun.spawn` with the `terminal` option if omp's embedded Bun has it; otherwise a pty helper, see question 1).
- Applies the frame protocol above, coalescing and flow control.
- Closes the pty on socket close. tmux keeps running, and only the web client detaches.
- Reports `exit` when tmux ends (omp exited).
- Uses `ignore-size` handling per question 3.

### Hub

- `hub/src/server/terminal-routes.ts`: the ticket route, the `/ws/terminal/client` and `/ws/terminal/host` upgrades, pairing and piping.
- `ws-agent.ts` and `types.ts`: the `terminal` registration field and the `terminal.open` message.

### Web UI

- `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl` (canvas fallback) and `@xterm/addon-unicode11`. They load with a dynamic import on the first click, so first page load stays the same size.
- A "Terminal" button in the session header, next to the existing actions. It opens a resizable window (modal on mobile). The window follows the dashboard theme.
- Fit on resize sends a `resize` frame.
- On mobile, a key bar (Esc, Tab, Ctrl, arrows, `|`, `~`) sits above the keyboard, since omp's TUI needs keys that phone keyboards lack.
- Disconnect shows a reconnect button. It does not reconnect on its own, so a closed window does not leave a terminal open on the host.

## Tests

- Unit: frame encode/decode, ticket sign/verify/expiry/replay, coalescing and watermark behaviour against a fake pty.
- Integration (extension, real hub process, real tmux): open a terminal on a `tmux -L test-<pid>` session, type, resize, compare screen content from `tmux capture-pane`, and check the relay path and direct path both work.
- E2E (Playwright, `fixture-server.ts`): button visibility with and without `terminal`, open/close, fallback from a failing direct URL to the relay.
- Measurement: replay a recorded omp session through the pty path and record bytes on the wire with and without deflate. The result goes in this document.
- Manual: one real fleet host over the relay route and one over the direct route; a phone over the tailnet.

## Phases

0. Revalidate assumptions (settles questions 1 to 5). No product code.
1. Relay route end to end: extension `terminal.ts`, hub routes, ticket, UI button and window, tests. This is the shippable default.
2. Direct route: listener, certificate detection, route race and fallback, tests.
3. Mobile key bar, documentation (`hub/ARCHITECTURE.md`, `extension/ARCHITECTURE.md`, `README.md`), measurements recorded.

## Open questions

1. Does omp's embedded Bun support `Bun.spawn` with `terminal` and a client-side `perMessageDeflate` websocket? If not, the choices are a small pty helper binary, or `script -qfc` (no resize support), or `python3 -c pty`. Check in phase 0 against the shipped fork binary.
2. Is the `tailscale cert` file readable by the user running omp on each host, and is HTTPS enabled on the tailnet? If not on most hosts, the direct route would rarely start and phase 2 is not worth building. Check every fleet host in phase 0. A per-host `tailscale set --operator` is configuration the user said to avoid.
3. Window sizing. tmux (3.7c here) defaults to `window-size latest`, so the web client resizes the window while it is the most recently active client and the real terminal gets squashed until the user types there. `attach-session -f ignore-size` avoids that, but then the web terminal shows the window at the other client's size. Decide which on real use; `omp-tmux.conf` sets neither today.
4. Should a read-only mode exist (`attach-session -r`)? Not needed for the stated goal; leave out unless asked.
5. Does tmux end when omp exits? If `ompc` keeps the tmux session open after omp exits, the `exit` frame needs the pane's dead status instead of the tmux process exit.

## Risks

- Two interactive clients on one pane (the real terminal and the browser) interleave keystrokes. This is normal tmux behaviour and is documented, not prevented.
- One listener per omp process on a tailnet-reachable port. Tickets and TLS limit access, but sessions that exit leave no listener behind only if the extension closes it on shutdown; the integration tests check for leaks.
- xterm.js on mobile has input quirks (IME, autocorrect, key repeat). The key bar covers the main gaps; expect fixes after field use.
