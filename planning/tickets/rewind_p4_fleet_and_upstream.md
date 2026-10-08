# Fleet rollout, field test and upstream PRs

Phase: 4
Depends on: phases 1 to 3
Written: 2026-09-30 at omp-connected 66a1466ed9, fork `ompc-fleet` f75ae39637
Revalidated: 2026-10-08 (nine feature branches integrated on `v18.8.4`, published fork `ompc-fleet` at `852efd0316`; hub/guest rebuild, six-host rollout and field checks completed below; upstream PR drafting and approval remain pending)

## Context
The fleet runs a fork build from the mbm-managed `ompc-fleet` branch (the binary at `~/.local/share/omp-connected/omp`, selected by `OMP_BIN` in `omp-host.env`). The hub serves collab-web built from the same fork checkout.

## Scope
In scope:
- merging `collab-guest-leaf` and `collab-guest-rewind` into `ompc-fleet`;
- the fleet binary and hub rebuild;
- the field test;
- PR bodies for PR A and PR B;
- archiving the planning track once the PRs are up.

## Steps
1. **Merge.**
   - Use a clean fork checkout or the existing release-refresh checkout, preserving any other session's active work.
   - Include `collab-guest-leaf`, `collab-guest-rewind` and `collab-guest-prompt-history` with the other fleet features in the local mbm config. Rebuild onto the selected upstream release tag with `mbm rebase --config <config> --target <tag>`, resolve conflicts and resume.
   - Keep compatibility fixes on feature branches or in merge conflict resolutions, never ordinary commits on the machine-managed fleet branch. Run `tsgo`, `bun test test/collab` (coding-agent) and `bun test` (collab-web) before publishing.
2. **Rebuild.** Rebuild the fleet binary the way the previous fleet build was made, and record the command in the phase report. Then rebuild and restart the hub:

   ```sh
   cd hub && COLLAB_WEB_SRC=~/src/oh-my-pi/packages/collab-web bun run build
   systemctl --user restart omp-hub
   ```

   Running `ompc` sessions pick up the new binary only after a restart.
3. **Field test** on hub-host with a throwaway session:
  - host esc-esc: collab-web (control), hub viewer (view) and a TUI guest all follow;
  - guest rewind from a desktop message context menu and a phone-sized long-press menu;
  - TUI guest esc-esc and collab-web's optional desktop esc-esc shortcut;
  - read-only link: no rewind or fork action;
  - a rewind while streaming is refused;
  - fork prompts for a name, starts a distinct process/file, leaves the original session intact and adds the registered session to the WebUI list for selection (after Q9 provides safe point-copy support);
  - a tail-joined guest rewound past its window rejoins.

   Record the results in this ticket's field report below.
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

## Field report, 2026-10-08

### Build and rollout

- omp-connected feature integration was fast-forwarded to `main` and published at `8834c65`. The fork includes tail snapshots, image attachments, guest commands, relay heartbeat, viewport cap, closed guest rail, active-leaf sync, rewind and prompt history, all on `v18.8.4`. Compatibility changes live on feature branches or in merge resolutions, not ordinary commits on the mbm-managed integration branch.
- The Linux x64 build uses the published `v18.8.4` native addons and `CROSS_TARGET=linux-x64 bun --cwd=packages/coding-agent run build`. The deploy artifact is `packages/coding-agent/dist/omp-linux-x64`, not an older `dist/omp`. Version and `--smoke-test` checks passed before installation.
- The installed binary is identical on all six hosts: SHA256 `435af195297e26a1fec2f3445162db449027317aeac4244dc54606e5e35b6b77`, version `18.8.4`. Its native smoke check also passed on the oldest fleet glibc, 2.35.
- The hub/dashboard and Collab guest were built from the integrated sources, with `COLLAB_WEB_SRC` pointing at the release-refresh checkout's `packages/collab-web`. The hub was restarted after the final guest build. The live dashboard loaded `app.7y9njf4e.js`; the final guest build is `jpar2exh.js`.
- Client extension/launcher installation completed on all six hosts. Fresh detached launcher sessions registered from all five remote hosts, alongside the hub host; the live health response reported `status: ok` and six hosts. Existing user sessions were preserved, they need a restart to adopt the installed binary and extension.

### Verification

- The combined fork's Collab host, web guest and input-controller keybinding suites passed: 575 tests, zero failures, 43 files. `bun run check:ts` also passed, including checks across all 16 packages.
- omp-connected verification passed: 179 hub tests, 68 extension unit tests and 24 Playwright tests. Its existing 22 Biome errors and 14 TypeScript errors were compared with the baseline and left unchanged, these are not reported as passing checks.
- A regression test failed before the idle native-guest Escape fix and passed afterwards. Live TUI verification also confirmed double-Escape opens the rewind picker when idle, while the running-turn path still handles Escape without opening it.
- The searchable inspector model picker was exercised on the live dashboard: entering `gpt-6.1-sol` filtered to the matching provider/model option, and Escape dismissed the picker without changing the model.

### Field scenarios

- **Host double-Escape:** rewinding the long throwaway session updated writable and read-only web guests to the earlier active branch; the native guest followed the host state. The hub's legacy viewer branch projection was exercised separately against the browser fixture, including append, rewind, empty leaf and unavailable leaf cases, rather than claiming a live legacy-viewer fallback test.
- **Desktop/phone guest rewind:** desktop context-menu rewind restored the requesting guest's prompt text and image, removed the abandoned branch from the transcript and left another guest's draft alone. A trusted Chromium touch long-press at a phone-sized viewport exposed a menu closing on finger release; the corrected menu survived release and its Rewind action worked. This was browser emulation, not a physical phone test.
- **Native guest double-Escape:** the final installed binary opened the real picker, and choosing an earlier checkpoint rewound the host and web guest. The optional web double-Escape shortcut is not offered; web rewind uses the prompt menu.
- **Read-only invite:** its composer was disabled and prompt rewind/fork actions were absent.
- **Running-turn refusal:** a real bounded model turn ran a sleep command. Web rewind actions were hidden during the turn; accepting a native picker opened before the turn returned `rewind is unavailable while a turn is running`, without changing the branch.
- **Fork:** the prompt-name flow created a discoverable/selectable WebUI session with a distinct PID, session UUID and JSONL file. The original session file's SHA256 was unchanged by the fork.
- **Tail window:** the initial long-session guest joined with only the recent tail. Rewinding beyond that window rejoined the earlier branch, and loading earlier history allowed rewind to the empty branch without restoring the abandoned tail.
- **Prompt history/rewind interop:** Up recalled the preceding user prompt, Down restored the draft, and a rewind reset the history cursor. Navigating history after rewind preserved the restored image and did not resurrect the pre-rewind unsent draft.

PR drafting/opening and track archiving are not part of the fleet rollout request, they remain pending approval. No upstream PR was opened.
