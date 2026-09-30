# Reproduce stale-guest bugs B1 to B3 as failing tests

Phase: 0
Depends on: none
Written: 2026-09-30 at upstream 81c851de5f (fork), omp-connected 66a1466ed9
Revalidated: pending

## Context
[Design](../20260930_collab_rewind_design.md), bugs B1 to B3. B3 was confirmed with a throwaway probe on 2026-09-30. B1 and B2 are read from the code and haven't been seen live. Phase 1 fixes these, so the tests need to fail first.

## Scope
In scope:
- failing tests on a new fork branch `collab-guest-leaf` off `upstream/main`;
- one live check through the hub.

Out of scope: any fix.

## Files and anchors
- Test pattern to copy: `packages/coding-agent/test/collab/discarded-entry-marker.test.ts`. It uses a real `CollabHost` over `helpers/in-memory-relay`, a raw guest `CollabSocket`, and a guest `SessionManager.inMemory()` fed with `ingestReplicatedEntry`.
- Host leaf moves: `SessionManager.branch` (`session/session-manager.ts:3237`), `resetLeaf` (`:3243`), `appendMessageToBranch` (`:2865-2886`), `discardEntryDurably` (`:3257`).
- Wire filter: `WIRE_SESSION_ENTRY_TYPES` (`collab/host.ts:99-118`).
- collab-web client tests: `packages/collab-web/test/client.test.ts`, with frames fed through the client's frame handler (`src/lib/client.ts:295-440`).

## Design constraints
- Each test asserts what a guest would show or hold, not host internals:
  - the guest replica's `getBranch()` ids and `buildSessionContext().messages`;
  - collab-web's published `entries`.
- No real timers: await frames with promises, the way `discarded-entry-marker.test.ts` does.
- Commit as `test(collab): ...` with the tests marked `it.failing` (bun), so the branch stays green until phase 1 flips them to `it`. If bun's `it.failing` isn't available at this base, leave them failing and note that in the commit.

## Approach
1. **B1, host rewind reaches no guest.**
   - Host session: user A, assistant A, user B, assistant B. A raw guest joins, then the host calls `sessionManager.branch(<assistant A id>)` and appends user C.
   - Assert that the guest replica's `getBranch()` is `[userA, assistantA, userC]`, and that a collab-web client fed the same frames publishes those three entries in that order.
   - The collab-web half fails today, because it shows all five.
2. **B1, `appendMessageToBranch`.**
   - Host appends a message to a non-leaf parent, then a normal message.
   - Assert the guest's branch matches the host's `getBranch()` (wire-filtered).
3. **B2, join after a rewind.**
   - Host rewinds with no new entry, then a guest joins.
   - Assert the guest's branch ends at the host's leaf.
4. **B3, parent through a non-replicated entry.**
   - Host: user A, `appendCustomEntry`, user B.
   - Assert the guest replica's `buildSessionContext().messages` has 2 messages. The probe got 1.
5. **Live check** (records evidence; nothing to commit here):
   - Start an `ompc` session on hub-host with a short throwaway conversation, and open it in the dashboard in control mode.
   - Esc-esc in the host TUI back to the first prompt.
   - Note what collab-web shows before and after sending a new prompt, and screenshot it.
   - Do the same with a TUI guest (`/join <link>` from a second terminal).
   - Record the results in a short report `planning/20260930_rewind_repro.md`.

## Acceptance criteria and tests
- The four tests exist on `collab-guest-leaf` and fail (or are `it.failing`) at `upstream/main`.
- The live report says whether B1 is visible in collab-web and in the TUI guest, and whether B3 truncates the TUI guest's rendered transcript, not only its replica.

## Workflow shape
One sonnet implementer writes the tests; the main agent does the live check. No review loop.

## Open questions
None.
