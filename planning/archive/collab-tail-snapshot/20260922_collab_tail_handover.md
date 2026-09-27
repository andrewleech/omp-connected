# Collab Tail Viewer — Big-Session Loading on Mobile: Handover

Origin note (2026-09-22, written in a harness session before this planning folder existed). It describes the problem that started the tail-first work, as seen from the hub's own `collab-tail.ts` viewer. Its `~/omp-hub/src/...` paths correspond to `hub/src/...` in this repo.

## Problem

The `CollabTailViewer` in `~/omp-hub/src/webui/lib/collab-tail.ts` cannot reliably load big sessions (~3700+ entries) on a mobile phone over wifi via Tailscale. Messages stop arriving silently — no WebSocket close event, no error event, no console errors. The entry counter freezes mid-load and never resumes. A 2-second watchdog eventually fires and renders partial content, but:

1. The partial content is the **oldest** entries (useless — user wants the newest)
2. The user has already been staring at a frozen counter before the watchdog fires
3. Recovery doesn't work — once messages stop, they don't resume

## Architecture

```
Phone (Safari/Chrome)
  ↕ wifi → Tailscale VPN
omp-hub dashboard (hub-host.your-tailnet.ts.net:4816)
  → POST /api/hosts/:id/collab/:instanceId/link → gets a capability URL
  → CollabTailViewer opens WebSocket to relay (hub-host.your-tailnet.ts.net:7466)
omp-hub-relay (port 7466) — content-blind relay
  ↕ binary frames with 4-byte peer-ID envelope
OMP CLI host (same machine) — the Collab host
  → sends snapshot-chunk frames (oldest entries first, chronological order)
  → sends { final: true } on the last chunk
  → then sends live `entry` frames as the session progresses
```

### Data path detail
- **Dashboard** (`src/webui/app.ts` line ~288-312) POSTs to the broker to get a collab link URL
- **Broker** (`src/server/collab-rpc-routes.ts`) forwards the request via JSON-RPC to the OMP CLI agent connection, gets back a signed URL
- **CollabTailViewer** (`src/webui/lib/collab-tail.ts`) opens a WebSocket directly to the relay as `?role=guest`
- **Relay** (`src/relay/relay.ts`) is a dumb binary forwarder — host sends envelope-wrapped encrypted frames, relay forwards to guests. Relay has `idleTimeout: 120` and `maxPayloadLength: 1MB`
- **OMP CLI host** (upstream, not our code) generates snapshot chunks. The Collab protocol version is 3. Chunks are sent chronologically (oldest first). Each chunk is an AES-GCM-encrypted binary frame containing `{ t: "snapshot-chunk", entries: [...], final?: true }`

### Encryption
Every frame is AES-256-GCM encrypted. The room key is embedded in the collab link URL fragment (never touches the server). Decryption uses the Web Crypto API (`crypto.subtle.decrypt`).

## What's been tried and why it failed

### 1. Serial promise queue (original)
Each WebSocket `message` event handler chained `.then()` onto a single promise. If any `crypto.subtle.decrypt()` call hung (which happened on mobile), every subsequent message was blocked forever — the counter stopped.

**Removed in** `5270a56`.

### 2. Parallel decryption with 5s per-frame timeout
Each message decrypts independently. A `#pendingDecrypts` counter tracks in-flight operations. 5-second `Promise.race` timeout per decrypt. This eliminated the single-hung-decrypt-blocks-everything bug.

**Problem**: messages themselves stop arriving at the WebSocket `message` event handler. This isn't a decrypt issue — the browser stops delivering events. No close, no error, just silence.

### 3. Progressive rendering (render on every chunk)
Re-rendered the DOM every 300ms as chunks arrived.

**Rejected by user**: made mobile even slower, and since entries arrive oldest-first, the user sees old content from days ago scrolling in, not the current conversation.

### 4. Watchdog timer (current state, 2s)
After 2 seconds of no new `snapshot-chunk` frames, renders whatever entries have accumulated. Keeps the WebSocket open so if messages resume, the watchdog re-arms and updates the view on the next pause.

**Current problem**: 
- The rendered content is the **tail of what arrived so far**, but since entries arrive oldest-first, the "tail" is still old content — nowhere near the current conversation
- The user doesn't want to watch old messages and wait; they want to see the most recent conversation immediately
- Once the stall happens, messages rarely resume in practice

## The fundamental constraint

**The OMP CLI host sends snapshot entries oldest-first.** We don't control this — it's the upstream Collab protocol. There is no "give me the last 80 entries" request. You either receive the full snapshot chronologically or you don't.

The relay (`src/relay/relay.ts`) is content-blind — it forwards encrypted binary blobs. It doesn't buffer, reorder, or cache. omp-hub's broker only handles link generation; it doesn't sit in the WebSocket data path.

## Current code state

**File**: `~/omp-hub/src/webui/lib/collab-tail.ts` (761 lines)
**Hash**: `app.28p4hz4y.js` (deployed)
**Commit**: `576fd19` on `main`

Key constants:
- `INITIAL_TAIL = 80` — show last 80 entries
- `PAGE_SIZE = 40` — scroll-back page size  
- `MAX_BUFFERED = 880` — max entries in memory
- Watchdog: 2000ms timeout
- Per-decrypt timeout: 5000ms via Promise.race

