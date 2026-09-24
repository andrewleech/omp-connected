# Tail snapshot: phase 0, fork setup result

Date: 2026-09-23
HEAD: c046df93c5 (omp-connected); fork base a1b3b83a7f (upstream main)

## Done (tickets/tail_p0_fork_setup.md)
- Fork `andrewleech/oh-my-pi` created with user approval; parent `can1357/oh-my-pi`.
- Clone: `~/src/oh-my-pi`. `origin` = fork (ssh), `upstream` = `https://github.com/can1357/oh-my-pi.git`.
- Branch `collab-tail-snapshot` created locally from `upstream/main` at
  `a1b3b83a7fb8460445f2f5995a6aa56047bd44c7` (2026-09-23 23:09 +0200), 456 commits past our
  pin `fd3f8e3c56`. Upstream tracking unset so nothing pushes by accident. **Not pushed.**
- `bun install --frozen-lockfile`: 414 packages, clean.
- Native addon: `packages/natives` is 18.2.11, but native sources changed since the `v18.2.11` tag
  (37 files: pi-edit sloppy mode, Jev tokenizer, applefm bridge). None of them is on a collab path,
  so the prebuilt `@oh-my-pi/pi-natives-linux-x64@18.2.11` `.node` files were copied into
  `packages/natives/native/` (gitignored). `bun packages/coding-agent/src/cli.ts --version` →
  `omp/18.2.11`. If a later test needs the new native exports, run `bun run build:native`
  (toolchain `nightly-2026-08-12` is now installed).

## Baseline tests
- `packages/coding-agent`: `bun test test/collab/` → 229 pass, 0 fail, 22 files.
- `packages/collab-web`: `bun test` → 98 pass, 0 fail, 10 files.

## Deviations from the ticket
- The base moved from `3d3ec7e907` (planning time) to `a1b3b83a7f`; phase 1–2 anchors must be
  revalidated against it at phase entry.
- Ran the whole collab test directories instead of the four named files.

## Test session (tickets/tail_p0_fixture_session.md)
Fork commit `6220ba78c` (local only): `packages/coding-agent/test/collab/helpers/tail-fixture.ts`.
- `buildTailFixture(sm?)` fills a session manager (in-memory by default) through the public
  append API and returns the ids tests target; `measureStockWelcome(sm)` replays the stock
  welcome path (snapshot → image strip over 24 MiB → `shrinkReplicatedEntry` per entry).
- `bun test/collab/helpers/tail-fixture.ts <dir>` writes the JSONL. Two runs give identical
  message content (md5 of messages without timestamps matches).
- Contents: 300 turns on the active path, 1795 entries (1787 on the path; 8 on an abandoned
  branch), two compactions (the last keeps from an assistant entry, mid-turn), four real PNGs
  (user 300 KB, tool result 2 MB, eval `details.images` 200 KB, bash `images` 150 KB), a
  1.35 MB tool result that the shrinker clips, a key-heavy `details` the shrinker replaces with
  the whole-entry placeholder, and a ~1.2 MB turn with every entry under 1 MiB.

### Stock host baseline (live build and resumed file agree)
| | value |
|---|---|
| snapshot bytes | 29,272,087 (27.9 MiB) |
| images stripped (over 24 MiB threshold) | 4 of 4 |
| bytes the chunk train carries | 23,318,192 (22.2 MiB) |
| whole-entry placeholders | 1 |
| clipped entries | 1 |
| JSONL on disk | 25.6 MB (images externalised to the global blob store) |

`bun packages/coding-agent/src/cli.ts --resume <file>` renders the session ("Session compacted
2 times", turn 299 visible; the model warning is expected for the fake model).

### Findings that change the plan
- **Persistence caps strings at 500,000 chars** (`session-persistence.ts:12`, notice
  "[Session persistence truncated large content]"). A resumed session never has a longer
  string, so `fetch-value` can only restore what the host holds in memory: T2 is lossless
  relative to the host's session, not to the original tool output. The fixture's clip case
  uses three 450 KiB blocks so it clips identically live and after a resume.
- **Images are externalised** to `blob:sha256:` refs on disk and rehydrated on load, so the
  host's in-memory entries carry the full base64 and the image placeholder path is exercised
  after a resume too.
- **A single long string does not produce the whole-entry placeholder**; the first shrink pass
  clips it. The placeholder only appears when size lives in object keys or the entry is not
  serialisable. The fixture uses 20,000 keys for that case. Ticket wording corrected.
- The user's settings auto-start a Collab room on launch (`collab:1` in the status line), so
  any fork `omp` run on hub-host shares its session. Stop test runs promptly, or use this
  deliberately in phase 3.
