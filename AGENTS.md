# omp-connected

Fleet dashboard and agent messaging for [Oh My Pi](https://github.com/can1357/oh-my-pi) (omp) sessions. README.md covers install and usage; hub/ARCHITECTURE.md and extension/ARCHITECTURE.md hold the wire protocol and module detail. Read those before changing protocol or registration.

## Layout

- `extension/`: omp plugin loaded into every session (`src/index.ts` is the entry), plus the `ompc` tmux launcher (`bin/ompc`, `bin/omp-tmux.conf`). It registers the session with the hub over `/ws/agent` (`hub-transport.ts`, `protocol.ts`), reports turn activity, serves the dashboard's per-session RPCs in-process (`session-rpc.ts`, `files-rpc.ts`, `scheduled-prompts.ts`) and does Collab discovery (`collab-registry.ts`). Tests in `test/` (unit, integration against a real hub process); they need omp installed, so `load.test.ts` and a couple of `ompc.test.ts` cases fail without it.
- `hub/`: always-on Bun server.
  - `src/server/`: HTTP and websocket routes, the agent registry, dashboard events (`/ws/dashboard`), config.
  - `src/relay/`: the private Collab relay; it only forwards encrypted frames.
  - `src/webui/`: the dashboard, plain TypeScript with no framework (`app.ts`, `index.html`, PWA files). `scripts/build-webui.ts` builds it into `dist/webui`.
  - `dist/webui/collab/`: the Collab web guest the dashboard embeds in an iframe. It is not built from this repo's sources; see below.
  - `tests/`: `server`, `relay`, `webui` (bun test) and `e2e` (Playwright against `tests/e2e/fixture-server.ts`, a fake hub).
- `install.sh`: installs the extension and `ompc` on a host. `planning/`: design notes and archived work.
- Commands (from `hub/`): `bun run test`, `bun run test:e2e`, `bun run lint`, `bun run scripts/build-webui.ts`.

## What goes in the omp fork

Anything that has to change omp itself rather than this repo lives in a fork of omp, `andrewleech/oh-my-pi`: Collab host and guest protocol, the Collab web guest (`packages/collab-web`), relay behaviour, anything needing omp internals the extension API doesn't expose. Do not patch omp or the guest here and do not edit `hub/dist/webui/collab` or `hub/vendor/collab-web` by hand.

- One feature or fix per branch, branched from `upstream/main`, so each can become an upstream PR independently. Never push to `can1357/oh-my-pi`.
- Never commit directly to the integration branch `ompc-fleet`. It is rebuilt from the feature branches by mbm, so direct commits are lost on the next refresh.
- The omp binary used by `ompc` and the hub's Collab guest are both built from `ompc-fleet`. Build the guest with `COLLAB_WEB_SRC=<fork checkout>/packages/collab-web`; a plain `build:collab` uses the old vendored guest and drops fork features. Restart the hub afterwards, since it registers static files at startup.
- README.md "Fork build of OMP" describes the build and deploy of both.

## Using mbm

The integration branch is managed with `mbm` ([micropython-branch-manager](https://github.com/andrewleech/micropython-branch-manager), `uv tool install micropython-branch-manager`). Its config is a local, untracked `.omp/mbm.toml` listing the submodule path of the fork checkout, `integration_branch = "ompc-fleet"`, `target = "upstream/main"` and one `[[submodules.branches]]` entry per feature branch.

- New fork change: create the branch off `upstream/main`, commit, push it to the fork's `origin`, add a `[[submodules.branches]]` entry (`name`, `title`, `author`; add `pr_url` and `pr_number` once a PR exists), then merge it into `ompc-fleet` with `mbm rebase` (or `mbm add-pr` for an existing PR).
- Refresh onto a new upstream: `mbm rebase --config .omp/mbm.toml` rebuilds `ompc-fleet_update` by rebasing and merging every listed branch. Check it, then reset `ompc-fleet` to it (`--apply`). Use `--dry-run` first when unsure.
- PR branches are fetched from GitHub's `pull/N/head`, so push PR branch changes before refreshing. Fork-only branches (no PR) are taken from the local branch.
- `update_feature_branches = false`: mbm never moves or pushes the feature branches; they stay on `upstream/main`.
- Merged PRs are dropped automatically; delete their entries when convenient.

## Rules for tracked files

Tracked files never contain real deployment details: use `hub-host`, `your-tailnet.ts.net`, `/home/user` and `user@hub-host` style placeholders in docs, tests, examples and commit messages. The real values live only in untracked local files (`CLAUDE.local.md`, `.omp/`, env files under `~/.config`), which also hold the deploy and refresh procedures and a leak-check command to run before every push.
