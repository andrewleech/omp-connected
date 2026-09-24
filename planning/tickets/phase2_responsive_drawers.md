# WebUI: make supporting panes mobile drawers

Phase: 2
Depends on: Phase 1
Written: 2026-09-22 at HEAD ea1ccb0695
Revalidated: pending phase entry

## Context
Current <=620px CSS stacks the rail, workspace, and inspector in document flow. This makes the active Collab area impractical. D3/D4 require independent compact drawers, controls first and swipes only as enhancement.

## Scope
In: desktop/compact shell transition, left session and right inspector drawers, focus/backdrop/Escape, edge swipes, safe-area/visual-viewport sizing. Out: changing guest layout or unverified composer focus.

## Files and anchors
- `hub/src/webui/index.html:21-38,69-75`: shell CSS/region roots.
- `hub/src/webui/app.ts:382-436,634-691`: rail/inspector rendering and root handling.
- `hub/src/webui/app.ts:107-160`: long-press gesture conflict boundary.
- `hub/src/webui/lib/workspace.ts:67-137`: persistence boundary.

## Design constraints
Drawer visibility remains ephemeral and separate from selected inspector tab. At <=768px closed drawers expose full-width active surface. Preserve iframe node across every drawer transition. Do not capture gestures within list or iframe.

## Approach sketch
Introduce named trigger/close controls and independent `leftOpen/rightOpen` state. CSS makes desktop regions inline and compact regions fixed overlay drawers with a shared backdrop. Implement focus lifecycle and Escape. Add edge-zone pointer gesture tracking that commits only deliberate horizontal gesture and cancels for vertical scroll/multitouch.

## Acceptance criteria and tests
- 320/360/390px: both panes independently open/close; central terminal is full width when closed.
- Trigger state/relationships/focus lifecycle are correct; Escape/backdrop close.
- Session long press, rail scroll, inspector scroll, and guest interaction remain unaffected.
- Safari iOS/Chrome Android keyboard, safe-area, and rotation leave composer/status reachable.
- Drawer toggles do not reload active iframe.

## Workflow shape
Implementation, device validation, accessibility/adversarial review, remediation loop.

## Open questions
Q1 decides whether browser automation is warranted; manual device matrix remains required.
