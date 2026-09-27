# Wire: add tail request, history and value frames, and placeholder metadata

Phase: 1 (tail snapshot)
Depends on: phase 0
Written: 2026-09-23 at HEAD c046df93c5 (upstream fd3f8e3c56)
Revalidated: pending phase entry
Revalidated: 2026-09-23 at fork base a1b3b83a7f — anchors hold (±2 lines); executed as fork 4197ae90e. Conformance compares key sets too (assignability alone missed a one-sided optional field; verified by mutation).

## Context
The contract is in [design](../20260923_collab_tail_snapshot_design.md), "Wire contract"
section. It is bound by decisions T3, T4 and T8.

## Scope
In scope:
- type additions in `packages/wire`;
- the matching host-side declarations in `protocol.ts`;
- a type-level conformance test, which doesn't exist today (web survey, finding 1).

Out of scope: runtime behaviour (the other phase 1 tickets).

## Files and anchors
- `packages/wire/src/index.ts`:
  - `hello` `:325-335`: add optional `snapshot`;
  - `GuestFrame` `:324-340`: add `fetch-history` and `fetch-value` next to `fetch-transcript` (`:340`);
  - `HostFrame` `:345-380`: add `history` and `value`, and `welcome.history` (`:346-361`);
  - an exported `CollabElided` type and an optional `collabElided` on `EntryBase` (`:116-120`);
  - an exported constant `COLLAB_ENTRY_OMITTED_CUSTOM_TYPE`, moved from `replication-shrink.ts:57-58` and re-exported there, so collab-web can import it.
- `packages/coding-agent/src/collab/protocol.ts:54-96`:
  - mirror `welcome.history`;
  - add the rich `history` frame with `SessionEntry[]` (the pattern at `:83-84`) and the `value` frame.
- Leave `COLLAB_PROTO = 3` (`index.ts:397`). Update the history comment at `:384-396` to describe the optional, protocol-3 extension.
- Add the conformance test at `packages/coding-agent/test/collab/web-wire.types.ts`, the file `index.ts:7` already names. It asserts that each host frame in `protocol.ts` can be assigned to its `HostFrame` counterpart.
- `packages/wire/CHANGELOG.md`: leave for phase 4.

## Design constraints
- Every addition is optional. Old peers must compile and behave unchanged.
- The type names must not collide with #10462 (`capabilities`, `guestId`).

## Acceptance criteria and tests
- `bun --cwd=packages/wire run check` and `bun --cwd=packages/coding-agent run check` are clean.
- The conformance file fails to type-check if a field is removed from one side. Verify that once by hand, then revert.

## Workflow shape
Implementer on sonnet, then one opus review. This lands before the other phase 1 tickets.

## Open questions
None.
