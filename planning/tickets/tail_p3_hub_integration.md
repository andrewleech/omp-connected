# Hub: serve the fork guest and run the fork host on hub-host

Phase: 3 (tail snapshot)
Depends on: phases 1–2
Written: 2026-09-23 at HEAD c046df93c5 (upstream fd3f8e3c56)
Revalidated: pending phase entry
Revalidated: 2026-09-24 at fork 0e7a78e4d — partly executed: guest deployed from the local fork via `COLLAB_WEB_SRC` (no push); fork host measured on the phase 0 session through the hub (1.05 MB join, 0.55 s; image load 0.54 s); stock-host fallback confirmed. Blocked: submodule URL/pin (needs the branch pushed) and harness restart under the fork (Q2). See ../20260924_tail_snapshot_field_test.md.

## Context
T13 plus Q2 in the [roadmap](../20260923_collab_tail_snapshot_roadmap.md). The procedure is
in [logistics](../20260923_upstream_fork_logistics.md) §2 and §5. Collab stays unpatched: the
submodule simply tracks a different remote, and `hub/patches/` stays empty.

## Scope
In scope:
- the submodule URL, branch and pin;
- rebuilding the vendored guest;
- installing the fork omp on hub-host;
- field measurements.

Out of scope: dashboard behaviour changes (except `hub_reselect_guard`).

## Files and anchors
- `.gitmodules:1-3`: set `url = https://github.com/andrewleech/oh-my-pi.git` and `branch = collab-tail-snapshot`. For pushes, set `git config url."git@github.com:".pushInsteadOf https://github.com/` in the submodule.
- Run `git submodule sync`, pin the fork commit, and run `bun install --frozen-lockfile` inside the submodule (`build-vendor-collab.sh` doesn't install).
- `hub/scripts/build-vendor-collab.sh:12-25`: no change. `COLLAB_WEB_SRC` still works for local iteration.
- Deploy: `cd hub && bun run build`, then `systemctl --user restart omp-hub`.
- Fork host (Q2):
  - first a single session with `OMP_BIN=~/src/oh-my-pi/packages/coding-agent/scripts/omp ompc …` (`extension/bin/ompc:25-32`);
  - then `sh scripts/link-omp.sh` from the fork;
  - revert with `ln -sfn ../install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js ~/.bun/bin/omp`.
- Restarting the harness under the fork needs the user's go-ahead, because it's a live session.

## Design constraints
- The hub must keep working with stock hosts on other machines. The guest falls back automatically (T4).
- The committed `.gitmodules` must not use an ssh URL (CI and anonymous clones).

## Acceptance criteria and tests
- `bun run test` and `bunx playwright test` in `hub/` pass.
- Measurements (CDP on the relay socket; binary frames count at 3/4 of their base64 length), written to `planning/YYYYMMDD_tail_snapshot_field_test.md`:
  - harness join: bytes and time until the prompt is usable (goal: ≤ ~1.5 MB);
  - the phase 0 test session: the same numbers, plus every placeholder kind loading;
  - mobile (390×664): loading earlier history and tapping to load an image;
  - a stock host on another machine still joins, with the full snapshot.

## Workflow shape
The main agent, plus one reviewer on opus.

## Open questions
Q2: confirm the switch to a global install after the `OMP_BIN` trial.
