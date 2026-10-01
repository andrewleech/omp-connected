# Planning index: WebUI responsiveness and control

Date: 2026-09-22
HEAD: ea1ccb0695

## Reading order
1. `00_context.md` — goal and settled design rules.
2. `20260922_webui_source_audit.md`, `20260922_claudenet_reference_review.md`, `20260922_webui_contract_risk_audit.md`, `20260922_status_bar_telemetry_decision.md`, and `20260922_browser_test_architecture.md` — evidence and decisions D6–D7.
3. `20260922_webui_roadmap.md` — current state, D1–D7, closed Q1–Q2, phases, risks, and rollout.
4. Phase tickets include `phase1_status_telemetry_contract.md`, `phase1_active_collab_bar.md`, `phase3_playwright_ci.md`, and `phase3_mobile_release_validation.md`.
5. Collab tail-first snapshot, a separate track, archived in `archive/collab-tail-snapshot/` (fork branch `collab-tail-snapshot`, upstream PR #13389):
   - origin: `20260922_collab_tail_handover.md`, the hub-side problem report that started the work;
   - [design and wire contract](archive/collab-tail-snapshot/20260923_collab_tail_snapshot_design.md), T1–T13;
   - [roadmap](archive/collab-tail-snapshot/20260923_collab_tail_snapshot_roadmap.md), phases 0–4 and Q1–Q3;
   - `tickets/tail_*.md` and `tickets/hub_reselect_guard.md`;
   - evidence: `20260923_collab_snapshot_composition.md` and `20260923_upstream_*.md`;
   - results: `20260923_tail_snapshot_phase0.md`, `20260924_tail_snapshot_phase1.md`, `20260924_tail_snapshot_field_test.md` (phases 2–3);
   - PR body and head: `pr-drafts/collab-tail-snapshot.md`.
6. Collab guest image attachments, archived in `archive/collab-web-image-attach/` (fork branch `collab-web-image-attach`, no upstream PR): [design, reviews and verification](archive/collab-web-image-attach/20260926_guest_image_attach.md), the only record of the track.
7. Collab rewind for guests, active (fork branches `collab-guest-leaf` then `collab-guest-rewind`, no upstream issue yet):
   - [design and roadmap](20260930_collab_rewind_design.md): bugs B1 to B3, decisions R1 to R12, wire contract, Q1 to Q7, phases 0 to 4;
   - tickets: `tickets/rewind_p0_*` (reproduce, upstream issue), `rewind_p1_*` (leaf sync: wire chain, host, TUI guest, collab-web, hub viewer), `rewind_p2_*` (shared rewind core, host `rewind` frame, TUI guest), `rewind_p3_web_rewind_ui`, `rewind_p4_fleet_and_upstream`.

8. Collab guest slash commands, archived in `archive/collab-guest-commands/` (fork branch `collab-guest-commands`, no upstream PR): [design, reviews and verification](archive/collab-guest-commands/20260930_guest_slash_commands.md), the only record of the track.

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
