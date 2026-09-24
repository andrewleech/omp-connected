# OMP Hub WebUI responsiveness and control roadmap

Date: 2026-09-22
HEAD: ea1ccb0695

## Current state

The dashboard is a fixed desktop grid that turns into a vertical document at <=620px (`hub/src/webui/index.html:21-38`). That makes navigation consume up to 35vh before the active session and leaves the inspector after it. Every session selection currently requests a view-only tail transport (`hub/src/webui/app.ts:259-271`), despite control transport already being supported for sessions advertising `access: "control"`. The active session has only a recreated header/hint; no persistent floating Collab status/control surface exists. Poll refresh protects an unchanged iframe through `workspaceSignature()`; this is a non-negotiable continuity invariant.

## Settled decisions

| ID | Decision | Rationale |
|---|---|---|
| D1 | A writable session selection requests `control`; a session advertised `view` opens explicit read-only view. | Interactive work is the normal user intent; capability eligibility remains authoritative. |
| D2 | Hub owns only global shell controls and session context; the Collab guest owns its live status bar and controls. | Parent telemetry would duplicate guest state and make upstream guest updates harder. |
| D3 | At compact breakpoint <=768px, session rail and inspector are independent modal drawers. Both default closed; their state is viewport-local, not persisted. | Preserves active terminal width and avoids a storage migration/stale desktop state. |
| D4 | A visible drawer control is required; edge swipes are enhancement only, restricted to an outer edge zone. | Reliable and accessible; does not steal iframe/list/long-press gestures. |
| D5 | Default control means the guest composer is immediately available, not forced focused across an iframe. | Parent cannot safely reach guest DOM without a versioned protocol. |
| D6 | The floating bar belongs inside the vendored Collab guest, using its upstream status UI and data flow. Hub must preserve its space and embed it in control mode; it does not add a parent telemetry protocol. | The user identifies this as existing Collab-frame behaviour; custom guest/dashboard transport would hinder upstream updates. |
| D7 | Use direct TypeScript Playwright Test in GitHub Actions, initially Chromium-only and single-worker in CI. | It is the maintained standard for browser testing in this Bun/TypeScript project; Robot Framework would add a Python wrapper/toolchain around Playwright. |

## Open questions

| Question | Owner | Options |
|---|---|---|
| Q1: Should Hub add a browser UI test runner? | DECIDED 2026-09-22 — D7 | Direct Playwright Test; GitHub Actions Chromium job with deterministic local fixtures and failed-test artifacts. |
| Q2: Which guest protocol supports dashboard-level stop/abort and focus? | DECIDED 2026-09-22 — deferred | Do not add a Hub-defined guest protocol. Keep guest-native controls/status; revisit only through an upstream Collab feature or necessary upstream-compatible patch. |

### Phase 0 — lock interactive selection and continuity

Goal: selecting a writable session produces a live control guest safely; a read-only session remains deliberately view-only.

Why first: it fixes the direct behaviour defect without entangling it with layout, and establishes the state model every later phase displays.

Work items:
1. Add a selection/request generation token so late A→B capability results cannot replace B’s surface.
2. Choose requested access from advertised session capability; make `control` the writable default and retain explicit view switch.
3. Preserve fragment-only capabilities, broker result matching, stale-generation errors, and live-iframe continuity.
4. Extend unit/route coverage for control forwarding and capability-aware default selection.

Targets: `hub/src/webui/app.ts`, `hub/src/webui/lib/workspace.ts`, `hub/tests/webui`, `hub/tests/server/collab-rpc-routes.test.ts`.

Tests: writable/view-only selection payloads; failed/mismatched response; rapid selection ordering; unchanged session poll retains iframe.

Exit criteria: clicking a writable session requests `control`; view-only never requests forbidden control; stale responses cannot mutate current workspace.

Workflow shape: implementation, independently authored focused tests, standard and adversarial review; re-test after every review fix.

### Phase 1 — preserve and recover the native Collab status bar

Goal: a selected control session displays the Collab guest’s native top-right live status bar — project, git branch, activity, model, context depth, and token speed — with no dashboard-specific guest fork.

Why now: the requested UI belongs to the Collab frame, not the parent dashboard. Restore/retain it at the vendoring boundary before adding any dashboard metadata that could duplicate or contradict it.

Work items:
1. Revalidate the external `collab-web` source and the currently built guest against the requested bar: identify the exact upstream component, telemetry source, styling, and build/version relation.
2. Confirm the Hub `/collab/` iframe wrapper, control link, viewport dimensions, and CSS do not clip, conceal, or break the native bar on desktop or compact viewports.
3. If the bar is absent from the vendored version, upgrade to the upstream release that contains it; if no release contains it, propose the smallest upstream-compatible feature/bug-fix patch and upstream it before carrying it locally.
4. Keep any Hub change confined to embedding/layout; do not add guest-to-parent status messages, parent telemetry UI, or privileged dashboard controls.
5. Add regression coverage around the guest-visible bar and Hub’s iframe continuity with a deterministic fixture guest; run a real guest smoke check from the configured external source.

