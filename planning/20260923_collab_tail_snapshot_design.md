# Collab tail-first snapshot: design and wire contract

Date: 2026-09-23
HEAD: c046df93c5 (omp-connected)
Upstream: fd3f8e3c56 (anchors below; revalidate against the fork base at phase entry)

Implements upstream issue can1357/oh-my-pi#9469 in the fork `andrewleech/oh-my-pi`,
branch `collab-tail-snapshot`, for a later upstream PR. Related: #9328 (flow control),
#11859 (reload loop). Evidence:
[composition](20260923_collab_snapshot_composition.md),
[host survey](20260923_upstream_collab_host_survey.md),
[web survey](20260923_upstream_collab_web_survey.md),
[TUI survey](20260923_upstream_collab_tui_guest_survey.md),
[logistics](20260923_upstream_fork_logistics.md).

## Problem
Every guest join copies and sends every stored entry (`session-manager.ts:2724-2729`,
`host.ts:735,749`). The harness session is 26.5 MB and 5490 entries. The web guest
renders once per 512 KiB chunk, so it replays history before reaching the present.
Content is also lost silently:
- images are stripped above 24 MiB (`host.ts:79,742-748`);
- strings are clipped by the shrinker (`replication-shrink.ts:148-152,193-198`);
- oversized entries become prose placeholders (`replication-shrink.ts:348-361`).

## Decisions
| # | Decision | Date / source |
|---|---|---|
| T1 | **The guest owns the budget.** The host imposes no fixed byte cap on a page. A guest may send `maxBytes`; the host fills it with whole turns, always at least one. A guest that sends no tail request gets today's full snapshot. The 512 KiB frame chunking and 1 MiB per-entry shrink stay: they are transport sizing, not content limits. | 2026-09-23, user |
| T2 | **Nothing is lost, only deferred.** Anything the host trims (clipped strings and arrays, oversized entries, stripped images) is sent as a placeholder carrying entry id, field path, full size and hash. The guest offers "tap to load" and fetches the full value. Same PR as paging. Scope: lossless relative to what the host holds; session persistence already caps strings at 500,000 chars on disk (`session-persistence.ts:12`), so a resumed session can't serve more than that (phase 0 report). | 2026-09-23, user; scope note 2026-09-23 phase 0 |
| T3 | **No proto bump.** `COLLAB_PROTO` stays 3: the host rejects mismatches (`host.ts:718-724`) and CI pins 3 (`scripts/install-tests/run-ci.sh:215-219`). All additions are optional fields and new frame types. Evidence of tolerance: the decoder is a bare `JSON.parse` cast (`crypto.ts:57`); hello reads only `name`, `proto` and `writeToken` (`host.ts:664`); both guests ignore unknown welcome fields and frame types (`client.ts:407-409`, `guest.ts:612-613`). | 2026-09-23, verified |
| T4 | **Support is advertised in `welcome.history`.** An old host ignores unknown request frames without replying (`host.ts:681-682`), so a guest sends history or value requests only after seeing the advertisement. The name avoids #10462's proposed `capabilities` field. | 2026-09-23 |
| T5 | **Web guest only in PR 1.** The TUI guest keeps the full snapshot. Placeholders keep existing field types (string markers, text blocks, `custom_message`), so old and TUI guests render them unchanged. The TUI opt-in is a follow-up. | 2026-09-23, TUI survey §6 |
| T6 | **Tail mode sends the active path only** (`getBranch()`, `session-manager.ts:3065`), filtered to wire types. Full mode keeps sending all entries in insertion order. This is a visible change for tail guests (abandoned branches no longer appear) and is called out in the PR. | 2026-09-23 |
| T7 | **Turn boundary** = `isTurnStartEntry` (`packages/agent/src/compaction/compaction.ts:463-478`: user or bashExecution `message`, `branch_summary`, `custom_message`). Pages start on a turn start. | 2026-09-23 |
| T8 | **History replies reuse one frame type,** repeated per `reqId` with `final`, sent lazily through `sendBatch` in chunks of at most 512 KiB. Never eager `send()`: 16 MiB of pending eager bytes kills the room (`relay-client.ts:24-25,233-236`). | 2026-09-23 |
| T9 | **Cursors are entry ids, not indices.** A cursor that is no longer on the active path gets `error: "stale"`. | 2026-09-23 |
| T10 | **Reconnect: discard and re-tail.** On a re-welcome the guest fails pending history and value requests, replaces its entries with the new tail, and restores its scroll position if the old top entry is still present. There is no resume-by-id in PR 1: a tail is small, so a reload is cheap, and that removes #11859's reload loop for tail guests. Resume stays a TUI follow-up item. | 2026-09-23 (replaces the earlier resume proposal) |
| T11 | **Loading earlier history** triggers automatically near the top (an IntersectionObserver sentinel) and also through an explicit "Load earlier" button. | 2026-09-23 |
| T12 | **Web budget constants** live in collab-web: `TAIL_BYTES = 1 MiB` for the initial tail and `PAGE_BYTES = 1 MiB` for each history page. Harness evidence: 1 MiB is 358 entries, 26 turns. | 2026-09-23 |
| T13 | **Fork logistics.** Fork `andrewleech/oh-my-pi`; branch `collab-tail-snapshot` from **current upstream main**, not the pin (main is 454 commits ahead, with small collab edits). The submodule URL uses https for anonymous clones; pushes use ssh via `pushInsteadOf`. | 2026-09-23, user + logistics §5-6 |

