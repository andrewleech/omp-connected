# Upstream fork logistics: build, install, test and contribute for tail-first Collab snapshot

Date: 2026-09-23
HEAD: c046df93c5 (omp-connected)
Upstream: fd3f8e3c56

All upstream paths are relative to the monorepo root (`hub/vendor/collab-web` on disk) at fd3f8e3c56. Paths under `omp-connected/` are our repo. `[INFERENCE]` marks anything not executed or observed.

---

## 1. Monorepo tooling

**Workspaces and catalog**
- Root workspaces are `packages/*` and `python/robomp/web` (`package.json:7-11`). Shared versions come from a Bun `catalog` (`package.json:12-73`). Every `@oh-my-pi/*` package is pinned there to the last release, `18.2.8` (`package.json:17-28`), and packages refer to it as `"catalog:"` (e.g. `packages/coding-agent/package.json:532-557`).
- `bunfig.toml` sets `linker = "hoisted"`, `exact = true` and `minimumReleaseAge = 259200` (3 days). Because of the release-age rule, a freshly published third-party dep can't be installed until it is 3 days old.
- The root `prepare` script runs `gen:tool-views` on every `bun install` (`package.json:154`). It writes the ignored `packages/coding-agent/src/export/html/tool-views.generated.js`.

**Bun version**
- Root `"packageManager": "bun@>=1.4"` (`package.json:207`). CI enforces this floor in `.github/actions/bun-install/action.yml:14-40`.
- `packages/coding-agent` has `engines.bun >=1.3.14` (`packages/coding-agent/package.json:566-568`). The installer uses the same minimum (`scripts/install.sh:16`).
- Local Bun is 1.4.2 (`bun --version`), so it meets both.

**Key root scripts** (`package.json:76-169`)
- `dev`: `bun --cwd=packages/coding-agent src/cli.ts` (`:78`)
- `setup`: `bun scripts/setup.ts` (`:77`)
- `build:native` (`:88`)
- `collab:web:build` (`:84`)
- `check` = `check:ts` + `check:rs` (`:93`)
- `check:ts` = `oxlint` + `oxfmt --check` + per-package `tsgo` (`:94-95`)
- `ci:check:full` = `check:ts` (`:113`)
- `ci:test:*` buckets (`:113-124`)
- `fmt` / `fix` (`:101-112`)

**How `packages/coding-agent` produces `dist/cli.js`**
- The repo manifest has `"bin": { "omp": "src/cli.ts" }` (`packages/coding-agent/package.json:27-29`), so a source checkout runs TS directly with no build step.
- `dist/cli.js` comes from `prepack` → `gen:tool-views` + `gen:bundle` (`packages/coding-agent/package.json:525-529`). `gen:bundle` is `bun scripts/bundle-dist.ts`, which runs `Bun.build` with entry `src/cli.ts`, `target: "bun"` and minify (`packages/coding-agent/scripts/bundle-dist.ts:75-117`).
- Only `@oh-my-pi/pi-natives`, `@huggingface/transformers`, `fastembed`, `onnxruntime-node`, `puppeteer-core` and `@babel/parser` stay external (`bundle-dist.ts:16,25`). Everything else is inlined, including `@oh-my-pi/pi-wire`, where the collab frame grammar lives (`packages/wire/src/index.ts:325-350`, `COLLAB_PROTO = 3` at `:397`). So a fork's `dist/cli.js` carries its own wire changes. I checked the installed 18.2.9 bundle: its only `@oh-my-pi/*` imports are `pi-natives` and one `omptype` import.
- The publish step rewrites `bin.omp` from `src/cli.ts` to `dist/cli.js` (`scripts/ci-release-publish.ts:11-17,165`, function `applyPublishBin`). It also repoints `types` to `dist/types`.
- `bun run build` in coding-agent (`bun scripts/build-binary.ts`, `packages/coding-agent/package.json:517`) builds a single-file compiled binary, `packages/coding-agent/dist/omp` (`scripts/install-tests/run-ci.sh:90-94`).

