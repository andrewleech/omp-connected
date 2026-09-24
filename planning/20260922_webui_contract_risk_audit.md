# WebUI contract and risk audit

Date: 2026-09-22
HEAD: ea1ccb0695

## Contracts to preserve

- The broker validates `instanceId`, `generation`, and `access`; browser must reject a mismatched access response (`hub/src/server/collab-rpc-routes.ts:47-100`, `hub/src/webui/app.ts:283-340`).
- A capability URL must become a same-origin `/collab/#fragment` iframe URL only. No outer-page history or storage may contain it (`hub/src/webui/lib/collab-link.ts:1-12`, tests in `hub/tests/webui/collab-link.test.ts`).
- A selected unchanged `(host, instanceId, generation, access)` retains its iframe node through refresh/poll (`workspaceSignature`, `hub/src/webui/lib/workspace.ts:193-207`; `app.ts:438-504`). Drawer toggles and active-bar metadata updates must not break this.
- The dashboard receives agent lifecycle events, while Collab session state remains polling-based. No new event protocol is needed for this work (`hub/src/server/types.ts:90-95`, `app.ts:698-747`).

## Current coverage and required proof

Existing tests cover pure workspace helpers, fragment handling, routes, and server lifecycle. They do not cover DOM selection/default access, iframe continuity, responsive drawers, touch/focus, or layout.

Add focused tests for: successful control broker forwarding; selecting a writable session requests control; a view-only session requests view without a failed control attempt; stale/mismatched access leaves truthful UI; same-session poll/drawer action retains iframe identity; active-bar status mapping; and workspace storage migration if visibility is persisted.

Manual browser acceptance must cover 320/360/390px portrait, rotation, Safari iOS/Chrome Android keyboard and safe areas, independent drawers, long press coexistence, active control continuity across a poll/socket refresh, view-only/stale-session errors, and keyboard/screen-reader focus order.

## Highest risks and mitigation

| Risk | Mitigation |
|---|---|
| `100vh` + fixed minima exceed visual viewport when keyboard/toolbars appear | Replace compact layout with dynamic viewport-aware active surface; validate on devices before shipping. |
| `viewport-fit=cover` without safe-area padding | Apply safe-area insets to top chrome and any edge bar/drawer. |
| Cross-document composer focus | Do not claim autofocus absent a versioned guest postMessage contract; a user click still yields a ready control composer. |
| Gesture conflict with long press/list scrolling | Edge-only swipe enhancement; visible controls/backdrop are the required interaction. |
| Status bar obscures content | Overlay only a dedicated active surface, reserve/measure clearance where needed, and verify tail/load-more plus guest composer remain usable. |

## Staged safety order

First lock selection/access and continuity contracts; then make writable selection control-first; add dashboard-owned status/mode bar using current metadata; replace compact stacking with independent drawers; finally harden visual viewport/safe area/focus and complete device validation. Guest-protocol work remains separate.
