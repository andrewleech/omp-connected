# Collab guest slash commands: design, reviews and verification

Date: 2026-09-30
HEAD: c56696a (omp-connected); fork `collab-guest-commands` pushed to andrewleech/oh-my-pi (no upstream PR), rebased onto upstream/main 2026-09-30

The only record of the track. There was no roadmap or tickets; it was built, reviewed and fixed within one session. The web guest sent `/foo` as an ordinary prompt, so the host agent saw literal text and never ran the command.

## What it does
A writable guest can run the host's slash commands, with autocomplete from the host's own command list and the command's output returned to the guest.

- Wire (`packages/wire`): guest `{t:"command"; reqId; text}`; host `{t:"commands"; commands}` (targeted after a writable peer's welcome, re-sent when the set changes) and `{t:"command-result"; reqId; output?; error?}` (exactly one per request). `CollabCommand` is `{name, source, description?, subcommands?, ...}`. `COLLAB_PROTO` stays 3: an old host ignores `command`, an old guest ignores the new host frames, and the guest only treats slash text as a command once `commands` has arrived.
- Host (`packages/coding-agent/src/collab/host-commands.ts`, `host.ts`): the list is the text-mode set (builtins without pickers, skills, extension, custom, MCP prompt and file commands) built through the same runtime as ACP. A `command` frame is resolved with `resolveCollabCommand` and run with `runCollabCommand`; output has ANSI stripped and is capped at 256 KiB.
- `/compact`, `/shake` and `/handoff` go through the interactive-mode handlers (`handleCompactCommand` and friends) so the host transcript is rebuilt and the compaction queue flushed. Their `showStatus`, `showWarning` and `showError` lines are teed into the guest result; a successful compaction is reported from the new compaction entry ("Compacted (remote): 7.8K → 7.4K tokens"). `/todo` is followed by a todo reload.
- Withheld from guests: `/move`, `/wt`, `/stats`, `/trace`, `/browser`, `/computer` and `/session delete` (they relocate or delete the live session, or touch the host's desktop, network or files). Each has a reason comment in `GUEST_DENIED_BUILTINS`.
- The host emits the notice "<peer> ran /<name>" (not included in the guest's captured output).
- Web guest (`packages/collab-web`): `GuestClient.commands`, `sendCommand`, `dismissCommand`; `lib/commands.ts` (`matchCommand`, which also accepts the builtin colon form such as `/compact:full`, and `commandSuggestions`); `CommandUi.tsx` (suggestion list and dismissable result panel, `white-space: pre` so `/context` bars stay aligned); `Composer.tsx` handles arrows, Tab, Enter and Escape. A composer with images attached sends a prompt, never a command.

## Reviews
1. Opus review of the host and web guest: findings on denied-command coverage, the compact success line, and output cross-talk.
2. Fixes, then re-review: "correct". One P3 (an overlap test that claimed isolation it did not assert) fixed by asserting the full fanned-out output.
3. Post-review tweaks (compact success line from the compaction entry, skipping the `collab: ` notice prefix in the tee) were covered by tests and not re-reviewed.

## Known limits
- Prompt-type commands can report done on another turn's `agent_start`.
- Two guests running `/compact`, `/shake` or `/handoff` at the same moment each see the other's status lines in their output.
- A successful `/handoff` returns only the saved-path line.

## Rebase onto upstream/main 2026-09-30
Rebasing the three feature branches and merging them into `ompc-fleet` (now upstream/main at the 18.4.5 natives, plus `collab-relay-heartbeat`):
- `collab-web-image-attach`: placeholder text in `Composer.tsx` follows upstream's new capitalised wording.
- `collab-tail-snapshot`: `.tr-earlier` in `transcript.css` takes upstream's new sizing and keeps `display: flex` with a gap for the loading spinner; `docs/collab.md` keeps the new `fetch-history` / `fetch-value` list plus upstream's transcript-cap paragraph.
- Merging `collab-guest-commands` with the other two conflicted in `host.ts`, `protocol.ts`, `client.ts`, `Composer.tsx` and the client and composer tests. The frames, dispatch cases, snapshot fields and imports are all kept. The merged composer has one Send button; images attached means a prompt rather than a command. `tail-snapshot.test.ts` needed the `subscribeCommandMetadataChanged` stub that the host now calls.

## Verification
- Host: `bun test test/collab --timeout 60000`: 247 pass on the branch, 290 on `ompc-fleet`. Web guest: `bun run check` clean; 125 tests on the branch, 180 on `ompc-fleet`.
- Headless Chromium against a throwaway hub and a real host session: `/st`, `/tr`, `/br`, `/wt` and `/mov` suggestions show no denied commands; `/compact` compacted and the host showed the remote-compacted divider; `/shake`, `/compact:full` ("Already compacted") and `/context` (no escape codes, aligned bars) returned their output. Repeated on the merged `ompc-fleet` build with a tail join, the attach button and `/context`.
- Not tested: mobile layout of the suggestion list, real `/handoff`, extension commands that open pickers.
