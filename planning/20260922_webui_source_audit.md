# Hub WebUI source audit

Date: 2026-09-22
HEAD: ea1ccb0695

## Current implementation

- `hub/src/webui/index.html:21-38` is a fixed-height, three-column grid: session rail, workspace, and inspector. At <=900px the inspector moves below; at <=620px all three regions are stacked. The rail remains visible and consumes up to 35vh before the workspace.
- `hub/src/webui/app.ts:205-257` discovers hosts then polls each host’s Collab sessions every 15 seconds. It retains the same selected session across a poll so current session metadata can update without reconnecting.
- A card click reaches `selectSession()` (`app.ts:259-271,402-432`), clears the active surface, persists the selected key, then unconditionally calls `openCollab("view")`. This is the exact default that prevents prompt-ready interaction.
- `openCollab()` (`app.ts:283-340`) validates capability/access matching. View creates the tail-only viewer; control destroys that viewer and assigns the fragment-only capability to same-origin `/collab/` iframe. Control requires `session.access === "control"` via `canRequestAccess()` (`lib/workspace.ts:177-184`).
- `workspaceSignature()` (`lib/workspace.ts:193-207`) deliberately preserves an unchanged iframe because replacement drops its connection/transcript. Any layout or status-bar work must uphold this invariant.
- The existing workspace header provides title/access/hint (`app.ts:438-504`), but there is no floating status/control bar. The permanent inspector contains placeholder Controls/Files tabs and an agent-message compose UI (`app.ts:634-681`).
- Local storage stores only groups, selected session, and inspector tab (`lib/workspace.ts:67-137`); drawer state needs a separate explicitly versioned model if it is persisted.

## Constraints and risks

1. Server validates `generation` and requested `access` (`hub/src/server/collab-rpc-routes.ts:47-100`); a control-first default must fall back only for advertised view-only sessions, not issue invalid control requests.
2. `collabFrameUrl()` keeps bearer data in iframe fragment and out of outer history/storage (`lib/collab-link.ts:1-12`). New status/control UI must never persist or expose link URLs.
3. Parent/guest integration is limited to the guest’s `promote-request` postMessage (`app.ts:726-746`). Do not promise dashboard-owned stop, abort, or composer autofocus without a verified guest protocol.
4. Drawer swipes must coexist with session-card scroll/tap/550ms long press (`app.ts:107-160`). Use only edge-origin gestures; do not capture gestures over the list or iframe.
5. Current selection requests have no ordering token. A late capability response after rapid A→B selection could install stale content; the implementation plan must close this race before controls become persistent.

## Recommended seams

- Add selection/open state and request token near `createDashboard()` state.
- Extend local `CollabSession` with the already server-provided `relayConnected` and `inputRequired` fields before rendering them.
- Mount dashboard-owned active-session chrome in `renderWorkspace()` around a stable active-surface wrapper, updating its content without detaching the iframe.
- Model left and right drawer visibility independently from the inspector tab, with accessible triggers/focus lifecycle. Keep this state ephemeral unless a storage migration is explicitly justified.
