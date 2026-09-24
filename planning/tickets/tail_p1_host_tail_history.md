# Host: serve a turn-aligned tail and fetch-history pages

Phase: 1 (tail snapshot)
Depends on: tail_p1_wire_contract
Written: 2026-09-23 at HEAD c046df93c5 (upstream fd3f8e3c56)
Revalidated: pending phase entry
Revalidated: 2026-09-24 at fork base a1b3b83a7f — executed as fork 0cbd77574. Deviations: measurement lives in `selectTurnWindow` (collab/tail.ts), not a `measure` callback; `fetch-history` capped at 16 queued batches per peer (`busy`), because `sendBatch` entries share the socket's fatal 256-entry queue; re-hello `dropPeer` is in the same commit (split at phase 4 per Q3). Tests: test/collab/tail-snapshot.test.ts, both key guards mutation-checked.

## Context
Governed by T1, T3, T4, T6–T9 and the "Host algorithm" section of
[design](../20260923_collab_tail_snapshot_design.md). Evidence: [host survey](../20260923_upstream_collab_host_survey.md) §1–5, §7–9.

## Scope
In scope:
- parsing `hello.snapshot`;
- tail selection;
- `welcome.history`;
- the `fetch-history` handler;
- dropping a peer's queued train when it sends a second hello (Q3: its own commit).

Out of scope: placeholders and `fetch-value` (tail_p1_host_lossless); guests.

## Files and anchors
- `host.ts:643-684` `#handleFrame`: dispatch `fetch-history` next to `fetch-transcript` (`:677-680`). Don't gate it on read-only status; it's gated like `fetch-transcript`.
- `host.ts:664` hello dispatch: pass `frame.snapshot` through.
- `host.ts:713-777` `#handleHello`:
  - validate the tail request after the protocol check (`:718-724`);
  - build the tail instead of `snapshotForReplication` (`:735`) only in tail mode;
  - the image-strip block (`:741-748`) now measures only what is being sent;
  - add `history` to the welcome (`:752-763`);
  - `sendBatch(this.#snapshotChunks(tail))` (`:764`) stays as it is.
- `host.ts:791-815` `#snapshotChunks`: reuse it unchanged for `history` frames. Parameterise the frame factory so it yields `{t:"history", reqId, entries, final, ...}`.
- Session APIs:
  - `getBranch()` (`session-manager.ts:3065-3067`), the memoized root-to-leaf path;
  - `getEntry` (`:3037`).
- Wire filter: `isWireSessionEntry` (`host.ts:99-118`).
- Turn starts: `isTurnStartEntry` (`packages/agent/src/compaction/compaction.ts:463-478`). Import it; don't copy it.
- Byte measurement: `replicationByteLength(shrinkReplicatedEntry(e))` (`replication-shrink.ts:128-135,348`). Measure what will actually be sent.
- Copy only the selected entries with `copyForReplication` (`replication-shrink.ts:296-298`). Take the header copy from `snapshotForReplication`'s header logic, or add a `snapshotHeaderForReplication()` beside it.
- Re-hello: at the top of the tail and full paths, call `this.#socket?.dropPeer(fromPeer)` if the peer was already in `#peers` (`host.ts:727`) (`relay-client.ts:160-171`).

## Design constraints
- The full-mode path is byte-for-byte unchanged, and it stays on `snapshotForReplication`. Stub session managers in `throttled-host.ts:53-58`, `read-only.test.ts:43-51` and `chunked-welcome.test.ts:57-88` provide only four methods. Tail-mode tests use a real `SessionManager.inMemory()`.
- Never throw on malformed input. Fall back to the full snapshot (for hello) or reply with `error` (for fetch-history).
- Replies go only through lazy `sendBatch`, never eager `send()` (T8).
- At least one whole turn, even if it's bigger than `maxBytes`.
- `before` must be on the current `getBranch()`. Otherwise reply `error: "stale"`.

## Approach sketch
Write one pure helper in `host.ts` or a new `collab/tail.ts`:
`selectTurnWindow(path, endExclusive, maxBytes, measure)` returns `{ start }`. It walks
back to the previous turn start, measures that turn, and stops before exceeding the budget
unless no turn has been taken yet. Both the tail (`endExclusive = path.length`) and
`fetch-history` (`endExclusive = indexOf(before)`) use it.
`hasEarlier = start > 0`; `startId = path[start]?.id ?? null`.

## Acceptance criteria and tests
Add `test/collab/tail-snapshot.test.ts`. Use a real host, a real `SessionManager`, the
in-memory relay, and a raw guest built like `joinAsGuest` (`read-only.test.ts:89-140`) that
sends the extra hello field. Tests:
1. Old-style hello: the welcome has no `history`, and the train equals today's (reuse the `chunked-welcome` assertions).
2. Tail with `maxBytes` = 1 MiB on the phase 0 test session:
   - the entries equal the suffix of `getBranch()` starting at a turn start;
   - the total is ≤ 1 MiB, unless the tail is exactly one turn;
   - `history.startId` and `hasEarlier` are correct.
3. One turn over the budget: exactly that turn is sent.
4. Paging back to the root: the concatenated pages equal the filtered `getBranch()`, and the last page has `hasEarlier` false.
5. A `before` cursor on an abandoned branch, or one removed with `discardEntryDurably` (`session-manager.ts:3127-3156`), gets `stale`.
6. Malformed `snapshot` values (`"x"`, `{mode:"tail", maxBytes:-1}`, `{mode:"nope"}`, `maxBytes: NaN`): full snapshot, and the guest isn't hung.
7. Forty `fetch-history` requests back-to-back while throttled (`helpers/throttled-host.ts` `instrumentRelay` with throttle): the room survives and replies arrive in order.
8. Re-hello mid-train: the peer receives no remaining chunks from the first train after the second welcome.
9. Read-only (view-link) guests can use tail and history mode.

## Workflow shape
Implementer on sonnet, tests on haiku, standard and adversarial review on opus, looped.
Coordinate `host.ts` edits with the tail_p1_host_lossless agent; this ticket's agent owns
merges.

## Open questions
Q3 (split out the re-hello fix?) is settled at phase 4.
