# Host: replicated parent links skip non-replicated entries (R2)

Phase: 1
Depends on: rewind_p0_repro
Written: 2026-09-30 at upstream 81c851de5f
Revalidated: pending

## Context
Design R2 and B3. The host replicates six entry types but copies `parentId` verbatim, so a guest's walk from its leaf stops at the first parent it never received. R1 (guests display the walk from the leaf) depends on this being fixed.

## Scope
In scope: every host path that emits a replicated entry:
- the live `entry` frame;
- the join snapshot chunks;
- on the PR #13389 branch, the tail (`#selectTail`) and `history` pages.

Out of scope:
- which entry types are replicated;
- entry ids;
- anything on guests.

## Files and anchors
- `collab/host.ts:99-118`: `WIRE_SESSION_ENTRY_TYPES`, `isWireSessionEntry`.
- `collab/host.ts:454-469`: live entry path (`onEntryAppended` → `shrinkReplicatedEntry` → `entry` frame).
- `collab/host.ts:749-778`: join snapshot (`snapshotForReplication` → filter → `#snapshotChunks`).
- `collab/replication-shrink.ts`: `shrinkReplicatedEntry` keeps `id`/`parentId` (see its header comment, around `:39` at abc0446c69). Placeholders must carry the rewritten parent too.
- At abc0446c69 (PR #13389): `host.ts:904-916` `#selectTail`, `:982-1009` `#handleFetchHistory`. Both use `getBranch().filter(isWireSessionEntry)`, so the rewritten parent of `path[i]` is simply the previous wire entry on the path.
- `session/session-manager.ts:2817` `ingestReplicatedEntry`: unchanged; guests just receive consistent links.

## Design constraints
- The rewrite happens on the host's private copy (after `copyForReplication` or inside `shrinkReplicatedEntry`), never on the live session entry.
- Nearest replicated ancestor: walk `parentId` through `sessionManager.getEntry()` until a replicated type or `null`. For the snapshot, use a map over the snapshot's entries so the walk is O(n) overall; don't do a `getEntry` walk per entry when a chain of many non-replicated entries repeats.
- Put the mapping in one function (for example `replicatedParentId(entry, lookup)`) that R3's leaf mapping also uses. The same rule has to apply to both.
- The existing `discarded-entry-marker.test.ts` expectation (`[priorId, markerId, reminderId]`) must still hold.

## Approach
1. Add the mapping function next to `isWireSessionEntry`.
2. Apply it in the live entry callback and the snapshot path, and on the #13389 branch in the tail and history copies.
3. Flip the phase 0 B3 test from failing to passing.

## Acceptance criteria and tests
- B3 test: host `[user A, custom, user B]` → the guest replica's `buildSessionContext().messages` has both messages, and `getBranch()` ends at user B with user A as its parent.
- A chain of several non-replicated entries at the root: the first replicated entry's `parentId` is `null`.
- The existing collab tests pass unchanged.

## Workflow shape
Default (sonnet implement, haiku test, opus review loop).

## Open questions
Q1 in the design: its own PR or the first commit of PR A.
