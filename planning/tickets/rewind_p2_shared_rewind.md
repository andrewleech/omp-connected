# Pull the esc-esc rewind core out of SelectorController

Phase: 2
Depends on: phase 1 merged into the `collab-guest-rewind` base
Written: 2026-09-30 at upstream 81c851de5f
Revalidated: 2026-10-08 (selector rewind tests pass; broad Collab controller tests fail/time out; live host not checked)

## Context
Design R7. A guest rewind must run the same steps as the TUI's esc-esc, so the host's TUI redraws identically, but it must not touch the host's editor or the selector overlay. Today those steps live in a private method that also closes the overlay and sets the editor draft.

## Scope
In scope:
- one exported function holding the rewind steps;
- `#rewindFromTranscript` and the `/tree` path calling it or the boundary helper.

Out of scope: any collab code (next ticket).

## Files and anchors
- `modes/controllers/selector-controller.ts`:
  - `:1178-1217` `#rewindFromTranscript`, with its steps in this order: validate the entry; the "already at this point" check; `#treeRewindBoundary`; `navigateTree(entryId, { summarize: false })`; fast truncate or `renderInitialMessages({ clearTerminalHistory: true })`; `reloadTodos`; draft; status;
  - `:1465-1500` `#treeRewindBoundary`, also used by the `/tree` path at `:1313` and `:1407-1413`.
- `modes/types.ts:394` `truncateTranscriptFromMessage` on `InteractiveModeContext`.
- `session/agent-session.ts:10965` `navigateTree` result (`editorText`, `editorImages`, `cancelled`).
- Tests: `test/rewind-selector.test.ts` and any selector-controller tests that cover esc-esc.

## Design constraints
- New module, for example `modes/controllers/transcript-rewind.ts`, exporting:
  - `rewindTranscriptTo(ctx, entryId): Promise<TranscriptRewindOutcome>`, where the outcome is one of:
    - `{ kind: "rewound"; isUserTarget: boolean; editorText?: string; editorImages?: ImageContent[] }`;
    - `{ kind: "already-here" }`;
    - `{ kind: "cancelled" }` (an extension's `session_before_tree` cancelled it);
    - `{ kind: "not-found" }`;
  - `treeRewindBoundary(ctx, targetId, leafId)`, moved as is.
- The function never touches the editor, the overlay or the status line. Callers decide.
- Errors from `navigateTree` propagate. Each caller reports them its own way.
- `SelectorController` keeps its exact behaviour: the same status texts, the same draft rule (`isUserTarget || editor empty`), and `done()` after the rebuild, so the alternate screen never flashes a stale transcript.
- No behaviour change, so no new tests beyond what the existing suite covers. If there are no tests that pin the esc-esc outcome (draft restored, "Already at this point"), add behaviour tests for those two before the move, so they defend the refactor.

## Acceptance criteria and tests
- The existing rewind and tree tests pass unchanged.
- The two esc-esc outcome tests above exist and pass before and after the move.

## Workflow shape
One sonnet implementer and one opus review (refactor only).

## Open questions
None.