## Wire contract (additions only)
Types live in `packages/wire/src/index.ts`. Host frames that carry entries are also
declared in `packages/coding-agent/src/collab/protocol.ts:54-96`, and no test checks
that the two copies agree (web survey finding 1), so declare them in both places.

```ts
// guest -> host: hello gains an optional tail request (host.ts ignores it when old)
{ t: "hello"; proto; name; writeToken?;
  snapshot?: { mode: "tail"; maxBytes?: number } }   // absent/malformed => full snapshot

// host -> guest: welcome gains `history` only when the tail request was honoured
{ t: "welcome"; ...existing;
  entryCount: number;                 // entries in THIS train (tail length in tail mode)
  history?: {
    v: 1;
    startId: string | null;           // first entry id of the tail; null if empty
    hasEarlier: boolean;              // active-path entries exist before startId
  } }
// the tail follows as today's snapshot-chunk frames

// guest -> host: older page before a cursor (read-only guests allowed, like fetch-transcript)
{ t: "fetch-history"; reqId: number; before: string; maxBytes?: number }

// host -> guest: one or more frames per reqId, lazily batched, last has final: true
{ t: "history"; reqId: number; entries: SessionEntry[]; final: boolean;
  startId?: string | null; hasEarlier?: boolean;     // present on final
  error?: string }                                   // "stale" | message; terminal

// guest -> host: full value behind a placeholder
{ t: "fetch-value"; reqId: number; entryId: string; path: (string | number)[];
  hash: string; offset: number }                    // hash echoed from collabElided

// host -> guest: ranged slice of JSON.stringify(original value), one frame per request
{ t: "value"; reqId: number; offset: number; data: string; total: number; final: boolean;
  error?: string }                                   // "stale" | message; terminal
```

Placeholder metadata: each shrunk or stripped entry gains an optional top-level field,
which old guests ignore:

```ts
collabElided?: Array<{
  path: (string | number)[];   // into the ORIGINAL entry; [] = whole entry
  kind: "string" | "array" | "image" | "entry";
  bytes: number;               // UTF-8 bytes of JSON.stringify(original value)
  hash: string;                // Bun.hash of that JSON, hex; host re-checks on fetch
  mimeType?: string;           // images
  removed?: true;              // image-only arrays: restore by insertion (added 2026-09-24)
}>
```

The visible placeholders keep today's types:
- a clipped string keeps its existing elision marker;
- in a mixed content array, a stripped image becomes a text block **at the same index** (`[image image/png, 1.2 MB not sent]`) instead of being filtered out, so indices are preserved;
- in an image-only array (`bashExecution.images`, tool `details.images`) the image is removed, as today, and its record carries `removed: true` with the original index. TUI renderers draw every element of those arrays as an image, so a text block there would break old guests (found in phase 1, 2026-09-24);
- an entry over the 1 MiB ceiling has its images placeheld before any string is clipped, so base64 is never clipped into a broken image;
- a whole oversized entry stays the `collab-entry-too-large` `custom_message`, with `collabElided: [{ path: [], kind: "entry", ... }]`.

