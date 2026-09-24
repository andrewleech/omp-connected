# Roadmap: Collab tail-first snapshot (fork → hub → upstream PR)

Date: 2026-09-23
HEAD: c046df93c5 (omp-connected)
Upstream: fd3f8e3c56

Contract and decisions T1–T13: [design](20260923_collab_tail_snapshot_design.md).
Evidence: [composition](20260923_collab_snapshot_composition.md) and the four
`20260923_upstream_*` surveys.

## Current state
- **Harness session join.** 26.5 MB over about 6 s, 54 chunks, no images. One MiB of tail covers 26 of the session's 127 turns.
- **Hub relay.** Handles a slow guest correctly since the per-guest backpressure fix (`hub/src/relay/relay.ts`, uncommitted).
- **Fork.** Doesn't exist yet. The submodule `hub/vendor/collab-web` is pinned to upstream `fd3f8e3` (staged, uncommitted).
- **Upstream.** No PR addresses #9469, #9328 or #11859. Open PRs that may conflict:
  - #10462: bumps the protocol to 4 and adds `capabilities`; stale and blocked on a security finding;
  - #11371: send-queue admission;
  - #11861: reconnect.

## Open questions
| # | Question | Owner phase | Status |
|---|---|---|---|
| Q1 | Who posts the design in Discord, as CONTRIBUTING.md:19-26 requires for multi-package changes, and when? | 0 | Open: user action; doesn't block the fork work |
| Q2 | Install the fork omp on hub-host globally (`scripts/link-omp.sh`) or per session (`OMP_BIN`)? | 3 | Proposed: `OMP_BIN` for the first test session, then a global link once stable. The harness must be restarted under the fork to measure it. |
| Q3 | Keep the host fix for a second hello arriving mid-train (`dropPeer`) in PR 1, or split it into its own PR? | 4 | Proposed: keep it in PR 1 as its own commit, and split it out if the reviewer asks |

## Phase 0: Fork and baseline
Goal: the fork builds, its collab tests pass on unmodified code, and baseline numbers
are recorded.

Why first: every later phase needs a working, testable checkout.

Work items:
1. Create the fork, clone it to `~/src/oh-my-pi`, branch from upstream main, add the native addon, and run the tests. Ticket: [tail_p0_fork_setup](tickets/tail_p0_fork_setup.md).
2. Build a test session with images, large tool output, a compaction and an abandoned branch. Record its full-snapshot bytes and join time alongside the harness numbers. Ticket: [tail_p0_fixture_session](tickets/tail_p0_fixture_session.md).
3. Revalidate the phase 1–2 tickets against the fork base, since anchors are at `fd3f8e3`.
4. (User) Discord post (Q1).

Targets: `~/src/oh-my-pi` on hub-host.
Tests: the baseline test files pass:
- coding-agent: `chunked-welcome`, `replication-shrink`, `read-only`, `host-compaction-guest-sync`;
- collab-web: `client` and `transcript`.

Exit criteria:
- the fork and branch exist;
- the baseline tests are green;
- the test session and its numbers are recorded;
- the tickets are revalidated.

Workflow shape: one implementer agent (sonnet). No review loop, because there is no product code.

## Phase 1: Host and wire
Goal: a forked host serves a turn-aligned tail, history pages and full values under the
T1–T9 contract. Existing guests see no change.

Why this order: both guests depend on the wire types and host behaviour. The work can be
tested headlessly with the existing raw-guest harness (`read-only.test.ts:89-140`).

Work items:
1. Wire types in both declaration sites, plus the placeholder metadata type. Ticket: [tail_p1_wire_contract](tickets/tail_p1_wire_contract.md).
2. Tail selection, `welcome.history`, the `fetch-history` handler, and dropping a stale train on a re-hello. Ticket: [tail_p1_host_tail_history](tickets/tail_p1_host_tail_history.md).
3. Lossless placeholders: `collabElided` from the shrinker, in-place image placeholders, and the `fetch-value` handler with a hash check. Ticket: [tail_p1_host_lossless](tickets/tail_p1_host_lossless.md).

Targets: `packages/wire`, `packages/coding-agent/src/collab`.

Tests:
- the contract tests in each ticket;
- adversarial cases:
  - malformed `snapshot` field;
  - a single turn larger than the budget;
  - a cursor from an abandoned branch or a discarded entry;
  - a value mutated in place after the placeholder was sent;
  - 40 pages requested back-to-back without killing the room;
  - an old-style hello, which must produce a byte-identical full snapshot.

Exit criteria:
- all new and existing `test/collab/*` pass;
- `bun --cwd=packages/coding-agent run check` and `bun --cwd=packages/wire run check` are clean;
- a raw guest can page the whole test session back to its root, and the concatenation equals `getBranch()`.

