# Upstream: open the tail-first snapshot PR from the fork

Phase: 4 (tail snapshot)
Depends on: phases 1–3; Q1 (Discord post)
Written: 2026-09-23 at HEAD c046df93c5 (upstream fd3f8e3c56)
Revalidated: pending phase entry
Revalidated: 2026-09-25 at fork 81d60947f on upstream/main ba56afb26. #10462, #11371 and #11861 are still open. Upstream added its own large-session fixes to collab-web (460cb4b1e, aebd04525, 16076dc27: a 100-row render window, buffered snapshot publishing and a progress banner). The rebase merged them with ours: upstream's buffered snapshot replaced our `#tailPending`; the window pins by entry id, so history prepends and fresh tails keep the reader's rows mounted; held rows are mounted before the host is asked for more; one scroll-anchor path. The re-hello `dropPeer` fix is its own commit, 088dda5eb (Q3), and its test fails without the fix. Changelogs are committed. Checks: `check:ts` clean; collab tests 268 pass; collab-web tests 127 pass. Browser check on the fixture: join 0.35 s, paged to Turn 0 (1194 unique rows, max drift 1 px), trims back to the tail at the bottom. Not pushed; waiting on approval and Q1.
Revalidated: 2026-09-25 at fork 6bc68eae0 on upstream/main ba56afb26, not pushed. Independent reviews (correctness and style) found no blockers in the design, but found one P1: the guest's welcome timer outlived reconnect backoff, so a long host outage ended the session. That is fixed, and first joins keep upstream's 30 s deadline. Also fixed: trimmed images in renderers without an image strip (P2); stale-cursor rejoins ending the session on a stray error; value slices over the 1 MiB frame cap; a landed page hiding behind "show N earlier". Style: private design references removed, formatter churn reverted, fixture scaffolding dropped, docs/collab.md updated, changelogs cut to one line. The history is folded to 6 commits, so Q3 is reversed: the re-hello fix now lives in the host tail commit, because only this branch's guest triggers it. Each commit type-checks and passes the collab tests (coding-agent 271, collab-web 132). Browser check on the fixture: held rows mount first, then each page mounts in place (anchor drift under 1 px); the 1 MB index result and the 2.7 MB screenshot both load.
Revalidated: 2026-09-25 at fork 2d014a81e on upstream/main ba56afb26, pushed to origin (force over 81d60947f). Web guest tests trimmed from 891 to 561 added lines to match repo conventions: `load-full.test.tsx` folded into `client.test.ts`, new `elided.test.ts`, `tool-view.test.tsx` and `transcript.test.tsx`; paging tests 15 → 10. Each web commit type-checks and passes alone (115, then 123 tests). Mutation checks on dedupe and stale-rejoin still fail the trimmed tests. Branch totals +3,931/−176 across 6 commits. Remaining: Discord post, the user's own sentence for the PR body, then PR approval.
Revalidated: 2026-09-26 at fork 2d014a81e, PR opened as https://github.com/can1357/oh-my-pi/pull/13389 with the body from `pr-drafts/collab-tail-snapshot.md` (rewritten in the user's words). Changelog entries amended locally to link #13389 with attribution (fork c128fd1f0), not pushed yet. CI and the published-body readback are still to do.
Revalidated: 2026-09-26 at fork c128fd1f0, force-pushed over 2d014a81e with approval; the PR head is now c128fd1f0 (changelogs link #13389 with attribution, per upstream AGENTS.md:39). `gh pr checks` reports no checks yet, so CI is still to confirm.
Revalidated: 2026-09-27 at fork abc0446c6 (local, not pushed), rebased onto upstream/main 83c9df0ab: one test conflict in replication-shrink.test.ts (kept upstream's removal of the oversized-entry block), changelog entries moved back under [Unreleased]. Review fixes squashed into their commits: one history page in flight per peer, no repeat "joined" notice on a re-hello, docs wording, a `### Changed` changelog entry for image placeholders, backpressure tests without real timers, and Transcript scroll anchoring moved out of render into a getSnapshotBeforeUpdate class component (checked in Chromium with native scroll anchoring off). tsgo/oxlint clean; collab tests 275 + 122 pass.
Revalidated: 2026-09-27 at fork abc0446c6, force-pushed over c128fd1f0 with approval; PR head is abc0446c6, GitHub reports MERGEABLE.

## Context
Rules are in [logistics](../20260923_upstream_fork_logistics.md) §3–4. The PR body answers
the #9469 triage questions (see the table at the end of the [design](../20260923_collab_tail_snapshot_design.md)).

## Scope
In scope:
- rebase;
- changelogs;
- checks;
- the PR body;
- opening the PR.

Out of scope: the TUI follow-up and the field-profile PR (listed under "Later" in the roadmap).

## Files and anchors
- Rebase `collab-tail-snapshot` on the latest `upstream/main`. Re-run phase 1–2 tests.
- Check again whether #10462, #11371 and #11861 have merged, and resolve any conflicts.
- Changelogs: one line under `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md`, `packages/collab-web/CHANGELOG.md` and `packages/wire/CHANGELOG.md`. Link #9469, #9328 and #11859; add `([#N](…/pull/N) by [@andrewleech](https://github.com/andrewleech))` once the PR number exists.
- Checks: `bun run check:ts`, the collab test files, and the collab-web tests.
- Commits: Conventional Commits with scope `collab` or `collab-web`; the re-hello `dropPeer` fix in its own commit (Q3).
- PR body (`.github/PULL_REQUEST_TEMPLATE.md`):
  - What, Why (`fixes #9469`, refs #9328 and #11859), Testing;
  - **at least one sentence written by the user** (CONTRIBUTING.md:55-62);
  - the end-to-end scenario with harness numbers from phase 3;
  - the answers to the triage questions;
  - the change that tail guests no longer see abandoned branches (T6).
- Use the `draft-pr` skill to write the description.

## Design constraints
- **No push and no PR without the user's explicit approval**, each time.
- Never push to `can1357/oh-my-pi`; the PR goes from `andrewleech:collab-tail-snapshot`.

## Acceptance criteria and tests
- The PR is open, CI is green, and the published body has been read back and checked (AGENTS.md:33-40).

## Workflow shape
The main agent drafts; the user approves; the main agent opens the PR.

## Open questions
Q1 (Discord post) must be resolved first.
