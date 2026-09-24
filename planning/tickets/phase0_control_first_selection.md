# WebUI: make selection control-first safely

Phase: 0
Depends on: none
Written: 2026-09-22 at HEAD ea1ccb0695
Revalidated: pending phase entry

## Context
`selectSession()` always requests view (`hub/src/webui/app.ts:259-271`) although control transport already exists. D1 requires writable sessions to open prompt-ready control; view-only must remain intentional.

## Scope
In: capability-aware access selection, explicit view/control switching, stale response ordering, focused tests. Out: responsive drawers, status overlay, guest protocol.

## Files and anchors
- `hub/src/webui/app.ts:259-340`: selection, broker request, tail/iframe installation.
- `hub/src/webui/lib/workspace.ts:177-184`: access eligibility.
- `hub/src/webui/lib/collab-link.ts:1-12`: fragment-only boundary.
- `hub/tests/webui/workspace.test.ts`; `hub/tests/server/collab-rpc-routes.test.ts`.

## Design constraints
Request `control` only where advertised. Preserve current `generation`, strict returned access validation, and browser-side capability confinement. A link result only applies if its request token still identifies the selected session and requested mode. No guest-DOM focus reach-in.

## Approach sketch
Centralize default-mode selection in a pure helper. Give every selection/mode request a monotonically changing token; install tail/iframe and mutate selected access only when it still matches. Render an explicit available View action after control opens and explicit Control action only where eligible.

## Acceptance criteria and tests
- Writable click POSTs `access: control`; view-only click POSTs `access: view`.
- Late result for an earlier selection cannot alter active surface.
- Mismatch, stale generation, and transport errors leave truthful current-session UI.
- Existing fragment-only and unchanged-iframe properties remain true.
- Route test proves a successful control link forwards intact.

## Workflow shape
Implementer plus independently written focused tests, then standard/adversarial review.

## Open questions
None.
