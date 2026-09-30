# Host: tell guests where the leaf is (R3 to R5)

Phase: 1
Depends on: rewind_p1_wire_chain
Written: 2026-09-30 at upstream 81c851de5f
Revalidated: pending

## Context
Design R3 to R5 and B1/B2. Leaf moves without an appended entry send guests nothing, and the welcome doesn't say where the leaf is.

## Scope
In scope:
- the `SessionManager` leaf-change hook;
- host reconciliation and the `leaf` frame;
- `welcome.leafId`;
- wire types in both declaration sites.

Out of scope: guest handling (the three sibling tickets).

## Files and anchors
- **`session/session-manager.ts`** (the hook, R4):
  - `:772` `onEntryAppended` (the new hook goes beside it);
  - `:1516-1525` `#notifyEntryAppended` (copy its try/catch/log);
  - `:1608-1615` `#setLeaf`;
  - `:1647-1650` atomic-batch restore (writes `#index.setLeaf` directly);
  - `:2885` `appendMessageToBranch` and `:2909` `appendModelUsage` (both put the leaf back with `#index.setLeaf` directly);
  - `:1597`, `:3269`, `:3352` index rebuilds.
- **`collab/host.ts`**:
  - `:454-469`: installs `onEntryAppended`;
  - `:556`: clears it on stop, and must clear the new hook too;
  - `:766-777`: welcome.
- **Wire types**: `collab/protocol.ts` (`CollabFrame`; `COLLAB_PROTO` at `:41` stays 3) and `packages/wire/src/index.ts` (`HostFrame` `:345`, welcome at `:347`).
- **Callers whose moves must reach guests**, used as test cases:
  - `agent-session.ts:11235-11255` (`navigateTree`);
  - `turn-recovery.ts:1241-1284`, `:3069`;
  - `session-manager.ts:3257` (`discardEntryDurably`).

## Design constraints
- **One notifying leaf write.** Route every leaf write through a single method that notifies, so a new call site can't bypass it. The hook takes no arguments: the host reads `getLeafId()` when it reconciles.
- **Reconciliation per R3.**
  - `#guestLeafId` holds what guests derive. It's set on each replicated `entry` sent (to that entry's id) and on each `leaf` sent.
  - Any leaf change or appended entry queues one microtask. The microtask maps `getLeafId()` through the R2 function and sends `{ t: "leaf", leafId }` only if the result differs.
  - Queue at most one microtask at a time.
- **Ordering.** The `leaf` frame goes through the same `#send` queue as `entry` frames, after the entry frames of the same tick, so guests apply them in the order the host made the changes.
- **Welcome.** Set `welcome.leafId` (mapped) and `#guestLeafId` together in `#handleHello`, before any live frame can follow.
- **Session changes.** While `#guestTrafficAllowed()` is false (session switching), reconcile does nothing. A committed session change stops the room anyway (`host.ts:587-601`).

## Approach
1. Add the hook and the single notifying leaf write in `SessionManager`, with a unit test per public path.
2. Add the wire types (`leaf` frame, `welcome.leafId`) with doc comments that state the guest rule from R1.
3. Add the host's reconcile, the welcome field, and hook install/uninstall.
4. Flip the phase 0 B1 and B2 host-side tests.

## Acceptance criteria and tests
- **SessionManager.** Each of these calls the hook at least once, and `getLeafId()` inside the hook already returns the new leaf:
  - `branch`, `resetLeaf` and `branchWithSummary`;
  - `appendMessageToBranch`, whose final leaf is the restored one;
  - `discardEntryDurably`;
  - an atomic batch that restores its leaf.
- **Host, with a raw guest over the in-memory relay:**
  - `navigateTree` with no summary gives exactly one `leaf` frame naming the target's parent (user target) or the target (other targets);
  - `branchWithSummary` gives the `branch_summary` entry and no `leaf` frame;
  - `appendMessageToBranch` gives the entry, then one `leaf` frame naming the previous leaf;
  - a leaf move onto a non-replicated entry sends its nearest replicated ancestor;
  - a join after a rewind carries `welcome.leafId` equal to the host's mapped leaf.
- Guests without leaf support are unaffected: every existing collab test passes.

## Workflow shape
Default.

## Open questions
None.