**Natives (`packages/natives`): Rust, or prebuilt?**
- The loader is `packages/natives/native/index.js` → `loader-state.js`. No `.node` is committed (`*.node` in `.gitignore:13`), and the vendor checkout currently has none.
- `bun --cwd=packages/natives run build` → `scripts/bazel-natives.ts host --dest native` (`packages/natives/package.json:32`). The `host` target defaults to a local Cargo/N-API build (`packages/natives/scripts/build-bindings.ts:1-10`); Bazel is opt-in (`scripts/bazel-natives.ts:21-26`, `scripts/setup.ts:4-7`).
- A from-source build needs the pinned Rust toolchain `nightly-2026-08-12` (`rust-toolchain.toml:2`). Locally, `cargo` and `rustup` exist but only stable and numbered toolchains are installed; rustup would fetch the nightly on first build `[INFERENCE]`.
- Prebuilt binaries are an alternative. Upstream PR CI does not build Rust at all: it downloads `@oh-my-pi/pi-natives-linux-x64@latest` from npm and copies `pi_natives.linux-x64-{baseline,modern}.node` into place (`.github/workflows/ci.yml:226-237`).
- In a workspace checkout (addon dir not under `node_modules`), the loader looks only in `packages/natives/native/` and the exec dir (`loader-state.js:156-186,803-812`). It also skips the version-sentinel check (`loader-state.js:680-686`).
- So copying the npm leaf's `.node` files for the matching version into `packages/natives/native/` gives a working workspace with no Rust.
- At fd3f8e3c56 this is exact: `git diff --stat v18.2.8 fd3f8e3c56 -- crates packages/natives Cargo.toml Cargo.lock` is empty, and `@oh-my-pi/pi-natives-linux-x64@18.2.8` exists on npm.
- Caveat: if the fork is rebased past a Rust change, the prebuilt addon for the catalog version may lack new exports. Re-check with the same diff and fall back to `bun run build:native`.
- Confirmed by running it: `bun test test/collab/replication-shrink.test.ts` in the vendor checkout fails at `loadNative` (`packages/natives/native/loader-state.js:895`). **Coding-agent collab tests need the addon.** `collab-web` tests do not (`bun test test/codec.test.ts` → 3 pass).

---

## 2. Running and installing omp from a source checkout

**Documented source paths**
- README "Getting started from source": `bun setup && bun dev` (`README.md:593-602`). Nix users run `nix develop` first (`README.md:604-610`). Smoke check: `bun dev -- --version` (`README.md:620-624`).
- `bun setup` runs, in order: `bun install`, `build:native` (Rust), `bun --cwd=packages/coding-agent link`, `sh scripts/link-omp.sh` (`scripts/setup.ts:30-35`).
- `scripts/link-omp.sh` symlinks `$(bun pm -g bin)/omp` (i.e. `~/.bun/bin/omp`) to the dev wrapper `packages/coding-agent/scripts/omp` (`scripts/link-omp.sh:16-30`).
  - The wrapper `cd`s into `~/.omp/.dev-cwd` before `exec bun … src/cli.ts`, so a caller's `bunfig.toml` preload can't leak in (`packages/coding-agent/scripts/omp:4-38`).
- `scripts/install.sh --source --ref <ref>` clones **`can1357/oh-my-pi`** (hard-coded `REPO`, `scripts/install.sh:13,186-190`) into a temp dir. It runs `bun install -g $TMP_DIR/packages/coding-agent` and then deletes the temp dir (`:183-206`). It can't target a fork, and the installed tree would point at a deleted checkout if Bun links rather than copies `[INFERENCE]`. **Don't use it.**
- Tarball route, as CI does it (`scripts/install-tests/run-ci.sh:146-160`):
  1. `applyPublishBin("packages/coding-agent", true)` swaps `bin` to `dist/cli.js`.
  2. `bun pm pack` (prepack builds `dist/cli.js`).
  3. Restore `package.json`.
  - The CI smoke then installs all packed tarballs with `overrides` (`run-ci.sh:185-206`).
- Dev entry with no install: `bun packages/coding-agent/src/cli.ts …` (the `ci:test:smoke` script uses exactly this, `package.json:123`), or `bun dev`.

