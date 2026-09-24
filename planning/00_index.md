# Planning index: WebUI responsiveness and control

Date: 2026-09-22
HEAD: ea1ccb0695

## Reading order
1. `00_context.md` — goal and settled design rules.
2. `20260922_webui_source_audit.md`, `20260922_claudenet_reference_review.md`, `20260922_webui_contract_risk_audit.md`, `20260922_status_bar_telemetry_decision.md`, and `20260922_browser_test_architecture.md` — evidence and decisions D6–D7.
3. `20260922_webui_roadmap.md` — current state, D1–D7, closed Q1–Q2, phases, risks, and rollout.
4. Phase tickets include `phase1_status_telemetry_contract.md`, `phase1_active_collab_bar.md`, `phase3_playwright_ci.md`, and `phase3_mobile_release_validation.md`.
5. Collab tail-first snapshot, a separate track:
   - [design and wire contract](20260923_collab_tail_snapshot_design.md), T1–T13;
   - [roadmap](20260923_collab_tail_snapshot_roadmap.md), phases 0–4 and Q1–Q3;
   - `tickets/tail_*.md` and `tickets/hub_reselect_guard.md`;
   - evidence: `20260923_collab_snapshot_composition.md` and `20260923_upstream_*.md`;
   - results: `20260923_tail_snapshot_phase0.md`, `20260924_tail_snapshot_phase1.md`, `20260924_tail_snapshot_field_test.md` (phases 2–3).

## Operating conventions
- Every document is stamped with its date and HEAD revision.
- Tickets have immutable `Written:` metadata and append-only `Revalidated:` entries.
- The roadmap’s numbered open questions are retained after a dated decision.
- Update this roadmap in place; each executed phase adds a dated progress/learning report.

## Phase-entry procedure
Before executing a phase, revalidate each phase ticket at current HEAD: inspect `git log <written-sha>..HEAD` and `git diff <written-sha>..HEAD -- <anchored files>`; re-resolve anchors; read later planning documents and decision changes; update the ticket and append a `Revalidated:` entry. Only tickets revalidated at current HEAD enter an implementation workflow. Drift that changes a ticket’s shape updates the roadmap first.

## Execution model
For each ticket: implementation uses the primary coding agent, tests are independently authored/run, then standard and adversarial reviews feed fixes until checks are clean. A ticket’s own workflow section overrides this default.

## Ticket template
Each ticket records: context, scope, concrete file anchors, design constraints, approach sketch, observable acceptance criteria/tests, workflow shape, and unresolved questions.
