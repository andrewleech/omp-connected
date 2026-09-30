# collab-web: show the host's active branch

Phase: 1
Depends on: rewind_p1_host_leaf
Written: 2026-09-30 at upstream 81c851de5f (tail-mode anchors at abc0446c69)
Revalidated: pending

## Context
Design R1, R5 and R6, and bugs B1/B2. collab-web renders every received entry in arrival order, so abandoned branches stay on screen after a rewind (B1) and show up on a full-snapshot join (B2).

## Scope
In scope:
- `src/lib/client.ts`: the entry store, the leaf, and what's published as `entries`;
- handling `welcome.leafId` and `leaf`;
- the tail-mode rejoin hook-up (R6), only if PR #13389 is already in the base.

Out of scope: the rewind UI (phase 3).

## Files and anchors
- `src/lib/client.ts`:
  - `:110` `#entries`;
  - `:115` `#pendingSnapshot` (live entries buffered during a snapshot);
  - `:130` `#publishedEntries` cache;
  - `:302-333` `welcome`, `:334-355` `snapshot-chunk`, `:356-369` `entry`;
  - `:437-439` unknown frames are ignored;
  - `:553` snapshot `entries`.
- `src/components/transcript/Transcript.tsx:273-282`: renders `entries` with a tail window (`WINDOW`). `:343-354` scans entries for tool calls. Both keep working on the path.
- At abc0446c69 (PR #13389): `client.ts:156-157` `#rejoining`, `:359-366` `#sendHello` with `snapshot: { mode: "tail" }`, and `:640-660` the "stale" history reply that rejoins while the old transcript stays up.

## Design constraints
- **Store.** Keep entries by id (`Map`) plus `#leafId`.
  - `entry` stores the entry and sets `#leafId = entry.id`.
  - `leaf` sets `#leafId`. If the id is non-null and not held, rejoin (tail mode) or report an error notice (full mode, where that would be a host bug).
  - `welcome.leafId`, when present, is applied after the snapshot completes, followed by the buffered live frames in order.
- **Published `entries`** is the walk from `#leafId` back through `parentId`, reversed, stopping at the first id not held (the tail window edge) or a repeat.
  - Fast path: an `entry` whose `parentId` equals the old leaf is pushed onto a copy of the previous path, with no walk.
  - Full walk only on `leaf`, a snapshot finishing, or a history page.
- **Buffering.** `leaf` frames arriving during a snapshot are buffered with the live entries (`#pendingSnapshot.live` becomes a list of frames, not entries), so order is kept.
- **Old hosts.** No `welcome.leafId` and no `leaf` frames: the leaf is the last received entry. For a full snapshot of a branched session that's the same as the host's file-order leaf. That's today's display, minus off-branch entries.
- **History pages** (tail mode) prepend entries that connect to the current path's first entry. Recompute the walk after a page lands.

## Approach
1. Replace the array store with map plus leaf, and publish the walk.
2. Handle `leaf` and `welcome.leafId`, including snapshot buffering.
3. With #13389 in the base, rejoin on a missing leaf through `#rejoining`/`#sendHello`.
4. Flip the phase 0 collab-web test.

## Acceptance criteria and tests (`test/client.test.ts`)
- Host frames for B1 (five entries, a `leaf` back to assistant A, a new user C): published entries are `[userA, assistantA, userC]`.
- A full snapshot containing an abandoned branch, with `welcome.leafId`: only the active branch is published (B2).
- `leaf: null` publishes an empty transcript.
- A `leaf` during the snapshot is applied after the snapshot, in order.
- Tail mode (if in base): a `leaf` naming an id before the window sends a new hello, and the old transcript stays published until the new welcome completes.
- Appending entries to a 5000-entry path doesn't walk: measure with a counter or a spy on the walk function, not with timing.

## Workflow shape
Default.

## Open questions
None.
