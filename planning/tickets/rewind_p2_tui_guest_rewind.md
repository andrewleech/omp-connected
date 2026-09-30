# TUI guest: esc-esc rewinds the host

Phase: 2
Depends on: rewind_p2_host_rewind_frame, rewind_p1_tui_guest_leaf
Written: 2026-09-30 at upstream 81c851de5f
Revalidated: pending

## Context
Design R7 and R9. A TUI guest (`/join`) gets the same esc-esc as the host: its selector lists its replica's active branch, which phase 1 made correct, and picking sends `rewind` instead of calling `navigateTree` locally.

## Scope
In scope:
- the guest early return in the Esc handler;
- the selector's pick path on a guest;
- a guest method `sendRewind(entryId): Promise<RewindResult>`.

Out of scope: `/tree` on a guest (stays blocked).

## Files and anchors
- `modes/controllers/input-controller.ts:499-507`: guest Esc sends `sendAbort` when the host is streaming, and otherwise returns before the double-Esc block at `:531-551`.
- `modes/controllers/selector-controller.ts:1088-1132` `showUserMessageSelector` (`onSelect` at `:1112`).
- `collab/guest.ts`:
  - `state?.isStreaming`;
  - the welcome handling at `:407` (read `welcome.rewind` there);
  - `:596-600`, the `transcript` reply pattern with `#pendingTranscripts`, which is the model for a reqId-keyed pending map.

## Design constraints
- The guest's double-Esc runs only when all of these hold:
  - the host advertised `rewind`;
  - the guest isn't read-only;
  - the host isn't streaming;
  - the editor is empty.
  
  Otherwise keep today's behaviour: abort if streaming, else nothing. `doubleEscapeAction: "tree"` on a guest falls back to the rewind selector, because `/tree` needs the whole tree locally.
- On pick:
  - close the selector;
  - `sendRewind`;
  - on success put `draft` (and images, if any) into the local editor using the TUI rule (user target, or an empty editor);
  - on error show the error in the status line.

  The transcript rebuild comes from the `leaf` frame (phase 1), not from the pick.
- A pending rewind rejects if the guest leaves or reconnects, so nothing waits forever. There are no timers in tests.
- The sibling-branch strip shows whatever the replica holds. That's fine, because the TUI guest receives the full tree.

## Acceptance criteria and tests
- With a fake host (raw socket), esc-esc on an idle writable guest opens the selector, and a pick sends `{ t: "rewind", entryId }`. A `rewind-result` with a draft fills the editor.
- A read-only guest, a host without `rewind`, or a streaming host: esc-esc does not open the selector.
- A `rewind-result` error shows in the status line and leaves the editor unchanged.

## Workflow shape
Default.

## Open questions
None.
