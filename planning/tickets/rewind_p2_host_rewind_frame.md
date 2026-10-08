# Host: serve guest rewind requests (R7 to R9)

Phase: 2
Depends on: rewind_p2_shared_rewind
Written: 2026-09-30 at upstream 81c851de5f
Revalidated: 2026-10-08 (host success and refusal tests; live host not checked)

## Context
Design R7 to R9 and the wire contract. With phase 1 in place, every guest already follows the leaf, so the host only has to run the rewind and answer the requester.

## Scope
In scope:
- `rewind`/`rewind-result` wire types;
- `welcome.rewind`;
- the host handler and its refusals;
- the host notice.

Out of scope: guest UIs (the next two tickets).

## Files and anchors
- `collab/host.ts`:
  - `:657-698` `#handleFrame`;
  - `:709` `#rejectReadOnly`;
  - `:713-725` `#rejectWhileStarting` / `#guestActionsReady`;
  - `:740-777` hello and welcome (`canWrite` at `:740`);
  - `:884-917` `#handlePrompt`, the pattern for peer lookup, write check and notice;
  - `:919-934` `#notifyPromptDropped`, which handles a session change mid-request.
- Wire types: `collab/protocol.ts` and `packages/wire/src/index.ts` (`GuestFrame` `:324`, `HostFrame` `:345`).
- Precedent in the guest-commands worktree (`~/src/oh-my-pi-wt/guest-commands/packages/coding-agent/src/collab/host.ts`, uncommitted): `#handleCommand` gives exactly one reply per request, a per-peer run token so a reply never reaches a peer that left and whose id was reused, and `emitNotice("info", "<peer> ran /cmd", "collab")`.

## Design constraints
- **Advertising.** `welcome.rewind = true` only when `canWrite`.
- **Refusals** (R8), each one `rewind-result` with `error`, checked in this order:
  1. read-only;
  2. starting;
  3. session transitioning;
  4. streaming ("stop the current turn first");
  5. a rewind already running;
  6. entry not found, not a transcript entry, or not on `getBranch()` (`"stale"`).
- **The run.**
  - Call `rewindTranscriptTo(this.#ctx, entryId)`.
  - `rewound`: reply with `draft` = `editorText` and `images` = `editorImages` (bounded, see Q3), and emit `<guest> rewound the conversation`.
  - `already-here`: reply `error: "already at this point"`.
  - `cancelled`: reply `error: "cancelled by the host"`.
  - A thrown error goes back as `error` too.
- **The draft** goes only to the requesting peer, and only if the peer's run token is still current. Never call `editor.setDraft` on the host.
- **One rewind at a time** across all peers. A second request gets "busy" rather than being queued.
- **No broadcast of its own.** The `leaf` frame from phase 1 moves every guest. The guest that asked gets its `rewind-result` after the host has sent that `leaf` frame, because `#send` is one ordered queue and the reply is sent after the microtask. Assert this order in a test.
- **Session changes.** If the session changes during the run, follow `#notifyPromptDropped`: no reply to a room that has ended.

## Acceptance criteria and tests (raw guest over the in-memory relay, fake `InteractiveModeContext`)
- **Success.** A writable guest rewinds to user B:
  - the requester gets `leaf` (B's parent), then `rewind-result` with B's text;
  - a second guest gets only the `leaf`;
  - the host's editor is untouched;
  - the notice is emitted.
- Each refusal in the list gives exactly one `rewind-result` with `error` and no leaf change.
- A read-only guest's welcome has no `rewind`.
- A peer that leaves during the run gets no reply, and a new peer that reuses its id gets nothing either.
- Picking a non-user entry (assistant A) moves the leaf to it and returns no draft.

## Workflow shape
Default.

## Open questions
Q3 (images) and Q4 (host focused on a subagent) in the design. Settle Q4 by testing `renderInitialMessages` with `focusedAgentId` set, and refuse if the main transcript isn't rebuilt correctly.