Value fetch semantics:
- The host resolves `getEntry(entryId)` (`session-manager.ts:3037`), walks `path` over own properties only, and serialises the value. Only wire entry types are served: `getEntry` also returns `session_init` and extension entries that no snapshot sends (added 2026-09-24).
- If the hash differs from the recorded one, the host replies `stale`. Entries are mutated in place with no guest notification (`session-maintenance.ts:639,685,736,792`; `session-manager.ts:3127-3156`).
- Each `value` frame holds at most 512 KiB of `data`. The guest re-requests from `offset + data.length`, the way `fetch-transcript` continues from `newSize`. Offsets are UTF-16 code units of the JSON string.

## Host algorithm (tail)
1. Parse `hello.snapshot` defensively. Treat a non-object, a wrong `mode`, or a non-finite or non-positive `maxBytes` as absent. Never throw: a throw here hangs the guest (`relay-client.ts:523-525`).
2. Tail mode: `path = getBranch().filter(isWireSessionEntry)`. Walk back from the end, one whole turn at a time (T7), summing `replicationByteLength(shrinkReplicatedEntry(e))`. Stop before a turn that would push the total over `maxBytes`, but always keep at least one turn. With no `maxBytes`, take the whole path.
3. Apply image stripping to the chosen entries only, as in-place placeholders (T2). Keep the 24 MiB threshold, but measure only what is being sent.
4. Send `welcome` with `entryCount = tail.length` and `history`, then `sendBatch(#snapshotChunks(tail))`, unchanged.
5. Copy only the chosen entries. Today the host deep-copies the whole session on every hello (`host.ts:735`).
6. Keep the full-mode path on `snapshotForReplication`, because host tests stub only four `sessionManager` methods (`throttled-host.ts:53-58`, `read-only.test.ts:43-51`).
7. If a second hello arrives for a peer whose train is still queued, call `socket.dropPeer(fromPeer)` first (host survey §2). Otherwise the stale train drains ahead of the new welcome.

`fetch-history`:
- Look up `before` in `getBranch()`. If it isn't there, reply `stale`.
- Otherwise take whole turns backward from it, under the guest's `maxBytes`, at least one turn.
- Send them as lazy `history` frames with the same chunk sizing.
- On the final frame, set `startId` and `hasEarlier`.

## Web guest behaviour
- **Opting in and detecting support.** `hello` sends `snapshot: { mode: "tail", maxBytes: TAIL_BYTES }`. If `welcome.history` is absent (old host), the guest keeps today's behaviour exactly.
- **One render for the tail.** Assemble the tail privately and publish it once on `final`. Today the guest re-renders once per chunk (`client.ts:318-331`).
- **Loading earlier history.** `fetchHistory(before)` follows the `fetchTranscript` pattern (`client.ts:202-212,380-392`), extended to several frames with an idle timer re-armed on each frame. It prepends the page in one commit. `Transcript` saves `scrollHeight - scrollTop` before the prepend and restores it in `useLayoutEffect`. Don't rely on `overflow-anchor`.
- **Tap to load.**
  - `fetchValue` fetches the full value.
  - Loading a whole entry, or a field inside one, swaps the patched entry into `#entries` by id, so the row re-renders through its memo (`Transcript.tsx:176-183`).
  - Tool renderers get it through an optional `ToolRenderHost` method, so HTML exports, which don't provide it, keep working (`tool-render/types.ts:42-47`).
  - The results map has to carry the tool-result entry id (`Transcript.tsx:267-275`, `ToolCard.tsx:7-16`).
- **Reconnect.** Per T10, `#handleClose` fails pending history and value requests, and the welcome timer is re-armed on reconnect (`client.ts:151`).

## Non-goals (PR 1)
- TUI opt-in, `/collab history` and `/collab expand` (follow-up).
- A guest-declared field profile to drop unused heavy fields, ~45% of harness bytes (separate PR).
- Transcript virtualization (#9469 non-goal).
- Resume-by-id.
- Gating the two TUI prompt paths that bypass the guest check and run the guest's own model (`input-controller.ts:971-978,1662-1747`). This is a separate upstream bug report.

## Answers to the #9469 triage questions (for the PR body)
| Question | Answer |
|---|---|
| Web-only or also the CLI guest? | Web-only for now (T5) |
| Entry and byte ceilings | The guest sets the budget; the host has no cap of its own (T1). Nothing is lost (T2). |
| Turn boundary | `isTurnStartEntry` (T7) |
| Automatic or explicit near-top loading | Both (T11) |
| Frame shape for history | A repeated `history` frame keyed by `reqId`, with `final` (T8) |
| Reconnect | Discard pending requests and re-tail from the new welcome (T10) |