**Currently installed global omp** (`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/package.json`)
- `version` is `18.2.9` (`:3`).
- `bin.omp = "dist/cli.js"` (`:27-29`). `~/.bun/bin/omp` is a symlink to `../install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`.
- `files` adds `LICENSE`, `THIRD-PARTY-NOTICES.txt` and `dist/types` compared with the repo manifest (`:30-47`). `types` → `./dist/types/index.d.ts` (`:50`). These are publish-time rewrites.
- Dependencies are exact `18.2.9` for all 11 `@oh-my-pi/*` packages (`:535-547`). Third-party ranges (`^…`) are resolved from catalog (`:536,548-560`).
- `~/.bun/install/global/package.json` lists `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-natives` and `@oh-my-pi/pi-natives-linux-x64` as top-level deps, all at `18.2.9`. `omp update` deliberately pins the natives and the platform leaf next to the agent, because `bun install -g` doesn't reliably refresh transitive optional deps and the loader's version sentinel would then fail (`packages/coding-agent/src/cli/update-cli.ts:1441-1467`).
- All `@oh-my-pi/*` packages in the global tree are npm-resolved at 18.2.9. None are links.
- npm `latest` is now `18.2.11`. A fork build reporting 18.2.8 will show the startup update notice, and `omp update` would overwrite it with the npm release `[INFERENCE: notice logic not traced]`.

**Recommended swap: symlink-only (most reliable and reversible)**

This leaves `~/.bun/install/global` untouched, so reverting is a single symlink. Untested; every step is `[INFERENCE]`.

```sh
# one-time: fork checkout outside the pristine submodule
git clone git@github.com:andrewleech/oh-my-pi.git ~/src/oh-my-pi   # fork must exist first (see §5)
cd ~/src/oh-my-pi && git checkout collab-tail-snapshot
git remote add upstream https://github.com/can1357/oh-my-pi.git
bun install --frozen-lockfile
# prebuilt natives, no Rust; version must match packages/natives/package.json
v=$(jq -r .version packages/natives/package.json)
git diff --quiet "v$v" HEAD -- crates packages/natives Cargo.toml Cargo.lock || echo "natives changed: run bun run build:native instead"
tmp=$(mktemp -d); curl -fsSL "$(npm view @oh-my-pi/pi-natives-linux-x64@$v dist.tarball)" | tar -xz -C "$tmp"
cp "$tmp"/package/pi_natives.linux-x64-*.node packages/natives/native/
bun packages/coding-agent/src/cli.ts --version

# swap global omp -> fork source (also what `bun setup` does last)
sh scripts/link-omp.sh
# swap back to the npm install (restores the exact prior symlink)
ln -sfn ../install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js ~/.bun/bin/omp
```

- **Non-global alternative.** Our `ompc` honours `OMP_BIN` (`omp-connected/extension/bin/ompc:25-32`, `extension/README.md:23`). So `OMP_BIN=~/src/oh-my-pi/packages/coding-agent/scripts/omp ompc …` runs the fork for one session without touching the global `omp`.
- **Bundled-artifact alternative (closest to a release; changes the global tree).** Pin natives in the same call, like `omp update` does:

```sh
cd ~/src/oh-my-pi
cp packages/coding-agent/package.json /tmp/ca-pkg.json
bun -e 'import { applyPublishBin } from "./scripts/ci-release-publish.ts"; await applyPublishBin("packages/coding-agent", true);'
(cd packages/coding-agent && bun pm pack --destination /tmp/omp-fork)
cp /tmp/ca-pkg.json packages/coding-agent/package.json
v=$(jq -r .version packages/coding-agent/package.json)
bun install -g /tmp/omp-fork/oh-my-pi-pi-coding-agent-$v.tgz @oh-my-pi/pi-natives@$v @oh-my-pi/pi-natives-linux-x64@$v
# back
bun install -g --no-cache @oh-my-pi/pi-coding-agent@18.2.9 @oh-my-pi/pi-natives@18.2.9 @oh-my-pi/pi-natives-linux-x64@18.2.9
```

  - `bun pm pack` must resolve `catalog:` to concrete versions `[INFERENCE]`. The CI tarball smoke depends on this: it overrides only `@oh-my-pi/*` (`run-ci.sh:185-206`), and the 18.2.9 manifest shows resolved ranges.
  - A **compiled-binary** variant also works: `bun --cwd=packages/coding-agent run build`, then use `packages/coding-agent/dist/omp` via `OMP_BIN` or a PATH entry. It embeds the addon and validates its version against `packages/natives/package.json` (`run-ci.sh:54-95`).

