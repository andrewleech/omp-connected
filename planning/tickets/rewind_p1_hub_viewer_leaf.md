# Hub view-mode viewer: show the host's active branch

Phase: 1
Depends on: rewind_p1_host_leaf (for the wire contract; can be written against it before the fork lands)
Written: 2026-09-30 at omp-connected 66a1466ed9
Revalidated: pending

## Context
The dashboard's view mode uses this repo's own `CollabTailViewer`, not collab-web (`hub/src/webui/app.ts:393-411`). It has the same B1/B2 problem: it appends entries in arrival order and renders them.

This is the only ticket in the track that changes omp-connected.

## Scope
In scope: `hub/src/webui/lib/collab-tail.ts` applying design R1, R5 and R6.

Out of scope:
- replacing the viewer with read-only collab-web (design Q6);
- control mode, which is collab-web in the iframe.

## Files and anchors
- `hub/src/webui/lib/collab-tail.ts`:
  - `:14` `COLLAB_PROTO = 3`;
  - `:17-19` `INITIAL_TAIL`/`PAGE_SIZE`;
  - `:667-715` `#handleFrame` (`welcome`, `snapshot-chunk`, which keeps at most `MAX_BUFFERED * 1.5` entries, and `entry`, which appends a rendered row when the snapshot is done);
  - `#renderTail` (a full re-render).
- `hub/tests/webui/`: existing bun unit tests for webui libs.

## Design constraints
- Same rule as collab-web:
  - entries are stored by id, and the leaf follows `entry`, `leaf` and `welcome.leafId`;
  - the rendered list is the walk from the leaf;
  - a leaf that isn't held reconnects the viewer (`destroy` + `connect`), since the buffer is trimmed from the front.
- Keep the incremental append for an `entry` whose parent is the current leaf. Anything else re-renders with `#renderTail`.
- It's view only, so there's no rewind UI.

## Acceptance criteria and tests
- A unit test feeds decrypted frames for B1 and asserts the rendered entry ids.
- With an old host (no `leafId`), the display is unchanged for an unbranched session.
- Live: after a host esc-esc, the hub in view mode on a phone viewport shows the rewound conversation without reselecting the session.
- Scrub greps from AGENTS.md are clean before any push.

## Workflow shape
One sonnet implementer and one opus review. Small change.

## Open questions
Q6 in the design.
