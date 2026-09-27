# Fork: create andrewleech/oh-my-pi and a working, tested checkout

Phase: 0 (tail snapshot)
Depends on: none
Written: 2026-09-23 at HEAD c046df93c5 (upstream fd3f8e3c56)
Revalidated: pending phase entry
Revalidated: 2026-09-23 at fork base a1b3b83a7f — executed; see ../20260923_tail_snapshot_phase0.md

## Context
T13 in [design](../20260923_collab_tail_snapshot_design.md). The procedure is from
[logistics](../20260923_upstream_fork_logistics.md) §1-2 and §5-6, which is marked
`[INFERENCE]` because it hasn't been run. Upstream main is 454 commits ahead of our pin.

## Scope
In scope:
- the GitHub fork;
- a clone outside the submodule;
- branch `collab-tail-snapshot` from upstream main;
- dependencies and the prebuilt native addon;
- a green baseline on the collab tests.

Out of scope: product changes (phase 1); submodule changes (phase 3).

## Files and anchors
- `gh repo fork can1357/oh-my-pi --clone=false`. **Requires user approval**: it's a visible write to the user's GitHub account.
- Clone to `~/src/oh-my-pi`, then `git remote add upstream https://github.com/can1357/oh-my-pi.git`.
- Branch with `git switch -c collab-tail-snapshot upstream/main`. Record the base SHA.
- Install dependencies with `bun install --frozen-lockfile`. The root `prepare` script regenerates tool views (`package.json:154`).
- Native addon (logistics §1):
  - `v=$(jq -r .version packages/natives/package.json)`;
  - check `git diff --quiet v$v HEAD -- crates packages/natives Cargo.toml Cargo.lock`;
  - copy `pi_natives.linux-x64-*.node` from `npm view @oh-my-pi/pi-natives-linux-x64@$v dist.tarball` into `packages/natives/native/`;
  - if the diff isn't empty, run `bun run build:native` instead. It needs Rust `nightly-2026-08-12` (`rust-toolchain.toml:2`).
- Smoke check: `bun packages/coding-agent/src/cli.ts --version`.

## Design constraints
- Never touch `hub/vendor/collab-web`.
- Don't push anything beyond creating the branch until the user approves.

## Acceptance criteria and tests
- `gh repo view andrewleech/oh-my-pi` resolves, with parent `can1357/oh-my-pi`.
- `cd packages/coding-agent && bun test test/collab/chunked-welcome.test.ts test/collab/replication-shrink.test.ts test/collab/read-only.test.ts test/collab/host-compaction-guest-sync.test.ts` passes.
- `cd packages/collab-web && bun test test/client.test.ts test/transcript.test.tsx` passes.
- The base SHA and the test counts are written to `planning/YYYYMMDD_tail_snapshot_phase0.md`.

## Workflow shape
A single implementer agent (sonnet). The fork creation waits for user approval.

## Open questions
None.