Targets: external `collab-web` source (revalidated at phase entry), `hub/scripts/build-vendor-collab.sh`, Hub iframe shell/layout, Playwright fixture coverage.

Tests: native status-bar visible in a control iframe at desktop/compact sizes; no overlay clipping; current status values change in the guest; poll/drawer updates retain iframe identity; vendor build consumes the approved upstream revision.

Exit criteria: bar content is guest-originated and readable without extra Hub protocol; only documented upstream-compatible guest changes, if any, remain; Hub control selection and mobile layout preserve it.

Workflow shape: upstream-source audit, minimal vendor upgrade/patch review, Hub integration tests, and visual/accessibility review.

### Phase 2 — responsive workspace and independent drawers

Goal: at <=768px, central Collab stays full-width and both supporting panes can be independently opened, closed, and safely swiped.

Why now: phases 0–1 provide a stable interactive surface to protect while restructuring layout.

Work items:
1. Replace mobile stacking with desktop grid plus compact overlay drawer modes for rail and inspector; add header triggers, backdrop, close controls, and independent scroll containers.
2. Implement ephemeral drawer reducer/state and accessible semantics: names, `aria-expanded`, `aria-controls`, focus entry/return, Escape/backdrop close, focus-visible styles.
3. Add edge-only pointer-swipe open/close with threshold/velocity guards; do not capture gestures from cards, scroll containers, or iframe.
4. Use `dvh`/safe-area-aware sizing; avoid mutually additive `vh` minima and preserve terminal/composer clearance.

Targets: `hub/src/webui/index.html`, `hub/src/webui/app.ts`, workspace state/tests as justified.

Tests: viewport-mode/drawer state transitions; focus lifecycle; drawer toggles retain iframe. Manual devices: 320/360/390 portrait, rotation, Safari iOS and Chrome Android keyboard/safe-area behavior.

Exit criteria: neither pane consumes terminal width/height when closed; each can open/close independently by accessible control; swipe never breaks session long press or terminal scroll.

Workflow shape: implementation, device/DOM validation, accessibility review, remediation loop.

### Phase 3 — deterministic browser CI and release validation

Goal: run maintainable browser acceptance tests in GitHub Actions and ship evidence-backed responsive behaviour.

Why last: the final control, native-guest status bar, and drawer boundaries are the stable user-visible contract to automate.

Work items:
1. Implement D7: direct TypeScript Playwright, a deterministic local Hub/guest fixture, Chromium single-worker CI, and failed-test report/trace artifacts.
2. Cover default control, view-only fallback, stale selection safety, native bar visibility, drawer focus/close behaviour, and iframe continuity. Use role/label/test-id locators and web-first assertions; no sleeps or live network.
3. Execute and record real-device matrix: drawer, native status bar, control/view-only, stale session, keyboard, rotation, poll/lifecycle continuity, keyboard/screen reader.
4. Build dashboard and vendored guest from the approved upstream source; publish review screenshots where project convention permits.

Targets: `hub` package/test configuration, GitHub Actions workflow, `hub/tests/e2e/`, external guest smoke fixture, planning progress report.

Tests: `bun test`, Chromium Playwright, dashboard/vendor build, manual device matrix.

Exit criteria: deterministic GitHub CI passes without credentials or external services; no clipped/obscured native status bar or composer at approved mobile sizes; no iframe reload on drawer/poll; all guest deviations are either upstreamed or explicitly rejected.

Workflow shape: test/fixture implementation, CI/security review, repeat-run flake check, implementation remediation, adversarial review.

## Rollout and risk register

Ship Phase 0 independently, then Phase 1, then Phase 2. Maintain desktop grid behavior throughout. Do not alter server event schemas or guest transport in these phases.

| Risk | Mitigation |
|---|---|
| Capability leak | Retain `collabFrameUrl` and its tests; never store link/access URL. |
| Guest disconnect | Assert iframe-node continuity across poll, bar, and drawer changes. |
| Mobile visual viewport failure | Use `dvh` plus safe-area padding; prove on Safari/Chrome keyboards. |
| Gesture conflict | Edge-only enhancement; buttons/backdrop remain primary. |
| Unsupported controls | Keep controls/status guest-native; add no dashboard protocol unless an upstream-compatible change is approved. |

## Progress tracking

Before each phase, revalidate its tickets against the current HEAD with the procedure in `00_index.md`. Each completed phase adds a dated progress/learning report; this roadmap is updated in place, not forked.

### 2026-09-22 implementation status

- Phase 0 complete: advertised writable sessions request `control` by default; view-only sessions remain in tail view; stale link responses are discarded.
- Phase 1 Hub embedding complete: compact and desktop shell preserves the guest frame/status-bar viewport. The configured upstream guest source is unavailable at `$HOME/cc-pi-bridge/trial-omp/webui/collab-web`, so its native-bar version and an actual vendor build remain blocked pending `COLLAB_WEB_SRC`.
- Phase 2 complete: the rail and inspector are independent, inert-while-closed compact drawers with trigger/close/backdrop/Escape/focus handling and edge-only swipe support.
- Phase 3 CI/browser contract complete: direct Chromium Playwright fixture coverage runs in a single worker; the workflow installs the browser and uploads failure-only reports.
