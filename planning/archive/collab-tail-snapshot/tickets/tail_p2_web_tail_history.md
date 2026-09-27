# collab-web: join with a tail, load earlier history, keep scroll position

Phase: 2 (tail snapshot)
Depends on: phase 1
Written: 2026-09-23 at HEAD c046df93c5 (upstream fd3f8e3c56)
Revalidated: pending phase entry
Revalidated: 2026-09-24 at fork 319cf55c9 — client.ts anchors hold (hello :220, welcome :292, snapshot-chunk :318, fetchTranscript :202, transcript :380, #handleClose :226, welcome timer :151); Transcript `entries.map` :326, follow logic uses `updateTranscriptTailLock` :42. Host replies to note: `history` errors are "stale" | "busy" | "malformed fetch-history" | "join before fetching history" | "history is only available after a tail join".
Revalidated: 2026-09-24 — executed as fork d1239513c. Open question resolved: on `stale` the guest re-sends a tail hello on the same socket (host drops the old train), shows an info notice, keeps the old rows until the new tail lands, then applies the T10 rule. Other errors show under the button and wait for a manual retry. Deviation: scroll anchoring keeps the top visible row by entry id instead of `scrollHeight - scrollTop` (same result on prepend, and it also covers T10 reconnects). Live: tail live in 0.28–0.6 s (stock ~30 s+); 20–22 pages back to Turn 0, anchor drift < 0.5 px; screenshots in /tmp/collab-tail-shots/.

## Context
Governed by T4, T10, T11 and T12 in [design](../20260923_collab_tail_snapshot_design.md)
(section "Web guest behaviour"). Evidence: [web survey](../20260923_upstream_collab_web_survey.md) §1–3 and §8.

## Scope
In scope:
- tail opt-in;
- detecting host support;
- publishing the assembled tail once;
- `fetchHistory`;
- prepending while keeping the scroll position;
- the "Load earlier" button and automatic loading near the top;
- reconnect cleanup.

Out of scope: tap to load (tail_p2_web_load_full); the TUI (T5).

## Files and anchors
- `packages/collab-web/src/lib/client.ts`:
  - hello `:220`: add `snapshot: { mode: "tail", maxBytes: TAIL_BYTES }`. Put the constants beside the timeouts at `:70-75`.
  - welcome `:292-317`: latch `history` (startId, hasEarlier) and whether the host supports it; add them to `GuestSnapshot` (`:45-68`).
  - snapshot-chunk `:318-331`: when the host supports it, accumulate privately and publish a single `#publishedEntries` on `final`. Without host support, keep today's per-chunk publishing.
  - `fetchHistory(before)`:
    - models `fetchTranscript` (`:202-212`) and its reply case (`:380-392`), but with an accumulator per `reqId` and an idle timer re-armed on each frame;
    - prepends in a single commit and updates `startId` and `hasEarlier`;
    - on `stale`: re-request the tail by reconnecting, or reject with a visible notice. Choose during implementation and document the choice in the ticket.
  - `#handleClose` `:226-235`: fail pending history and value requests right away.
  - `connect` `:144-157`: re-arm the welcome timer on reconnect too. `#welcomed` is never reset today.
  - Re-welcome under T10: replace entries with the new tail. Keep the scroll position if the previously visible top entry id is still present.
- `packages/collab-web/src/components/transcript/Transcript.tsx`:
  - control and sentinel at the top of `.tr-root`, before `entries.map` (`:325-326`); shown only when `hasEarlier` is set, and disabled with a spinner while loading;
  - prepend detection: `entries[0].id` changed while the last id didn't;
  - record `scrollHeight - scrollTop` before the commit and restore it in `useLayoutEffect`;
  - the follow effect (`:280-284`) and the forced follow on reaching live (`:286-291`) must not fire on a prepend;
  - new props are optional, because `AgentDrawer` reuses `Transcript` in compact mode (`AgentDrawer.tsx:172-180`).
- `packages/collab-web/src/app.tsx:169-177`: pass the history props through.

## Design constraints
- No behaviour change against an old host (no `history` in welcome).
- Loading near the top uses an IntersectionObserver sentinel and must not fire on reflow while the view is locked to the tail. The explicit button always works.
- No real timers in tests. Drive the idle timeouts with fake timers; the existing client tests show the pattern (`test/client.test.ts:96-125`).

## Acceptance criteria and tests
In `test/client.test.ts`:
- The hello contains `snapshot`.
- Against an old host (no `history`): behaviour matches today's, and every existing test passes.
- Against a supporting host: a multi-chunk tail publishes exactly once.
- `fetchHistory`: multi-frame assembly, idle timeout, a late reply is ignored, `stale` handling.
- Close fails pending requests at once. A reconnect re-arms the welcome timer.

In `test/transcript*.test.tsx`:
- A prepend keeps the anchor row's offset.
- The tail lock isn't re-armed by a prepend.
- The control's visibility follows `hasEarlier`.

Manual:
- against the phase 1 host with the phase 0 session: page back to the root with no jumps;
- screenshots at 1600×1125 and at 390×664.

## Workflow shape
Implementer on sonnet, tests on haiku, standard and adversarial review on opus, looped.
Adversarial focus: interleaving a prepend with live `entry` frames, and a reconnect in
the middle of a page.

## Open questions
- The UX for a `stale` history reply: re-tail silently, or show a notice? Decide during implementation and record the choice here.