---

## 3. Test commands, CI, and required checks

**Running tests locally**
- One coding-agent collab test file (needs the native addon, see §1): `cd packages/coding-agent && bun test test/collab/<file>.test.ts`.
  - Existing collab suites live in `packages/coding-agent/test/collab/`. The ones most relevant to snapshot work are `chunked-welcome`, `session-replication`, `replication-shrink`, `host-peer-left-queue`, `relay-client-*`, `host-compaction-guest-sync` and `discarded-entry-marker`.
- collab-web: `cd packages/collab-web && bun test test/<file>.test.ts` (verified: `test/codec.test.ts` → 3 pass). The whole package: `bun run test` = `bun test --parallel` (`packages/collab-web/package.json:32`).
  - Relevant files: `client.test.ts`, `socket-reconnect.test.ts`, `transcript*.test.tsx`, `codec.test.ts`, `local-relay.test.ts`.
- wire: the `packages/wire` tests run in the fast workspace bucket (`scripts/ci-test-ts.ts:88-97`).
- Bucket runners: `bun run ci:test:coding-agent:runtime` (includes every `test/collab/` file, `scripts/ci-test-ts.ts:135-138`), `bun run ci:test:ts:native` (includes `packages/collab-web`, `scripts/ci-test-ts.ts:102-107`), and `bun run ci:test:ts:workspace`.
  - `packages/coding-agent`'s own `test` script runs everything (`coding-agent-heavy --full`, `packages/coding-agent/package.json:521`). Avoid it for iteration.

**Checks for a PR**
- PR template checkbox: "`bun check` passes" (`.github/PULL_REQUEST_TEMPLATE.md:15`). `bun check` = `check:ts` + `check:rs` (`package.json:93`). CI's gate is `ci:check:full` = `check:ts` only (`package.json:113`, `.github/workflows/ci.yml:163-164`). For a TS-only change, `bun run check:ts` (repo-wide oxlint + oxfmt + per-package `tsgo`) is the practical gate.
- Per package: `bun --cwd=packages/<pkg> run check` for `coding-agent`, `collab-web` and `wire` (e.g. `packages/collab-web/package.json:33-34`).
- Autofix: `bun run fix:ts`, or per package `bun run fix`.
- `lint-staged` runs `oxlint --fix` + `oxfmt` on staged TS (`package.json:189-206`).
- Never run `tsc` directly (`AGENTS.md:261`, `packages/coding-agent/DEVELOPMENT.md:25`).
- After changing `collab-web/src/tool-render/`, run `bun run gen:tool-views` (`DEVELOPMENT.md:25-27`).

**CI workflow** (`.github/workflows/ci.yml`; the other workflows are `nix.yml` and `bazel-cache-warm.yml`)
- Triggers on `pull_request` to `main`/`omp2` for `packages/**` and similar paths (`:33-50`).
- Jobs relevant to this change:

| Job | Lines | What it runs |
|---|---|---|
| `check` | `:146-166` | `ci:check:full` + `collab:web:build` |
| `native_addons` | `:220-266` | PR path fetches release addons from npm, no Rust |
| `test_workspace` | `:328-350` | includes `packages/wire` |
| `test_ts_native` | `:369-385` | includes `packages/collab-web` |
| `test_coding_agent_runtime` | `:405-423` | includes `test/collab/` |
| `test_smoke` | `:443-457` | CLI smoke |
| `install_methods` | `:459-474` | `ci:test:install-methods` |

- The `install_methods` job asserts **`COLLAB_PROTO` is `3`** (`scripts/install-tests/run-ci.sh:215-219`). This matches the settled "do not bump proto" rule: a bump would fail CI unless that assertion changed too.
- Rust validation is skipped on PRs (`ci.yml:173-175`).

---

## 4. Contribution conventions

