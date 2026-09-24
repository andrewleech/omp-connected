# Upstream: open the tail-first snapshot PR from the fork

Phase: 4 (tail snapshot)
Depends on: phases 1–3; Q1 (Discord post)
Written: 2026-09-23 at HEAD c046df93c5 (upstream fd3f8e3c56)
Revalidated: pending phase entry
Revalidated: 2026-09-25 at fork 81d60947f on upstream/main ba56afb26. #10462, #11371 and #11861 are still open. Upstream added its own large-session fixes to collab-web (460cb4b1e, aebd04525, 16076dc27: a 100-row render window, buffered snapshot publishing and a progress banner). The rebase merged them with ours: upstream's buffered snapshot replaced our `#tailPending`; the window pins by entry id, so history prepends and fresh tails keep the reader's rows mounted; held rows are mounted before the host is asked for more; one scroll-anchor path. The re-hello `dropPeer` fix is its own commit, 088dda5eb (Q3), and its test fails without the fix. Changelogs are committed. Checks: `check:ts` clean; collab tests 268 pass; collab-web tests 127 pass. Browser check on the fixture: join 0.35 s, paged to Turn 0 (1194 unique rows, max drift 1 px), trims back to the tail at the bottom. Not pushed; waiting on approval and Q1.

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
