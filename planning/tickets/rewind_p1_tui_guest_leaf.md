# TUI guest: follow the host's leaf

Phase: 1
Depends on: rewind_p1_host_leaf
Written: 2026-09-30 at upstream 81c851de5f
Revalidated: 2026-10-08 (guest branch-render, mid-stream and missing-leaf recovery tests; live fleet not checked)

## Context
Design R1, R5 and R6. The TUI guest's replica `SessionManager` already moves its leaf to each ingested entry. What it's missing:
- applying `welcome.leafId` after the snapshot;
- applying `leaf` frames;
- rebuilding the agent's message array and the rendered transcript when the leaf moves. Today `message` entries are appended without looking at `parentId`.

## Scope
In scope: `collab/guest.ts` frame handling and the welcome completion.

Out of scope: guest-initiated rewind (`rewind_p2_tui_guest_rewind`).

## Files and anchors
- `collab/guest.ts:407` `#beginWelcome`; `:470-513` welcome completion (`#clearTransientUi`, `renderInitialMessages({ clearTerminalHistory: true })`, `reloadTodos`).
- `collab/guest.ts:547-566` `#applyFrame` `entry`: ingests, then appends `message` entries to `agent.replaceMessages([...messages, entry.message])`. It rebuilds from `buildDisplaySessionContext()` only for `compaction`/`branch_summary`.
- `collab/guest.ts:612-613` default case (unknown frames are ignored today).
- `collab/guest.ts:290-313` hello and reconnect: the resync path for R6.
- Replica: `SessionManager.branch` / `resetLeaf` (`session-manager.ts:3237`, `:3243`).

## Design constraints
- **`leaf` frame.**
  - Held (or `null`): `branch(leafId)` / `resetLeaf()` on the replica, then rebuild with `agent.replaceMessages(buildDisplaySessionContext().messages)`, `renderInitialMessages({ clearTerminalHistory: true })` and `reloadTodos()`.
  - Not held: log a warning and resync through the reconnect path, which re-sends hello and gets a fresh welcome.
- **Rebuild safely.** Reuse the welcome completion's teardown and render sequence (move it into a method both call) rather than a second ad hoc copy. It handles live tool blocks and the shared spinner ticker (see the comments at `:475-501`).
- **`entry` frame.** If the entry's `parentId` isn't the replica's leaf before ingest, rebuild the message array from `buildDisplaySessionContext()` instead of appending. That covers an append that follows a leaf move within the same tick, before its `leaf` frame.
- **Welcome.** When `leafId` is present, set the replica leaf before the first render. When it's absent (old host), keep today's behaviour.
- A leaf move while the host is streaming (turn recovery) must not leave a live stream component orphaned. Test it.

## Approach
1. Pull the render sequence out of the welcome completion into a private method.
2. Handle `leaf` and the welcome `leafId`.
3. Add the `parentId` check to `entry`.
4. Flip the phase 0 TUI guest tests.

## Acceptance criteria and tests
- Host rewind, then new prompt: the guest's `session.messages` and replica `getBranch()` match the host's (wire-filtered). A test with a fake `InteractiveModeContext` asserts `renderInitialMessages` ran once per leaf move.
- Join after a rewind: the first render uses the host's leaf.
- A `leaf` for an unknown id starts a resync and does not throw.
- A leaf move mid-stream: after the turn completes, the guest's transcript matches the host's.

## Workflow shape
Default.

## Open questions
None.
