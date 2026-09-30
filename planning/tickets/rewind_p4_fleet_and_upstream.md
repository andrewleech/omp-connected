# Fleet rollout, field test and upstream PRs

Phase: 4
Depends on: phases 1 to 3
Written: 2026-09-30 at omp-connected 66a1466ed9, fork `ompc-fleet` f75ae39637
Revalidated: pending

## Context
The fleet runs a fork build from the local-only `ompc-fleet` branch (the binary at `~/.local/share/omp-connected/omp`, selected by `OMP_BIN` in `omp-host.env`). The hub serves collab-web built from the fork checkout.

## Scope
In scope:
- merging `collab-guest-leaf` and `collab-guest-rewind` into `ompc-fleet`;
- the fleet binary and hub rebuild;
- the field test;
- PR bodies for PR A and PR B;
- archiving the planning track once the PRs are up.

## Steps
1. **Merge.**
   - Check out `ompc-fleet` in `~/src/oh-my-pi`; don't create a worktree.
   - Merge both branches. If #13389 hasn't landed upstream, add the R6 tail rejoin hook-up in the merge commit or as a fleet-only commit.
   - Run `tsgo`, `bun test test/collab` (coding-agent) and `bun test` (collab-web).
2. **Rebuild.** Rebuild the fleet binary the way the previous fleet build was made, and record the command in the phase report. Then rebuild and restart the hub:

   ```sh
   cd hub && COLLAB_WEB_SRC=~/src/oh-my-pi/packages/collab-web bun run build
   systemctl --user restart omp-hub
   ```

   Running `ompc` sessions pick up the new binary only after a restart.
3. **Field test** on hub-host with a throwaway session:
   - host esc-esc: collab-web (control), hub viewer (view) and a TUI guest all follow;
   - guest rewind from desktop collab-web and from a phone-sized viewport;
   - TUI guest esc-esc;
   - read-only link: no Rewind button;
   - a rewind while streaming is refused;
   - a tail-joined guest rewound past its window rejoins.

   Record the results in `planning/<date>_rewind_field_test.md`.
4. **PR bodies.** Draft them with the `draft-pr` and `writing-style` skills in `planning/pr-drafts/`: PR A (leaf sync, fixes B1 to B3) and PR B (guest rewind), linking the upstream issue.
   - Changelog entries go under `## [Unreleased]` in each touched package.
   - Pushes to `origin` and opening PRs each need the user's explicit approval. Never push to `upstream`.
5. **Archive.** Move this track to `planning/archive/collab-rewind/` once the PRs are open, and fix the links in `00_index.md`.

## Acceptance criteria
- The fleet runs the merged build, and the field test report covers every step 3 item.
- The PR drafts are approved by the user before anything is pushed or opened.
- The omp-connected scrub greps are clean before any push of this repo.

## Workflow shape
Main agent. A haiku tester runs the fork suites after the merge.

## Open questions
None beyond the design's.
