# Hub: preserve native Collab status-bar visibility

Phase: 1
Depends on: Phase 0; `phase1_status_telemetry_contract.md`
Written: 2026-09-22 at HEAD ea1ccb0695
Revalidated: pending phase entry

## Context
The required project/branch/activity/model/context/token-rate bar is native Collab-frame UI. The upstream-vendoring ticket establishes the approved guest revision. This ticket ensures Hub's control embedding and responsive shell keep that guest-owned bar readable.

## Scope
In: iframe control-mode selection, active-surface geometry, safe-area/compact layout, and visibility/continuity tests. Out: parent status overlays, metadata duplication, guest protocol changes, and dashboard-owned stop/abort controls.

## Files and anchors
- `hub/src/webui/app.ts:259-340,438-504`: control selection and iframe lifecycle.
- `hub/src/webui/index.html:21-38,69-75`: shell and frame geometry.
- `hub/scripts/build-vendor-collab.sh:1-28`: approved guest build seam.

## Design constraints
The parent never overlays or scrapes the native bar. It preserves the iframe on poll/drawer changes and makes room through layout only. Hub session metadata remains dashboard context, not a competing status surface.

## Approach sketch
Open writable sessions in control, preserve the existing frame node, and use responsive CSS so its visible viewport includes guest top-right status and composer at all target breakpoints. Exercise a fixture guest for shell contracts and a real built guest for smoke evidence.

## Acceptance criteria and tests
- Control iframe visibly retains the native bar at desktop and compact sizes.
- Parent rail/inspector drawers never cover or clip it.
- Poll/drawer refresh preserves iframe node/src.
- No duplicate parent telemetry or guest-private protocol exists.

## Workflow shape
Hub layout implementation, fixture/browser tests, real guest smoke test, visual/accessibility review.

## Open questions
None.
