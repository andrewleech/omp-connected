# Active Collab status-bar ownership decision

Date: 2026-09-22
HEAD: ea1ccb0695

## User requirement
Restore the compact floating status bar **inside the Collab frame**, top-right over the active session. Its information hierarchy is project, git branch, current activity, model, context depth, token generation speed, and connection/attention state.

## Evidence
Hub’s `collab.list` session contract has only `cwd`, model, participants, relay state, and input-required (`hub/src/server/types.ts:39-52`). It cannot truthfully manufacture branch, activity, context depth, or token speed. The compiled guest is separately built from external `collab-web` (`hub/scripts/build-vendor-collab.sh:1-28`); its source is not in this checkout. Historical commit `e8009c4` removed roster coupling, not a recoverable Hub implementation of the bar.

## Decision D6
The bar is a **guest-owned upstream Collab surface**. Do not add a Hub guest-to-parent telemetry protocol, dashboard duplicate, or private long-lived fork.

Phase 1 first identifies the guest component/version and verifies Hub's iframe geometry preserves it. If the current vendored guest does not contain the bar, use an upstream release that does. If upstream does not have it, pursue the smallest focused upstream-compatible patch; carry it locally only while it is upstreamable and isolate it at the vendor source/build boundary.

## Hub integration rules
- Hub opens a writable session in the full control iframe, so the native composer and status bar are ready after selection.
- Parent shell/drawers may never overlay, clip, or resize away the guest bar or composer.
- Hub polling and drawer changes preserve the iframe node; they do not synthesize guest telemetry.
- The guest remains the owner of token/context/activity definitions and update cadence.
- Guest changes remain limited to upstream release selection or a minimal upstream-quality patch. No dashboard-specific postMessage protocol.

## Verification
Use a real built guest from the configured source for smoke tests. Browser fixtures may emulate the guest bar only to prove Hub layout, focus, and iframe-continuity contracts; they cannot establish guest telemetry correctness.