**CONTRIBUTING.md**
- PRs are open to everyone as a trial (`CONTRIBUTING.md:6-10`).
- **Major features, or changes spanning several packages, should be discussed in Discord before implementation** (`:19-26`). Tail-first snapshot touches `wire`, `coding-agent` and `collab-web`, so post the design, from issue #9469, before the PR.
- Don't open a new issue for work you're about to submit; link the existing one (#9469, plus #9328 and #11859) (`:28-36`).
- AI-assisted work must be scoped, reviewed and personally verified (`:38-51`).
- The PR body **must contain at least one sentence written by the human contributor** (`:55-62`) and report the exact end-to-end scenario exercised (`:64-76`).
- One logical change per PR (`:78-80`).
- MIT; no CLA or DCO (`:82-91`).

**PR template** (`.github/PULL_REQUEST_TEMPLATE.md:1-17`)
- Sections: `## What` / `## Why` (with `fixes #N`) / `## Testing`.
- Checklist: `bun check`, tested locally, CHANGELOG updated with attribution.
- `AGENTS.md:33-40` repeats these rules and requires reading back the published PR body.

**Changelog** (`AGENTS.md:316-340`)
- Each package has its own `packages/*/CHANGELOG.md`. New entries go under `## [Unreleased]`, grouped under `### Breaking Changes` / `### Added` / `### Changed` / `### Fixed` / `### Removed`.
- One line each, user-facing. Released sections are immutable. Ordering and formatting are normalized by `bun run release` / `fix:changelogs`.
- Attribution for an external PR: `… ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@user](https://github.com/user))`. Add it after the PR number exists, alongside the issue link.
  - Example from a similar collab change: `packages/coding-agent/CHANGELOG.md:311` (`([#11433](…/issues/11433); [#11999](…/pull/11999) by [@MertSoylu](…))`).
- Both affected changelogs currently start with `## [Unreleased]` at line 3 (`packages/coding-agent/CHANGELOG.md:3`, `packages/collab-web/CHANGELOG.md:3`).
- AGENTS.md tells agents "NEVER update changelogs unless explicitly asked" (`AGENTS.md:320`). For a contributor PR the template checkbox is the ask, so the contributor adds the entry.

**Commit style**
- Conventional Commits, `type(scope): subject`, lower-case. Recent subjects often use past tense ("fix(collab): flushed host goodbye before teardown", "feat(catalog): repoint singularityapi …"); some use the imperative.
- Collab work uses scopes `collab` and `collab-web` (see `git log -- packages/coding-agent/src/collab packages/collab-web packages/wire`).
- Type frequency over the last 2000 non-merge commits: fix 1356, test 168, docs 164, feat 121, chore 61, refactor 38, perf 36, style 22. Only 12 were non-conventional.
- Maintainer merges appear as `Merge pull request #N from user/branch` in `git log --oneline -30`. `AGENTS.md:263` documents `Merge PR #N: <subject> (@author)`.
- Issue refs go in the PR body (`fixes #N`) and changelog links, not usually in subjects.

---

## 5. Our side: pointing the submodule at the fork

**Current state**
- `.gitmodules:1-3` has `path = hub/vendor/collab-web` and `url = https://github.com/can1357/oh-my-pi.git`, with no `branch =`. The gitlink pin is `fd3f8e3c569b…` (`git submodule status`, describes as `v18.2.8-30-gfd3f8e3c56`).
- `.git/config` holds the same URL. The submodule's `remote.origin.url` is the can1357 HTTPS URL.
- `.gitmodules` and the `hub/vendor/collab-web` gitlink are **staged but not yet committed**: `git status` shows `A` for both, and `git ls-tree HEAD` has neither at c046df93c5. `hub/scripts/build-vendor-collab.sh` has uncommitted working-tree edits. The fork switch below can go into that first commit rather than a follow-up.

**How the hub consumes it**
- `hub/scripts/build-vendor-collab.sh:12` builds from `COLLAB_WEB_SRC` (default `hub/vendor/collab-web/packages/collab-web`). It runs `bun run build` there (`:21`) and copies `dist/.` into `hub/dist/webui/collab` (`:23-25`).
- It does **not** run `bun install`. The submodule's `node_modules/` (gitignored, with workspace symlinks such as `node_modules/@oh-my-pi/pi-wire -> ../../packages/wire`) must already exist. After moving the pin, run `bun install --frozen-lockfile` in `hub/vendor/collab-web` whenever `bun.lock` changed.
- Because of the symlinks, fork changes to `packages/wire` reach the guest build automatically.
- `hub/package.json:16-17`: `build:collab`; `build` = `build:webui && build:collab`. `hub/README.md:58-61` documents the `COLLAB_WEB_SRC` override.
- Our CI (`.github/workflows/hub-browser.yml:20`) uses `actions/checkout@v4` without `submodules:`, so the submodule URL doesn't affect CI today.
- For development, `COLLAB_WEB_SRC=~/src/oh-my-pi/packages/collab-web bun run build:collab` (from `hub/`) builds the fork guest without touching the submodule at all.

**Prerequisite: the fork doesn't exist yet**
- `gh repo view andrewleech/oh-my-pi` → "Could not resolve", and `git ls-remote git@github.com:andrewleech/oh-my-pi.git` → "Repository not found". SSH auth itself works as `andrewleech`.
- Create it first, e.g. `gh repo fork can1357/oh-my-pi --clone=false`, then push branch `collab-tail-snapshot` `[INFERENCE: not run, network write]`.

**Switch to the fork** (untested, `[INFERENCE]`; run in `/home/user/omp-connected`)

```sh
git config -f .gitmodules submodule.hub/vendor/collab-web.url git@github.com:andrewleech/oh-my-pi.git
git config -f .gitmodules submodule.hub/vendor/collab-web.branch collab-tail-snapshot
git submodule sync -- hub/vendor/collab-web          # rewrites .git/config + the submodule's origin URL
git -C hub/vendor/collab-web remote add upstream https://github.com/can1357/oh-my-pi.git   # keep upstream refs
git submodule update --remote -- hub/vendor/collab-web   # checks out origin/collab-tail-snapshot tip (detached)
#   or pin an exact commit: git -C hub/vendor/collab-web fetch origin collab-tail-snapshot && git -C hub/vendor/collab-web checkout --detach <sha>
(cd hub/vendor/collab-web && bun install --frozen-lockfile)
git add .gitmodules hub/vendor/collab-web
git commit -m "hub: pin collab-web submodule to andrewleech/oh-my-pi collab-tail-snapshot@<sha>"
```

Resulting `.gitmodules`:

```ini
[submodule "hub/vendor/collab-web"]
	path = hub/vendor/collab-web
	url = git@github.com:andrewleech/oh-my-pi.git
	branch = collab-tail-snapshot
```

- `branch =` only steers `git submodule update --remote`. The superproject still pins the exact gitlink SHA, so reproducibility comes from the committed pin.
- An SSH URL forces SSH for any clone that inits submodules; CI and anonymous clones would need keys. If that matters, use `https://github.com/andrewleech/oh-my-pi.git` in `.gitmodules` and push over SSH via `git config url."git@github.com:".pushInsteadOf https://github.com/`.

**Revert to upstream later** (after the PR merges)

```sh
git config -f .gitmodules submodule.hub/vendor/collab-web.url https://github.com/can1357/oh-my-pi.git
git config -f .gitmodules --unset submodule.hub/vendor/collab-web.branch
git submodule sync -- hub/vendor/collab-web
git -C hub/vendor/collab-web fetch origin main
git -C hub/vendor/collab-web checkout --detach <upstream main sha containing the merge>
(cd hub/vendor/collab-web && bun install --frozen-lockfile)
git add .gitmodules hub/vendor/collab-web && git commit -m "hub: return collab-web submodule to upstream <sha>"
```

---

## 6. Current upstream state

**Pin versus upstream main**
- `git log -1 --format=%ci fd3f8e3c56` → `2026-09-22 13:22:26 +0200` (the merge of PR #12629). Tag distance: `v18.2.8-30-gfd3f8e3c56`.
- **Local refs:** `origin/main` = `origin/HEAD` = `fd3f8e3c56`. `packed-refs` is dated 2026-09-22 22:36 +1000 and there is no `FETCH_HEAD`. By local refs the pin is **0 behind**, and no local upstream commits after it touch collab.
- **GitHub (read-only `gh api`):** upstream `main` is `3d3ec7e907` (2026-09-23T19:49:52Z). `compare/fd3f8e3c56...main` shows **454 ahead, 0 behind**.

Commits since the pin that touch collab paths (`gh api commits?path=…&since=2026-09-22T11:22:27Z`):

| Commit | Change | Collab files touched |
|---|---|---|
| `bb863d996f` | feat(collab): publish whether a host session is working (PR #12844, merged 2026-09-22T16:03Z) | `packages/coding-agent/src/collab/host.ts` +5, `registry.ts` +21/-1, `cli/collab-cli.ts` +1, `docs/collab.md` |
| `ce64ccb8d6` | fixup(collab): docs + CLI test | — |
| `f89a6db15e` | feat: deprecated hub tool (2026-09-23) | `packages/coding-agent/src/collab/guest.ts` +1/-1; `collab-web` swaps `tools/hub.tsx` for `tools/wait.tsx` plus `CHANGELOG.md`/`registry.ts`/tests |
| `ed91e5a27c`, `0bc53be1f1` | — | `packages/collab-web/index.html`, `packages/collab-web/package.json` only |

None of these touch the snapshot, chunking or hello/welcome paths `[INFERENCE: file-level diff sizes only; hunks not read]`. Branch the fork from current upstream `main`, not the pin, so the small `host.ts` merge surface is absorbed up front.

**Unmerged remote branches in the local ref set that touch collab**
- `origin/farm/c257fa3b/fix-collab-transient-reconnect` (2 commits; `packages/collab-web/src/lib/socket.ts`, `test/socket-reconnect.test.ts`, relay-client) = **open PR #11861** (restore guests after transient room loss). Its reconnect semantics overlap our "reconnect resume".
- `origin/farm/1dfca1c5/collab-guest-hold-prompt-during-join` (`guest.ts`) = PR #11069, closed.

**PR search** (`gh pr list -R can1357/oh-my-pi --search 'collab snapshot' --state all --limit 20`, plus searches for `9469`/`9328`/`11859`/`tail-first`/`lazy snapshot` and issue timelines)
- **No PR addresses #9469, #9328 or #11859.** All three issues are OPEN, unassigned and labelled `triaged`; #11859 is marked a duplicate of #9328.
- The only cross-references are between the issues themselves and #11860 (open collab-web UX pass, including virtualization and progress).
- The roboomp triage comment on #9469 says it won't open a PR itself and lists the maintainer decisions needed:
  - web-only vs CLI guest
  - entry/byte ceilings
  - turn boundary definition
  - auto vs explicit near-top loading
  - `session-history` frame shape (repeated chunk frame keyed by `reqId` with `final`, or a page header plus existing chunk frames)
  - reconnect discarding pending requests and re-establishing the tail from a new `welcome`
  - It also anchors the work to `packages/wire/src/index.ts:324-368`, `packages/coding-agent/src/collab/host.ts:371-456`, `packages/collab-web/src/lib/client.ts:214-326` and `packages/collab-web/src/components/transcript/Transcript.tsx:241-294`.
  - The PR description should answer each of these decisions explicitly.

**Adjacent PRs to watch for conflicts**

| PR | State | Why it matters |
|---|---|---|
| **#11371** fix(collab): bound and attribute the host's send-queue admission | OPEN | Per-guest send-queue accounting; touches `guest.ts`/`host.ts`, the queue that snapshot chunks go through |
| **#10462** feat(collab): proto-4 guest system | OPEN | Bumps `COLLAB_PROTO` to 4 and adds `capabilities` to `hello`/`welcome`; directly overlaps our optional-field/capability approach |
| **#11861** | OPEN | Reconnect, as above |
| **#11231** fix(collab): preserve snapshot delivery for departed and rejoining peers | MERGED 2026-09-08 | Already in the pin |
| **#11999** replication byte ceiling + typed placeholder | MERGED 2026-09-13 | Already in the pin; this is the >1 MB shrink placeholder we must make loadable |
| **#12844** | MERGED | After the pin, see table above |
