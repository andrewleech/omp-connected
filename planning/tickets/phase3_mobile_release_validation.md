# WebUI: prove responsive control release

Phase: 3
Depends on: Phases 0, 1, 2
Written: 2026-09-22 at HEAD ea1ccb0695
Revalidated: pending phase entry

## Context
Pure Bun tests cannot prove iframe, mobile visual viewport, keyboard, safe-area, gesture, and accessibility behavior. Release requires a reproducible explicit matrix, not a visual assertion from desktop.

## Scope
In: execute D7’s Playwright CI alongside build/test/device validation; capture evidence and resolve defects. Out: new feature scope, guest protocol work, or a Python test framework.

## Files and anchors
- `hub/package.json:11-20`: build/test scripts.
- `hub/scripts/build-webui.ts:1-31`: production dashboard packaging.
- `planning/20260922_webui_contract_risk_audit.md`: required matrix.

## Design constraints
Capability protection and iframe continuity are release gates. Device tests supplement, never replace, deterministic Chromium browser tests. The native guest owns its status bar; Hub tests prove its visibility and integration, not telemetry semantics.

## Approach sketch
Run targeted tests, Chromium Playwright, and dashboard build. Exercise a real writable and a view-only session at compact and desktop breakpoints with the approved guest source; retain screenshots/logs according to repository practice. Test lifecycle refresh after a live guest is opened.

## Acceptance criteria and tests
- Focused phase tests and `bun test` pass; `bun run build:webui` produces dashboard assets.
- iOS Safari and Chrome Android: drawers, keyboard, rotation, safe areas, edge swipe, long press, **native** active bar, and control/view-only session paths.
- Poll/agent lifecycle does not reload guest; stale/error state remains truthful.
- Accessibility keyboard/screen-reader path passes for new drawer/bar controls.

## Workflow shape
Test/device specialist produces evidence; implementation fixes findings; adversarial reviewer confirms scope and continuity.

## Open questions
Q1 is decided by D7. WebKit expansion remains deferred until Chromium CI is stable and useful.
