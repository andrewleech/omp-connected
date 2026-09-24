# Collab guest: recover native status bar through upstream vendoring

Phase: 1
Depends on: Phase 0
Written: 2026-09-22 at HEAD ea1ccb0695
Revalidated: pending phase entry

## Context
The requested top-right status bar belongs to the Collab frame and reports project, branch, activity, model, context depth, and token speed. Current Hub session-list data cannot produce most of these fields. D6 rejects a dashboard telemetry protocol to keep the guest near upstream.

## Scope
In: identify guest status-bar provenance, choose/update upstream guest revision, make any necessary Hub embedding geometry change, and prove the real guest bar is visible. Out: dashboard-owned telemetry, custom postMessage status protocol, stop/abort/focus protocol, transcript parsing, and a long-lived guest fork.

## Files and anchors
- `hub/scripts/build-vendor-collab.sh:1-28`: external-source vendor seam.
- `hub/src/webui/app.ts:283-340,438-504`: control iframe installation and continuity.
- `hub/src/webui/index.html:21-38,69-75`: available frame geometry.
- `planning/20260922_status_bar_telemetry_decision.md`: D6.

## Design constraints
Prefer an upstream version upgrade. If a patch is essential, it must be minimal, independently useful upstream, and isolated in the external guest source. The Hub may only reserve enough visible frame/safe-area space; it must not reproduce guest state or scrape iframe internals.

## Approach sketch
Inspect the external guest checkout at phase entry, trace the native bar's data/component path, then update vendor source/revision or submit an upstream-quality restoration. Embed a real control guest in Hub and test desktop/mobile bar visibility. Preserve fragment-only capabilities and iframe identity.

## Acceptance criteria and tests
- Real control guest visibly renders project, branch, activity, model, context depth, and token speed where the guest reports them.
- Hub does not clip or cover native bar/composer at desktop or compact widths.
- No dashboard telemetry protocol or guest fork is introduced.
- Vendor build consumes the approved source revision; poll/drawer actions preserve the guest frame.

## Workflow shape
Upstream audit and minimal patch/upgrade review, Hub integration implementation, real guest smoke test, adversarial vendoring review.

## Open questions
None.
