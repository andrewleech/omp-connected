# Design and roadmap: esc-esc rewind for Collab guests

Date: 2026-09-30
HEAD: 66a1466ed9 (omp-connected)
Upstream: 81c851de5f (`upstream/main`, 2026-09-29)
Fork refs: `collab-tail-snapshot` abc0446c69 (PR #13389), `ompc-fleet` f75ae39637

All line anchors are at `upstream/main` 81c851de5f unless marked otherwise. Collab source changes go in the fork (`~/src/oh-my-pi`), never in this repo; `hub/patches/` stays empty.

## Goal

A writable guest in the Collab web UI (collab-web, which the dashboard embeds in control mode) can do what esc-esc does in the host's TUI: pick an earlier point in the conversation, have the session go back to it, and get the picked prompt's text back in its composer. Every connected guest sees the conversation as it is after the rewind, whoever triggered it.

Tickets: `tickets/rewind_*.md` (listed per phase below).

## What esc-esc does in the TUI

- **Trigger.** With the editor empty and nothing running, a second Esc within 500 ms runs the `doubleEscapeAction` setting: `rewind` (default) opens the rewind selector, `tree` opens `/tree`, `none` does nothing (`modes/controllers/input-controller.ts:531-551`). While a turn is streaming, the first Esc interrupts it instead (`:525-526`). A draft in the editor disables it (`:527-529`).
- **Selector.** `SelectorController.showUserMessageSelector()` (`modes/controllers/selector-controller.ts:1088-1132`) lists every transcript entry on the active branch (`getBranch().filter(isTranscriptEntry)`) in a fullscreen overlay, with a strip of sibling branches per turn (`#siblingBranchPaths`, `:1140-1166`).
- **Rewind.** `#rewindFromTranscript` (`:1178-1217`) calls `session.navigateTree(entryId, { summarize: false })`, then either truncates the rendered transcript in place (`#treeRewindBoundary`, `:1465-1500`, with `ctx.truncateTranscriptFromMessage`) or rebuilds it with `renderInitialMessages({ clearTerminalHistory: true })`, reloads todos, and puts the returned draft in the editor.
- **Target semantics** (`session/agent-session.ts:10965-11300`):
  - a user-request entry (`isUserRequestEntry`, `packages/tui/src/chat/transcript-entry.ts:59`: a user message, or a user-initiated custom message such as a collab guest prompt or a user-invoked skill) rewinds past itself: the leaf moves to its parent and `userTurnDraft` (`:88`) plus its images come back as `editorText`/`editorImages`. This is a real move even when the prompt is the current leaf;
  - any other transcript entry becomes the new leaf, and picking the current leaf is a no-op ("Already at this point");
  - the abandoned path stays in the session file as a sibling branch. Nothing is deleted.
- **Leaf move mechanics.** Without a summary, `navigateTree` only calls `sessionManager.branch(id)` or `resetLeaf()` (`agent-session.ts:11235-11255`). That moves the in-memory leaf (`SessionManager.#setLeaf`, `session/session-manager.ts:1608`) and appends no entry. `session_tree` only fires when an extension registered a handler (`agent-session.ts:11281`).

## Current Collab behaviour

- **Guests can't rewind.** The host dispatches `hello`, `prompt`, `abort`, `agent-cmd` and `fetch-transcript`, and logs anything else (`collab/host.ts:657-698`). The TUI guest returns from the Esc handler before the double-Esc code (`input-controller.ts:499-507`), so on a guest Esc only ever interrupts.
- **Guests aren't told about leaf moves.** The host mirrors session events (`host.ts:439-442`) and appended entries (`host.ts:454-469`, via `SessionManager.onEntryAppended`, `session-manager.ts:772`). A leaf move with no entry sends nothing.
- **collab-web ignores the tree.** `client.ts` stores entries in arrival order (`collab-web/src/lib/client.ts:302-369`) and `Transcript` renders them in that order (`components/transcript/Transcript.tsx:273-282`). `parentId` is never read.
- **The hub's view-mode viewer ignores the tree too** (`hub/src/webui/lib/collab-tail.ts:667-715` in this repo).
- **No extension route.** `navigateTree` is only on `ExtensionCommandContext` (`extensibility/extensions/types.ts:589`), which exists inside a slash command handler. Our extension's hub RPCs only get `ExtensionContext` (`extension/src/session-rpc.ts:104`), and guest prompts arrive as custom messages, not slash commands.

## Bugs this work fixes

B1 to B3 are pre-existing and independent of guest rewind, but guest rewind can't work correctly without them.

- **B1: guests keep showing the abandoned path after a host rewind.** After esc-esc in the host TUI, collab-web keeps the rewound turns on screen. The next prompt is then rendered after them, although the host appended it under the earlier entry. The same happens for every other leaf move the host makes:
  - `/tree` navigation;
  - turn recovery, which drops a failed turn with `branch`/`resetLeaf` (`session/turn-recovery.ts:1241-1284`, `:3069`);
  - `discardEntryDurably` (`session-manager.ts:3259-3277`);
  - `appendMessageToBranch`, which appends an entry off the leaf and puts the leaf back (`session-manager.ts:2865-2886`, used by `session/bash-runner.ts:319`).

  The TUI guest has the same problem: `message` entries are appended to its agent's message array (`collab/guest.ts:553-555`), and it rebuilds only on `compaction`/`branch_summary` (`:556-564`). [INFERENCE from code; reproduce first, ticket `rewind_p0_repro`.]
- **B2: a fresh collab-web join shows off-branch entries.** The full join snapshot sends every entry in file order (`host.ts:749-778`), and collab-web renders all of them. A session with any abandoned branch shows it inline. Tail joins from PR #13389 send only the active branch (`#selectTail`, `host.ts:904-916` at abc0446c69), so this is limited to full-snapshot joins. The welcome also doesn't say where the host's leaf is, so after a rewind with no new entry the TUI guest's replica leaf is the last entry in the file, not the host's leaf.
- **B3: the TUI guest's replica loses history at every non-replicated entry.** The host replicates only six entry types (`WIRE_SESSION_ENTRY_TYPES`, `host.ts:99-118`), but keeps each entry's `parentId`. A replicated entry whose parent is a `custom`, `label`, `mode_change`, `service_tier_change` or other non-replicated entry points at an id the guest never gets, so the guest's `buildSessionContext` walk (`session/session-context.ts:264-274`) stops there. Probe run on 2026-09-30:
  - host session: user message, `appendCustomEntry`, user message;
  - host context: 2 messages;
  - guest replica fed the wire-filtered snapshot: 1 message, and `getBranch()` = `["message"]`.

  Whether this shows in the TUI guest's rendered transcript needs checking (`renderInitialMessages` goes through `buildTranscriptSessionContext`, `modes/utils/ui-helpers.ts:923-929`). Any guest that derives the active path from `parentId`, which the B1 fix needs, hits it.

## Decisions

- **R1: host-authoritative leaf.** The host tells guests where its leaf is; guests never infer it from arrival order alone. The rule every guest implements:
  - an `entry` frame stores the entry and moves the guest's leaf to it;
  - a `leaf` frame moves the leaf explicitly;
  - the displayed conversation is the walk from the leaf back through `parentId` until an entry the guest doesn't hold.

  This is the same rule the TUI guest's `SessionManager` replica already follows for appends, so both guests agree.
- **R2: replicated parent links skip non-replicated entries.** On every replicated copy (live `entry`, join snapshot, and PR #13389's tail and history pages), `parentId` is rewritten to the nearest replicated ancestor, or `null`. Ids are unchanged, so nothing else about an entry moves. This fixes B3 and makes R1's walk reach the root.
- **R3: one reconciliation point on the host.**
  - The host tracks `#guestLeafId`, the leaf guests currently derive: the last replicated `entry` it sent, or the last `leaf` it sent.
  - Any leaf change, and any appended entry, schedules one microtask. That microtask maps `sessionManager.getLeafId()` to its nearest replicated ancestor and sends `{ t: "leaf", leafId }` only when the result differs from `#guestLeafId`.
  - Several moves in one tick collapse into one frame. `branchWithSummary` needs no `leaf` frame at all, because its appended `branch_summary` already carries the right parent. `appendMessageToBranch` gets exactly one frame, putting guests back on the real leaf.
- **R4: `SessionManager` leaf-change hook.**
  - Add `onLeafChanged?: () => void` next to `onEntryAppended`. It must fire from every place the leaf index changes: `#setLeaf` (`:1608`), the atomic-batch restore (`:1647-1650`), `appendMessageToBranch` (`:2885`), `appendModelUsage` (`:2909`) and index rebuilds (`:1597`, `:3269`, `:3352`).
  - The implementation should route every leaf write through one notifying method rather than touching each call site, so a future call site can't miss the hook.
  - Hook failures are caught and logged like `#notifyEntryAppended` (`:1516-1525`).
- **R5: the welcome carries the leaf.** `welcome.leafId?: string | null` holds the host's leaf mapped per R2. If it's absent, the host is older, and the guest keeps today's "last entry is the leaf" behaviour. This fixes B2 for full-snapshot joins.
- **R6: a leaf the guest doesn't hold means resync.** If a `leaf` frame names an entry the guest doesn't have, it rejoins. That can only happen to a tail-joined guest (PR #13389), which already has an in-session rejoin that keeps the old transcript on screen until the new tail lands (`collab-web/src/lib/client.ts:156-157,359-366,640-660` at abc0446c69). The TUI guest holds the full tree, so for it a missing leaf is a host bug: log it and resync through the existing reconnect path (`collab/guest.ts:290-313`).
- **R7: guests request a rewind; the host runs the TUI's rewind.**
  - New guest frame `{ t: "rewind"; reqId; entryId }` and targeted reply `{ t: "rewind-result"; reqId; draft?; images?; error? }`.
  - Exactly one reply per request, following the `command`/`command-result` pattern in the concurrent guest-commands work.
  - The host runs the same code path as the TUI selector, pulled out of `SelectorController` into a shared function, so the host's TUI redraws exactly as it does for a local esc-esc.
  - The draft goes only to the guest that asked, never into the host's editor. The host shows a notice `<guest> rewound the conversation`, the way guest commands show `<guest> ran /cmd`.
- **R8: guest rewind refusals.** Each is a targeted `error` in `rewind-result`:
  - read-only link (`#rejectReadOnly`, `host.ts:709`);
  - session still starting (`#rejectWhileStarting`, `:718`);
  - a turn is streaming (the TUI equivalent is Esc interrupting first);
  - a session transition is in progress (`isSessionTransitioning`);
  - another rewind from any peer is still running;
  - the entry is unknown, not a transcript entry, or not on the host's active branch ("stale");
  - the no-op "already at this point" case.
- **R9: capability, not a protocol bump.**
  - `COLLAB_PROTO` stays 3. The host sets `welcome.rewind: true` for writable peers when it supports guest rewind, and guests show rewind UI only when they see it.
  - Old guests ignore the new welcome field and the `leaf` frame (collab-web `client.ts:437-439`, TUI guest `guest.ts:612-613`). Old hosts never set `rewind`, and a `rewind` frame sent to one would be logged and dropped (`host.ts:695-696`), so guests must not send it without the flag.
  - The guest-commands work sets the same precedent ("Extends protocol 3 without a bump").
  - The maintainer may prefer a capability list or a bump (stale PR #10462 proposed `capabilities` with proto 4). Raise it in the issue.
- **R10: web rewind UI uses the transcript itself.**
  - collab-web doesn't copy the TUI's fullscreen list. A "rewind mode" marks the selectable rows in the existing transcript.
  - On desktop, esc-esc with an empty composer enters it: arrow keys move, Enter picks, Esc cancels.
  - Phones have no Esc, so a visible Rewind button in the composer actions is the main way in, and tapping a marked row picks it.
  - The sibling-branch strip is out of scope: guests don't receive off-branch entries once tail joins are the norm.
- **R11: web targets are prompts in v1.**
  - The wire frame accepts any transcript entry on the active branch, with the TUI's semantics, so a later UI can widen the target set without a wire change.
  - collab-web v1 marks only user-request rows (user messages, collab guest prompts, user-invoked skill prompts), because "go back to before this prompt and let me edit it" is the case that matters on a phone.
- **R12: branch and PR layout.**
  - PR A, `collab-guest-leaf` off `upstream/main`: R2 to R6. This fixes B1 to B3 and stands alone.
  - PR B, `collab-guest-rewind` stacked on PR A: R7 to R11.
  - PR #13389 interaction: the "leaf not held" rejoin (R6) needs tail joins. Whichever of PR A and #13389 lands second carries that one hook-up, and until then `ompc-fleet` carries it in its merge.
  - `ompc-fleet` merges all of them for the fleet binary.

## Wire contract

Both declaration sites change together: `packages/wire/src/index.ts` (`GuestFrame` `:324`, `HostFrame` `:345`) and `packages/coding-agent/src/collab/protocol.ts` (`CollabFrame`).

```ts
// HostFrame, welcome: new optional fields
leafId?: string | null; // host leaf, mapped to its nearest replicated ancestor (R2, R5)
rewind?: true;          // writable peer on a host that serves `rewind` (R9)

// HostFrame, broadcast: guests move their leaf here (R1, R3)
| { t: "leaf"; leafId: string | null }

// GuestFrame: needs the write token and welcome.rewind (R7, R8)
| { t: "rewind"; reqId: number; entryId: string }

// HostFrame, targeted: exactly one per rewind request
| { t: "rewind-result"; reqId: number; draft?: string; images?: ImageContent[]; error?: string }
```

Replicated entries keep their shape. Only `parentId` is rewritten, per R2.

## Open questions

| # | Question | Owner phase | Status |
|---|---|---|---|
| Q1 | Split R2 (parent links) into its own PR, since it fixes B3 on its own? | 1 | Proposed: first commit of PR A; split if the maintainer asks. |
| Q2 | Welcome flag, capability list, or proto bump for `rewind` (R9)? | 0 (issue) | Proposed: welcome flag; the maintainer decides in the issue. |
| Q3 | Should `rewind-result` carry images? Upstream collab-web can't attach images, and a prompt's images can be large. | 2 | Proposed: send them, bounded by the existing image placeholder rules. A guest that can't attach shows "N images not restored". The fleet build has `collab-web-image-attach`, which can restore them. |
| Q4 | Refuse a guest rewind while the host is viewing a subagent (`ctx.focusedAgentId`)? The TUI blocks its own double-Esc there (`input-controller.ts:487-497`). | 2 | Open: check whether `renderInitialMessages` against the main session is correct while a subagent view is focused. Refuse if not. |
| Q5 | Should web Esc interrupt a streaming turn, like the TUI's first Esc? | 3 | Proposed: no, out of scope. Web keeps the Stop button, and Esc only drives rewind mode while idle. |
| Q6 | Retire the hub's view-mode `CollabTailViewer` in favour of read-only collab-web with tail joins, instead of teaching it R1? | 1 | Open: the ticket fixes it in place (small). Retiring it is a separate hub decision. |
| Q7 | Who posts in Discord, as CONTRIBUTING.md asks for multi-package changes? | 0 | Open: user action, same as the tail track. |

## Coordination

- **guest-commands** (another session, worktree `~/src/oh-my-pi-wt/guest-commands`, branch `collab-guest-commands`, uncommitted on 2026-09-30) edits the same files: `protocol.ts`, `packages/wire/src/index.ts`, `host.ts` `#handleFrame`, collab-web `client.ts` and `Composer.tsx`.
  - Its slash autocomplete uses Escape to close the suggestions. Rewind mode's esc-esc must yield to an open autocomplete and to an open `ui-request` form.
  - Before starting phase 2, message that session to agree on frame names and on whose PR lands first.
- **collab-web-image-attach** (fork only, no upstream PR) changes `Composer.tsx` attachments; see Q3.
- **PR #13389** (tail-first snapshots): see R12.

## Phase 0: Reproduce and raise upstream

Goal: B1 to B3 reproduced as failing tests on a branch off `upstream/main`, and the upstream issue drafted for approval.

Work items:
- [rewind_p0_repro](tickets/rewind_p0_repro.md): failing host and guest tests for B1 to B3, plus a live check on the hub.
- [rewind_p0_upstream_issue](tickets/rewind_p0_upstream_issue.md): issue text in the user's voice. It needs approval before it's opened.

Exit: failing tests committed on `collab-guest-leaf`; issue text approved (opening it is the user's call).

Workflow: main agent; one sonnet implementer for the tests; no review loop (tests only).

## Phase 1: Leaf sync (PR A)

Goal: every guest shows the host's active branch after any leaf move and on every join.

Work items:
- [rewind_p1_wire_chain](tickets/rewind_p1_wire_chain.md): R2.
- [rewind_p1_host_leaf](tickets/rewind_p1_host_leaf.md): R3 to R5, and the `SessionManager` hook.
- [rewind_p1_tui_guest_leaf](tickets/rewind_p1_tui_guest_leaf.md): TUI guest applies `welcome.leafId` and `leaf`.
- [rewind_p1_web_leaf](tickets/rewind_p1_web_leaf.md): collab-web applies R1, R5 and R6.
- [rewind_p1_hub_viewer_leaf](tickets/rewind_p1_hub_viewer_leaf.md): the hub's view-mode viewer (this repo).

Order: wire_chain, then host_leaf, then the three guests in parallel.

Exit: phase 0's tests pass; fork checks are clean (`tsgo`, `oxlint`, `oxfmt`, `bun test test/collab`, collab-web `bun test`); a live host rewind on the fleet shows correctly in collab-web and in the hub viewer.

## Phase 2: Guest rewind on the host (PR B)

Goal: a writable guest can rewind the host session over the wire, and the TUI guest's esc-esc uses it.

Work items:
- [rewind_p2_shared_rewind](tickets/rewind_p2_shared_rewind.md): pull the rewind core out of `SelectorController`.
- [rewind_p2_host_rewind_frame](tickets/rewind_p2_host_rewind_frame.md): wire types, capability, host handler, refusals.
- [rewind_p2_tui_guest_rewind](tickets/rewind_p2_tui_guest_rewind.md): TUI guest esc-esc sends `rewind`.

Order: shared_rewind, then host_rewind_frame, then tui_guest_rewind.

Exit: host tests cover every R8 refusal and the success path, and the TUI selector behaves as before.

## Phase 3: collab-web rewind UI (PR B)

Goal: rewind from collab-web on desktop and phone.

Work items:
- [rewind_p3_web_rewind_ui](tickets/rewind_p3_web_rewind_ui.md).

Exit: collab-web tests pass; checked in a browser at desktop and phone viewports against a live fleet host.

## Phase 4: Fleet and upstream

Work items:
- [rewind_p4_fleet_and_upstream](tickets/rewind_p4_fleet_and_upstream.md): merge into `ompc-fleet`, rebuild the fleet binary and hub, field test, then the PR drafts. Every push and PR needs the user's approval.

## Default workflow per ticket

Implementation on sonnet, test runs on haiku, standard and adversarial review on opus, looping until reviews are clean and tests pass. A ticket's own workflow section overrides this. Implementers skip the project-wide suites; the tester runs them once per phase.