Workflow shape: implementer on sonnet, test author on haiku, standard and adversarial
review on opus, looped. Item 1 lands first; items 2 and 3 can then run in parallel,
because they touch disjoint host functions. They share `host.ts`, so the item 2 agent
owns merges.

## Phase 2: Web guest
Goal: collab-web joins with a tail, loads earlier history without jumping the scroll
position, and loads any placeholder in full.

Why this order: it needs the phase 1 host. The TUI is out of scope (T5).

Work items:
1. Tail opt-in, publishing the assembled tail once, `fetchHistory`, prepending with a preserved scroll position, the "Load earlier" control plus automatic loading near the top, and reconnect cleanup. Ticket: [tail_p2_web_tail_history](tickets/tail_p2_web_tail_history.md).
2. Tap to load: whole-entry placeholders, image tiles, and clipped text in tool output through an optional `ToolRenderHost` method. Ticket: [tail_p2_web_load_full](tickets/tail_p2_web_load_full.md).

Targets: `packages/collab-web`.

Tests:
- unit tests in `test/client.test.ts` and `test/transcript*.test.tsx`;
- a scroll-anchor test;
- an old-host fallback test (no `history` in welcome, so behaviour is unchanged);
- `bun run gen:tool-views` still builds the HTML exports.

Exit criteria:
- the tests pass;
- `bun --cwd=packages/collab-web run check` is clean;
- a manual run against the phase 1 host on the test session is recorded with screenshots.

Workflow shape: as in phase 1. Item 2 depends on the entry-swap plumbing from item 1,
so they run sequentially.

## Phase 3: Hub integration and field test
Goal: our hub serves the fork guest, hub-host runs the fork host, and the harness session
joins fast on desktop and mobile.

Work items:
1. Point the submodule at the fork branch, rebuild the vendored guest, and install the fork omp on hub-host. Ticket: [tail_p3_hub_integration](tickets/tail_p3_hub_integration.md).
2. Stop the dashboard reloading the session when you click the one already open. Independent; can land any time. Ticket: [hub_reselect_guard](tickets/hub_reselect_guard.md).
3. Measure the harness and the test session on desktop and at 390×664: bytes, time to a usable prompt, loading earlier pages, tap to load an image. Write the results to `planning/YYYYMMDD_tail_snapshot_field_test.md`.

Targets: hub-host (`omp-hub` service, the harness session), the headless browser, a phone.

Tests:
- `bun run test` and `bunx playwright test` in `hub/`;
- the measurements from item 3.

Exit criteria:
- a harness join sends at most about 1.5 MB before the prompt is usable;
- no content is lost in the test session;
- the numbers are recorded.

Workflow shape: the main agent, plus one reviewer on opus.

## Phase 4: Upstream PR
Goal: an upstream-ready PR from `andrewleech:collab-tail-snapshot`.

Work items: ticket [tail_p4_upstream_pr](tickets/tail_p4_upstream_pr.md):
- rebase on the latest main;
- changelogs;
- `bun run check:ts`;
- a PR body that answers the triage questions, includes a sentence written by the user, and gives the end-to-end scenario and numbers.

**The user reviews and approves every push and the PR itself.**

Exit criteria: the PR is open, with the user's approval.

## Later (not scheduled)
- A field-profile PR, in which guests declare which fields they render (~45% of harness bytes).
- TUI follow-ups: resume-by-id, a compaction-boundary tail with `/collab history`, and `/collab expand`.
- An upstream bug report for the ungated TUI guest prompt paths.

## Rollout
The fork's guest works with a stock host (it falls back to the full snapshot), and a
stock guest works with the fork host. So hub-host can switch to the fork omp one session
at a time. After the upstream merge, point the submodule back at upstream and return
to stock omp (logistics §5).

## Risks
| Risk | Mitigation |
|---|---|
| #10462 lands with protocol 4 or its own `capabilities` | Optional fields only, named `history`/`snapshot`; rebase at phase 4 |
| Upstream drift during the work | Branch from current main (T13); rebase at phase 4; revalidate tickets at each phase entry |
| The maintainer rejects the design | Discord post first (Q1); the fork still serves our hub |
| The room dies from its send backlog while paging | Lazy `sendBatch` only (T8); a test for 40 back-to-back pages |
| Placeholder values change in place | Hash check returns `stale` (T2); an adversarial test |
| Tail guests no longer see abandoned branches | Documented in the PR (T6) |
| Prebuilt native addon doesn't match after a rebase | `git diff v<ver> HEAD -- crates packages/natives`; fall back to `bun run build:native` |
| collab-web `index.html` loads a third-party analytics script that our hub serves to users (web survey, finding 10) | Out of scope; separate hub decision |

## Progress tracking
- Each executed phase writes `planning/YYYYMMDD_tail_snapshot_phaseN.md` with its results and what was learned.
- This roadmap is updated in place.
- At the start of each phase, revalidate that phase's tickets using the procedure in `00_index.md`.