Key state:
- `#allEntries: SessionEntry[]` — accumulated entries (oldest-first as received)
- `#totalReceived: number` — count
- `#snapshotDone: boolean` — true when final chunk processed or watchdog fires
- `#finalSeen: boolean` — true when `{ final: true }` chunk arrives
- `#pendingDecrypts: number` — in-flight decrypt operations

Flow:
1. `connect(link)` → parse link → open WebSocket to relay
2. WebSocket `message` → `#processMessage()` → decrypt → `#handleFrame()`
3. `snapshot-chunk` → push entries to `#allEntries`, bump counter, reset watchdog
4. When `#finalSeen && #pendingDecrypts === 0` → `#checkSnapshotComplete()` → `#renderTail()`
5. Watchdog (2s no chunks) → `#renderTail()` (keeps connection open, re-arms if more arrive)
6. `#renderTail()` renders last `INITIAL_TAIL` entries from `#allEntries`

## Options to explore

### A. Proxy layer in omp-hub that buffers and reverses
Add a WebSocket proxy in omp-hub between the dashboard and the relay. The proxy connects to the relay as a persistent guest, receives the full snapshot, buffers it, and serves the dashboard client newest-first (or just the tail). This means the heavy transfer happens server-to-server on localhost, and the mobile client only gets the last N entries over the slow link.

**Tradeoff**: adds complexity, another WebSocket hop, needs to handle reconnection and multiple dashboard clients. But it's the only way to serve newest-first without patching upstream.

**Implementation sketch**: 
- New route or WebSocket endpoint on omp-hub (port 4816)
- On dashboard request: if no cached snapshot, connect to relay, buffer all entries, then serve just the tail to the client
- Could cache the snapshot in memory keyed by room ID, invalidate on disconnect
- Serve live `entry` frames in real-time after the tail snapshot

### B. Optimistic tail render
Don't wait for the snapshot to complete. Connect, skip the snapshot entirely, and only render live `entry` frames going forward. Show a message like "Showing live updates only — loading history in background." 

**Tradeoff**: the user sees new content immediately but has no scroll-back until the background load completes (if it ever does). Requires understanding whether the Collab protocol sends live entries concurrently with snapshot chunks (likely yes — need to verify).

### C. Server-side snapshot cache
Have omp-hub maintain a persistent Collab guest connection per active session. Cache the full decrypted transcript server-side. Serve the dashboard a simple REST endpoint (`GET /api/session/:id/tail?last=80`) with the most recent entries as JSON. The dashboard doesn't need WebSocket for the initial load at all — just fetch the tail via HTTP, then open a WebSocket for live updates only.

**Tradeoff**: omp-hub needs the room key (security concern — currently only the browser has it). Much simpler client code. Could serve the cached tail to any number of dashboard clients without each one independently downloading the full snapshot.

### D. Chunked HTTP streaming (SSE) from a caching proxy
Similar to C but uses Server-Sent Events. The proxy buffers the full snapshot on the server, then streams only the tail to the client via SSE (newest-first). Falls back to WebSocket for live updates.

### E. Reduce what's sent
If the OMP CLI can be configured to limit snapshot size (e.g., last N entries only), that solves everything. Check if there's a `snapshot_limit` or similar option in the Collab protocol or OMP CLI config.

## Environment

- **Server**: `hub-host.your-tailnet.ts.net` (Intel i7-7700HQ, Ubuntu 24.04)
- **Runtime**: Bun
- **Services**: `omp-hub.service` (port 4816, TLS), `omp-hub-relay.service` (port 7466, TLS)
- **Client**: Mobile phone, Safari/Chrome, wifi, Tailscale VPN
- **TLS certs**: `~/.config/omp-hub/certs/`
- **Tests**: 75/75 passing (`bun test`)

## Files to read

| File | What it does |
|------|-------------|
| `~/omp-hub/src/webui/lib/collab-tail.ts` | The tail viewer (761 lines) — the component that needs fixing |
| `~/omp-hub/src/relay/relay.ts` | Content-blind WebSocket relay (263 lines) |
| `~/omp-hub/src/server/collab-rpc-routes.ts` | Broker that gets collab links from OMP CLI (100 lines) |
| `~/omp-hub/src/webui/app.ts` | Dashboard shell — instantiates CollabTailViewer (lines 288-312) |
| `~/omp-hub/src/webui/lib/collab-link.ts` | Utility: rewrites collab URL for iframe mode |
| `~/omp-hub/src/webui/index.html` | All CSS including `.tail-viewer`, `.tail-scroll`, `.tail-entry` styles |
| `~/omp-hub/src/server/index.ts` | HTTP/WebSocket server entry point |
| `~/omp-hub/src/server/agent-registry.ts` | Agent/host connection management, JSON-RPC dispatch |

## User preferences (non-negotiable)

- Mobile phone over wifi via Tailscale is the **primary** access method — performance there is what matters
- No progressive rendering (DOM re-rendering on every chunk) — it was tried and made things worse
- User wants to see the **most recent** conversation content, not old history
- No unilateral design decisions — surface options to the user before implementing
- The solution must not require patching the OMP CLI source
