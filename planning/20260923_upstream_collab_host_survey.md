# Upstream Collab host-side survey for tail-first snapshots (#9469)

Date: 2026-09-23
HEAD: c046df93c5 (omp-connected)
Upstream: fd3f8e3c56

Scope: host side of Collab (`packages/coding-agent/src/collab/`), the parts of `packages/coding-agent/src/session/` it depends on, and `packages/wire/src/index.ts`. All paths are relative to the upstream monorepo root (`hub/vendor/collab-web`) at fd3f8e3c56. Anything not directly read in code is marked `[INFERENCE]`.

---

## 1. Frame decode / validation (guest → host)

**Decode path, end to end:**

1. The WebSocket `onmessage` handler goes to `CollabSocket.#handleMessage` (`packages/coding-agent/src/collab/relay-client.ts:463-466`, `:478`).
   - TEXT frames are relay control JSON: `JSON.parse` cast to `RelayControlMessage` (`relay-client.ts:479-489`).
   - Binary frames go through `unpackEnvelope` (`relay-client.ts:493`, `packages/coding-agent/src/collab/protocol.ts:111-115`).
   - Decryption is serialized on `#recvChain` (`relay-client.ts:501-525`).
2. The payload decoder is `open()` (`packages/coding-agent/src/collab/crypto.ts:50-58`). It does AES-GCM decrypt, then **`JSON.parse(...) as CollabFrame`** (`crypto.ts:57`). **There is no schema validation at all**: no zod, typebox or field whitelist. It is a bare TypeScript cast.
   - If decryption fails on the host, the frame is logged and dropped (`relay-client.ts:507-511`). The room stays up.
3. `onFrame(frame, envelope.peerId)` (`relay-client.ts:521`) calls `CollabHost.#handleFrame` (`packages/coding-agent/src/collab/host.ts:386`, `:643`).
4. `#handleFrame` runs its gates in this order:
   1. `socket.isServing(fromPeer)`, which drops frames from retired peers (`host.ts:648-651`).
   2. `ui-response` is handled before the session gate (`host.ts:654-657`).
   3. `#guestTrafficAllowed()` (`host.ts:661`, `:630-632`).
   4. `switch (frame.t)` (`host.ts:662-683`). Unknown `t` hits `default: logger.debug("collab host ignoring unexpected frame")` (`host.ts:681-682`). **An old host silently ignores new request frame types. It sends no error reply.** So guests must gate new requests on a welcome capability rather than wait for a rejection.
5. `hello` is destructured positionally: `this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer)` (`host.ts:663-664`). Only those three fields are read.

**Unknown fields on `hello` are tolerated.** Evidence:
- The decoder is a plain `JSON.parse` cast (`crypto.ts:57`).
- The dispatcher reads only `name`/`proto`/`writeToken` (`host.ts:664`).
- No other validator exists anywhere on the path.
- The only consumers of `t: "hello"` in the monorepo are the TUI guest sender (`packages/coding-agent/src/collab/guest.ts:300-305`), the browser client sender (`packages/collab-web/src/lib/client.ts:220`) and the host dispatcher above.

This matches the settled design: new optional hello fields such as `tail`, `budget` and `resumeFrom` are safe to add without a proto bump.

Caveats in the same decoder:
- Field *types* are not validated. If `name` is not a string, `name.trim()` (`host.ts:725`) throws a TypeError. That surfaces in the `#recvChain` `.catch` and is only logged at debug level (`relay-client.ts:523-525`). The guest gets **no** error reply and would hang until its welcome timeout.
- New hello fields must be type-checked defensively inside the host. Treat a malformed value as "absent" (fall back to a full snapshot) rather than throwing.

**Proto check:**
- `if (proto !== COLLAB_PROTO)` replies with a targeted `{t:"error", message:"protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}"}` and returns (`host.ts:718-724`).
- This runs after the session-transition check (`host.ts:714-717`) and before any peer state is recorded.
- The TUI guest treats a pre-welcome `error` as a failed join (`guest.ts:328-337`).

**Current proto number and history:**
- `export const COLLAB_PROTO = 3;` (`packages/wire/src/index.ts:397`). It is re-exported by `protocol.ts:41`.
- The history comment is at `packages/wire/src/index.ts:384-396`:
  - `1`: legacy; `welcome` carried inline `entries`.
  - `2`: metadata-only welcome plus `snapshot-chunk` train.
  - `3`: `ui-request`/`ui-request-end`/`ui-response`. Older guests would drop `ui-request` and hang host asks, so they "must be rejected at hello".
- The comment establishes the precedent that proto bumps are reserved for changes an old peer would *silently mis-handle*. Tail-first is opt-in both ways, so it does not qualify.

**Wire grammar locations to extend:**
- `GuestFrame` is at `packages/wire/src/index.ts:324-340`; `hello` is at `:325-335`.
- `HostFrame` is at `index.ts:345-380`; `welcome` is at `:346-361`.
- The host-side rich `CollabFrame` is at `protocol.ts:54-96`. It takes guest frames verbatim via `Exclude<GuestFrame, {t:"prompt"}>` (`protocol.ts:56`), and redeclares host frames that carry `SessionEntry` (`welcome` `:59-74`, `snapshot-chunk` `:83`, `entry` `:84`).
- **Any new host frame carrying entries must be declared in both places**: the wire skeleton, and the rich host variant in `protocol.ts`.
- The wire header says unknown variants must hit a tolerant `default:` (`packages/wire/src/index.ts:9-11`).

---

## 2. `#handleHello` end to end (`host.ts:713-777`)

1. **Transition gate.** If `session.isSessionTransitioning`, the host sends a targeted error ("join again when it completes") and returns (`host.ts:714-717`).
2. **Proto gate.** See §1 (`host.ts:718-724`).
3. **Name and auth.**
   - `cleanName = name.trim().slice(0, 64) || "guest-${fromPeer}"` (`host.ts:725`).
   - `canWrite = #verifyWriteToken(writeToken)` (`host.ts:726`) does a timing-safe base64url compare against `#writeToken` (`host.ts:687-692`). A missing or invalid token means read-only.
   - Read-only peers still get the full welcome and snapshot. Mutating frames are refused later via `#rejectReadOnly` (`host.ts:695-697`).
   - `fetch-transcript` is **not** permission-gated (see §4).
4. **Per-peer state.** `this.#peers.set(fromPeer, { name: cleanName, canWrite })` (`host.ts:727`). The map type is `Map<number, {name; canWrite}>` (`host.ts:210`). **That is the only per-peer state.** There is no per-peer snapshot or cursor state. Deliverability is owned by `CollabSocket.isServing` (`host.ts:202-209`, `relay-client.ts:127-129`).
5. **Snapshot build.**
   - `snapshotForReplication(copyForReplication)` (`host.ts:735`) calls `packages/coding-agent/src/session/session-manager.ts:2724-2729`. It returns `{ header: copy(#header), entries: copy(#entries) }`.
   - This is a **deep copy of the entire `#entries` array**: every branch, not the active path, in insertion order, including non-wire entry types. It is done synchronously at hello time.
   - `copyForReplication` is a depth-bounded iterative clone with no clipping (`packages/coding-agent/src/collab/replication-shrink.ts:296-298`, doc at `:275-295`). It replaces `structuredClone` so pathologically deep entries don't throw before the shrinker runs (#11433).
6. **Image-strip threshold.**
   - `snapshotBytes = replicationByteLength(snapshot)` is the UTF-8 JSON byte length, or `null` if unserializable (`host.ts:741`, `replication-shrink.ts:128-135`).
   - If `null` or `> WELCOME_IMAGE_STRIP_THRESHOLD` (24 MiB, `host.ts:79`), then **every** `message` entry in the copy goes through `stripImagesFromMessage` (`host.ts:742-748`).
   - The decision is all-or-nothing for the whole snapshot. Only `type === "message"` entries are stripped; `custom_message` image content is untouched (`host.ts:745`). The host's live entries are unaffected because the snapshot is a copy.
   - Only a count is logged. **No placeholder is left**: image blocks simply vanish, or become the text `"[image removed]"` when they were the only block (see §6).
7. **Wire filter.** `entries = snapshot.entries.filter(isWireSessionEntry)` (`host.ts:749`) keeps `message`, `custom_message`, `compaction`, `branch_summary`, `model_change` and `thinking_level_change` (`host.ts:99-106`, `:116-118`). Notably it **drops `reset_boundary`** (the `/clear` marker, `session-manager.ts:2903-2907`) as well as `label`, `model_usage`, `custom`, etc.
8. **Welcome frame** (`host.ts:752-763`), targeted to `fromPeer`. Fields:
   - `t: "welcome"`, `proto: COLLAB_PROTO`
   - `header: snapshot.header`: the copied full `SessionHeader`. The wire skeleton declares only `type/id/title/timestamp/cwd` (`packages/wire/src/index.ts:108-114`); the real header carries more.
   - `state: #buildState()` (`host.ts:977-999`)
   - `agents: #snapshotAgents()` (`host.ts:1012-1031`)
   - `entryCount: entries.length`
   - `readOnly: canWrite ? undefined : true`
9. **Chunk train.** `socket.sendBatch(this.#snapshotChunks(entries), fromPeer)` (`host.ts:764`). `#snapshotChunks` is a **lazy generator** (`host.ts:791-815`):
   - An empty snapshot yields a single `{entries:[], final:true}` (`:792-795`).
   - Otherwise, for each entry it runs `shrinkReplicatedEntry` (never throws, bounded at ≤1 MiB) and measures `replicationByteLength`. It closes the batch when adding the next entry would exceed `SNAPSHOT_CHUNK_BYTES` (512 KiB, `host.ts:130`) and the batch is non-empty. So every chunk has ≥1 entry, and a >512 KiB entry ships alone (`:806-811`).
   - `final: i >= entries.length` is set on the last chunk (`:813`).
   - Shrinking is done lazily per chunk as the transport drains. The deep copy (step 5) is **eager**, so peak memory is one full copy of the whole session per joining guest.
10. **Pacing.** `sendBatch` enqueues one `PendingSend` with `eager:false`, `bytes:0` (`relay-client.ts:155-158`). The pump pulls the next chunk only once `#waitForWritable` says `ws.bufferedAmount` is below the threshold (`relay-client.ts:278`, `:352-370`). Details in §7.
11. **Pending UI replay.** If `canWrite`, every `#pendingUi` request is re-sent to this peer (`host.ts:765-769`).
12. **Notices and state.** A "`<name>` joined the collab session" notice, a status segment update, and a debounced state broadcast (`host.ts:770-776`).

**Second hello mid-train** (the same peer re-helloing, e.g. the TUI guest re-sends hello on every socket open, `guest.ts:290-305`):
- There is no dedupe. `#peers.set` overwrites. A second full copy is taken, a second `welcome` is `send()`-queued, and a second batch is `sendBatch`-queued.
- The first train is **not cancelled**. The queue is a single FIFO, and a batch holds the queue head until exhausted (`relay-client.ts:271-332`, especially `:315-325`). So the peer receives the rest of train 1, then `welcome` #2, then train 2 in full.
- The TUI guest discards partial snapshot state on its own reconnect (`guest.ts:296-299`), but that only covers its own socket-level reconnect.
- Only a `peer-left` (`relay-client.ts:533-554` → `dropPeer`, `:168-171`) or a room recreation (`relay-client.ts:209-214`) discards a queued train.
- A duplicate "joined" notice is emitted.

---

## 3. Live path after welcome

Taps are installed in `start()` after the first relay open (`host.ts:425-460`):
- **Events.**
  - `ctx.session.subscribe` sends `this.#send({t:"event", event: shrinkReplicatedEvent(event)})` for the wire event subset (`host.ts:430-433`; subset at `host.ts:80-97`).
  - It also triggers state scheduling (`host.ts:1001-1010`). While streaming, a 2 s interval re-schedules state (`host.ts:78`, `:1004-1009`).
- **Entries.**
  - `sessionManager.onEntryAppended` (`host.ts:445-460`) is invoked from `SessionManager.#notifyEntryAppended` (`session-manager.ts:1463-1472`), which is called from `#recordEntry` (`session-manager.ts:1560-1576`). The call is deferred while an atomic batch is open (`:1574`). The hook sees the in-memory, pre-blob-externalization entry, so inline images are present (`session-manager.ts:736-739`).
  - Wire entries are run through `shrinkReplicatedEntry`. If the result is the `collab-entry-too-large` placeholder, an extra `event` `oversizedEntryNotice` is sent first (`host.ts:448-454`). Then `{t:"entry", entry: shrunk}` is sent (`host.ts:455`).
  - It always calls `#scheduleStateBroadcast` (`host.ts:459`).
- **State.** Debounced by 100 ms and deduped by JSON diff: `{t:"state", state}` (`host.ts:1135-1145`).
- **Bus/agents.** `bus` frames come from the observability bus (`host.ts:438-443`). `agents` frames are debounced by 100 ms (`host.ts:1033-1039`).

**Broadcast vs per-peer.**
- `event`, `entry`, `state`, `bus` and `agents` are all sent with `toPeer = 0`, i.e. **broadcast** (`#send` default, `host.ts:635-641`). The relay fans peer 0 out to every connected guest socket, *including guests that have not said hello yet* (`packages/collab-web/scripts/local-relay.ts:8-9`, `:90-94`).
- The TUI guest drops everything until it is `#welcomed` (`guest.ts:338`).
- Targeted (per-peer) frames are: `welcome`, `snapshot-chunk`, `error`, `transcript`, and `ui-request` replay. `ui-request`/`ui-request-end` fan out to writable peers individually (`host.ts:346-352`).
- `#send` is gated by `ending` and `#sessionStillCurrent()`. `ui-request-end` is exempt from the session check (`host.ts:639`).

**Ordering relative to an in-progress train.**
- The hello handler takes the snapshot copy and enqueues `welcome` + batch **synchronously** (comment `host.ts:729-730`). Any entry appended after that point is enqueued behind the batch.
- `CollabSocket` has **one FIFO queue shared by all peers** (`relay-client.ts:86`, `:238`). A lazily-drained batch holds the queue head (`relay-client.ts:154` doc: "Keeps a snapshot contiguous with its welcome and ahead of subsequent live traffic").
- So a new peer sees welcome → all chunks → the live entries/events that happened after hello, with no gap and no duplicate.
- **Consequence:** while a large train drains, *all* broadcast traffic to *every* guest is head-of-line blocked behind it (pinned by `packages/coding-agent/test/collab/relay-client-backpressure.test.ts:464`, "delivers more than 256 lazy snapshot chunks in order before live traffic through a slow transport"). Tail-first directly shortens that stall. History-page replies sent the same way will create the same stall, so pages must stay small.
- Entries appended *before* the hello are in the snapshot copy. Any broadcast copy of them that was already queued reaches the new guest before its welcome, and the guest drops it (`guest.ts:338`). Consistent.

---

## 4. `fetch-transcript` request/reply (`host.ts:1092-1133`): the pattern to reuse

- **Request grammar:** `{ t:"fetch-transcript"; reqId:number; agentId:string; fromByte:number }` (`packages/wire/src/index.ts:340`).
- **Reply grammar:** `{ t:"transcript"; reqId; text; newSize; error? }` (`packages/wire/src/index.ts:377-378`; rich variant `protocol.ts:93-94`, doc: "`error` marks a terminal read failure that guests must surface without hot retrying").
- **Dispatch:** `void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer)` (`host.ts:678-680`). It is async, fire-and-forget, and **not** gated by `#rejectWhileStarting` or by read-only status.
- **Permissions:**
  - There is no `canWrite` check. View-link guests are served. Pinned by `packages/coding-agent/test/collab/read-only.test.ts:293-321` ("serves main/sub transcripts requested by a view-link guest").
  - The only denial is when there is no `sessionFile` or the ref is an advisor. The reply is `reply("", fromByte, "no transcript available")` (`host.ts:1096-1100`).
  - `#guestTrafficAllowed` still gates it via `#handleFrame` (`host.ts:661`).
  - Note that `#handleFrame` does not require a prior `hello` from the peer. Any served peer id can issue it (`host.ts:941-944` comment acknowledges frames are admitted before hello).
- **reqId:** echoed verbatim in a closure (`host.ts:1094-1095`). It is not validated, not deduped and not tracked. There is no in-flight table and no cancel. Guests correlate replies themselves.
- **Byte limits:**
  - `TRANSCRIPT_READ_CAP = 4 MiB` per reply (`host.ts:120-121`). The host reads `min(size - fromByte, cap)` (`host.ts:1108-1116`).
  - When the read is not at EOF, it trims to the last `\n` so no JSONL line or UTF-8 char is split (`host.ts:1117-1127`). If there is no newline within the cap, it replies with the terminal error `TRANSCRIPT_ENTRY_TOO_LARGE_ERROR` (`host.ts:122`, `:1121-1125`).
  - `newSize` is the next offset (`host.ts:1128`). A caught-up guest gets `reply("", stat.size)` (`host.ts:1104-1107`).
  - **The 4 MiB reply is sent through the eager `send()`, not `shrinkReplicated*`.** It is therefore 4× above `MAX_REPLICATED_PAYLOAD_BYTES` (1 MiB, `replication-shrink.ts:55`) and counts in one go against the 16 MiB pending-bytes cap (§7). New replies should instead stay ≤ the 1 MiB ceiling, or use `sendBatch`.
- **Errors:** any throw becomes `reply("", fromByte, String(err))` (`host.ts:1129-1132`). The error replies keep `newSize = fromByte`, so the guest's cursor does not advance.

**Reuse template for `fetch-history` / `fetch-value`:** a `reqId` echo, a cursor in the request, and a next-cursor plus optional terminal `error` (or a distinct `stale`) in the reply. Replies are targeted with `#send(frame, fromPeer)`. Dispatch goes in the `#handleFrame` switch next to `fetch-transcript` (`host.ts:678-680`).

---

## 5. Session model (`packages/coding-agent/src/session/session-manager.ts`)

- **Storage.**
  - `#entries: SessionEntry[]` is the append-only journal array, one per session, holding all branches in insertion order (`session-manager.ts:710`). `getEntries()` returns a shallow copy (`:3101-3103`).
  - `#index = new SessionEntryIndex()` (`:711`) maintains `#entriesById`, `#children`, `#labels`, `#leaf`, usage, and a memoized branch keyed on (leaf, generation) (`:416-428`).
- **Leaf / active path.**
  - `index.insert(entry)` **sets the leaf to the inserted entry** (`:445-449`).
  - `getLeafId()` (`:3016-3018`); `getEntry(id)` (`:3037-3039`); `getChildren` (`:3042-3044`).
  - `getBranch(fromId?)` returns `#index.pathTo(fromId ?? leaf)` (`:3065-3067`). It walks `parentId` to the root with cycle protection and returns root→leaf order (`:510-545`). It stops silently at a missing parent (`:530-535`), so a truncated chain on a guest yields a shorter path rather than an error.
  - The branch is memoized, and callers get copies (`:515-521`, `:538-543`).
  - New entry parentage: `#freshEntryFields()` uses `parentId: this.#index.leafId()` (`:1543-1549`).
- **Branch APIs.**
  - `branch(id)` only moves the leaf (`:3113-3120`, "Existing entries are never modified or deleted"). `resetLeaf()` sets the leaf to null (`:3122-3125`).
  - `branchWithSummary(from, summary, details?)` moves the leaf, then appends a `branch_summary` child of `from` (`:3158-3175`).
  - `appendMessageToBranch(msg, parentId)` appends off-branch and restores the leaf (`:2754-2776`). `appendModelUsage` does the same (`:2779-2800`).
  - `createBranchedSession(leafId)` replaces `#header`/`#entries` with the root→leaf path under a **new session id** (`:3177-3249`).
  - Callers: tree navigation at `agent-session.ts:10349-10361`; turn recovery at `turn-recovery.ts:1122-1126`, `:1163-1167`, `:2836`.
  - **Guests are never told about a leaf-only move.** No entry is appended, and `onEntryAppended` does not fire. They follow implicitly, because the next appended entry's `parentId` points at the new branch point and the guest's `ingestReplicatedEntry` → `#recordEntry` → `index.insert` makes it the leaf (`session-manager.ts:2706-2708`, `:445-449`).
  - [INFERENCE] Conversely, an off-branch append that is a wire type (`appendMessageToBranch` of a `message`) is broadcast as a normal `entry`. The guest's leaf then jumps onto that off-branch entry until the next active-path append. So "newer entries on the active path" must be computed from `getBranch()`, **not** from insertion order in `#entries`.
- **Compaction entries.**
  - Type: `CompactionEntry { type:"compaction"; summary; shortSummary?; firstKeptEntryId; tokensBefore; tokensAfter?; method?; providerReplayThroughEntryId?; details?; preserveData?; warning?… }` (`packages/coding-agent/src/session/session-entries.ts:118-142`). The wire skeleton is at `packages/wire/src/index.ts:135-141`.
  - `appendCompaction(summary, shortSummary, firstKeptEntryId, tokensBefore, opts)` appends as a child of the current leaf. **`firstKeptEntryId` points backwards to an entry *before* the compaction entry on the same path** (`session-manager.ts:2865-2895`).
  - Context rebuild uses the **latest** compaction on the path (`packages/coding-agent/src/session/session-context.ts:318-319`; helper `getLatestCompactionEntry` `:140-147`). The rebuilt context is the summary, then kept entries `[firstKeptIdx, compactionIdx)`, then everything after the compaction (`session-context.ts:340-343`, `:466-596`, especially `:543-572`, `:592-596`).
  - The collapsed display may start later than `firstKeptEntryId`, at the next turn start, because the cut can be mid-turn (`session-context.ts:549-559`).
  - Turn-start definition: `isTurnStartEntry` is true for user/bashExecution `message`, `branch_summary` and `custom_message` (`packages/agent/src/compaction/compaction.ts:463-478`). `findTurnStartIndex` walks backwards (`compaction.ts:480-492`).
  - **Implication for the tail:** a tail "from the last compaction" must start at or before `firstKeptEntryId`. Ideally it starts at the turn start containing it, via `findTurnStartIndex`. It must not start at the compaction entry itself, or the guest's rebuilt context loses the kept tail.
  - `/clear` writes `reset_boundary` (`session-manager.ts:2897-2907`, caller `agent-session.ts:5148`), which is a *stronger* boundary on the host (`session-context.ts:337`, `:446-465`). It is **not replicated** (not in `WIRE_SESSION_ENTRY_TYPES`, `host.ts:99-106`).
  - Remote compaction payloads (`preserveData.openaiRemoteCompaction`, `session-context.ts:196-203`) can be large and ride on the compaction entry. They are subject to the shrinker.
- **In-place mutation ("rewrite paths").** The `snapshotForReplication` doc says "the host mutates entries in place on rewrite paths, so guests must not share references" (`session-manager.ts:2710-2713`). Confirmed sites:
  - `rewriteEntries()` persists in-place edits (`:2915-2922`). Callers mutate entries first:
    - tool-output pruning, stale tool results, `drop-images`, and shake (`packages/coding-agent/src/session/session-maintenance.ts:639`, `:685`, `:736`, `:792`; rollback via `Object.assign(entry, snapshot)` at `:910`)
    - compaction warning stamping (`session-maintenance.ts:1748-1749`, `:4314-4315`, `:5034-5035`)
    - turn recovery (`packages/coding-agent/src/session/turn-recovery.ts:817`)
  - `discardEntryDurably` re-parents children in place (`child.parentId = …`), removes the entry from `#entries`, rebuilds the index, appends a `branch_summary` marker, and rewrites (`session-manager.ts:3127-3156`; guest-side contract pinned by `packages/coding-agent/test/collab/discarded-entry-marker.test.ts:41-94`).
  - Atomic-batch rollback rewrites `parentId` in place and drops entries (`session-manager.ts:1578-1593`). Batch notifications are deferred (`:1574`) [INFERENCE: dropped on rollback].
  - Load-time sanitize mutates `entry.message` (`session-manager.ts:3080-3094`).
  - **None of these notify collab guests.** There is no hook in `rewriteEntries`, so guests keep the pre-mutation copy.
  - For the new design this means a later "tap to load" returns the host's *current* value, which may be pruned or smaller than the size recorded in the placeholder. A cursor or entry id can also vanish (`discardEntryDurably`), and that must surface as `stale`.
- **Guests on compaction.** The only signal is the ordinary live `entry` frame carrying the compaction entry (`host.ts:445-456`). The guest rebuilds its context behind the summary. Contract test: `packages/coding-agent/test/collab/host-compaction-guest-sync.test.ts:176-216` (#9781). A real host `SessionManager.inMemory()` plus a real guest `CollabGuestLink`/`AgentSession`; after `appendCompaction("SUMMARY", undefined, keptId, 100)` the guest messages become `[compactionSummary, keep]`. The events `auto_compaction_start/end` are also mirrored (`host.ts:92-93`), as is a state refresh on `auto_compaction_end` (`host.ts:73`).
- **Session identity.** A room is bound to the session id at construction (`host.ts:236-238`). Traffic is refused when the active session differs (`host.ts:578-592`, `:630-632`). `createBranchedSession`/resume change the id, so a room never spans two sessions and a cursor never crosses sessions within a room. `welcome.header.id` identifies the session for resume-staleness checks across rooms.

---

## 6. `replication-shrink.ts`

- **Ceiling.** `MAX_REPLICATED_PAYLOAD_BYTES = 1 MiB` (`replication-shrink.ts:49-55`), measured in UTF-8 JSON bytes by `replicationByteLength`, with `null` for unserializable values (`:117-135`).
- **Passes.** `SHRINK_PASSES` string cap / array limit: 64 KiB/256, 16 KiB/128, 4 KiB/64, 1 KiB/32, 256/16, 256/4, 64/1 (`:83-111`). `shrinkPayloadShape` returns the value by reference if it fits, and otherwise tries passes in order until one fits (`:300-317`).
- **Walk.** `shrinkWalk` is iterative with a depth cap `MAX_REPLICATED_DEPTH = 1000` (`:69-81`, `:174-273`). It leaves these markers:
  - strings: head-truncated with `\n…[${N} chars elided for collab session]` (`:143-152`). Note N is UTF-16 chars, not bytes.
  - arrays: head-kept plus a trailing string element `…[${N} items elided for collab session]` (`:193-198`).
  - depth: `"…[deeper levels elided for collab session]"`; cycles: `"…[cyclic reference elided for collab session]"` (`:114-115`, `:190-191`).
  - It preserves `toJSON` (`:216-226`) and `__proto__` keys (`:227-244`).
  - **These in-place markers carry no entry id, field path or original byte size.** They lose content silently apart from the char/item count. Under the settled design they are also "trimmed content" that must become loadable placeholders, not only the whole-entry placeholder.
- **Whole-entry placeholder.** Used when a shape shrink cannot fit (size in keys, or unserializable). Shape (`:348-361`):
  ```ts
  { type: "custom_message", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
    customType: "collab-entry-too-large",  // COLLAB_ENTRY_OMITTED_CUSTOM_TYPE, :57-58
    display: true,
    content: `…[${type} entry[, ${bytes} bytes] omitted for collab session: too large to replicate]` }  // omittedDetail :319-322
  ```
  - It keeps `id`/`parentId`/`timestamp`, so the chain stays connected (pinned `packages/coding-agent/test/collab/replication-shrink.test.ts:503`).
  - The original `type` and byte size exist **only inside the human string**. There is no `details` field. On the snapshot path this placeholder reaches the guest's model context deliberately (`:336-339`).
  - Live path companion: `oversizedEntryNotice` (`:363-377`). Events use `shrinkReplicatedEvent`, which replaces the event with a notice and has no identity (`:379-397`).
- **Image stripping.**
  - `stripImagesFromMessage(message)` (`packages/coding-agent/src/session/messages.ts:687-702`) mutates in place and returns a count. Per role (`messages.ts:704-763`):
    - `user`/`developer`/`custom`/`hookMessage`: filter `type:"image"` blocks from array `content` (`:711-723`, helper `:666-685`). An all-image array becomes `[{type:"text", text:"[image removed]"}]`.
    - `toolResult`: the same for `content`, plus filtering `details.images[]` items with `type:"image"` (`:724-749`).
    - `bashExecution`: `images` becomes `undefined` (`:706-710`).
    - `fileMention`: `files[i].image` becomes `undefined` (`:750-758`).
  - Indices shift after filtering and no marker is left. The original position is unrecoverable from the stripped copy.
  - **Image block shape:** `{ type:"image"; data: string /* base64 */; mimeType: string }` (`packages/wire/src/index.ts:23-29`). In host memory the data is inline. Blob refs `blob:sha256:<hex>` exist only in persisted JSONL (`packages/coding-agent/src/session/blob-store.ts:8-11`). They are resolved at load (`session-manager.ts:1829`, `:3332`) and externalized at write (`session-manager.ts:1054-1056`). `onEntryAppended` sees the inline form (`session-manager.ts:736-737`; pinned by `packages/coding-agent/test/collab/session-replication.test.ts:25`).
- **What a later fetch of the original needs:** the host already has the full value in memory via `getEntry(id)` (`session-manager.ts:3037`). So a placeholder needs:
  1. `entryId`
  2. the **field path** as a JSON-pointer-like array of keys/indices into the *original* entry, e.g. `["message","content",3]`, `["message","details","images",0]`, `["message","files",2,"image"]`. For clipped strings, the path to the string leaf.
  3. the original **full size** in UTF-8 bytes (and `mimeType` for images, so the guest can render a thumbnail slot).
  4. [recommended] enough to detect in-place mutation since then (§5): e.g. the size or a cheap hash of the original value. The host can then reply `stale` instead of returning a different value.
  - Values can be multi-MiB (images, tool output), so the fetch reply must be **ranged** (offset + length, ≤ the 1 MiB ceiling per frame), like `fetch-transcript`'s `fromByte`/`newSize`.
  - Because indices shift under `stripImagesFromArrayContent`, the new code must record the path *before* removing blocks, or replace in place with a placeholder block instead of filtering.

---

## 7. `relay-client.ts` send pacing / backpressure

- **Constants.**
  - `MAX_PENDING_SENDS = 256` queue entries; `MAX_PENDING_SEND_BYTES = 16 MiB` (`relay-client.ts:24-25`).
  - `WS_BACKPRESSURE_THRESHOLD = 64 KiB`; `WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 KiB`; `WS_BACKPRESSURE_DRAIN_RETRY_MS = 25` (`:37-39`).
- **`send(frame, peer)`** (`:142-152`) is eager. It `JSON.stringify`s immediately and counts the full serialized bytes into `#pendingSendBytes` at enqueue. It chains `#sendChain` so that `flush()` (`:376-378`) waits for sealing. A serialize throw calls `#failFatal` (the room dies).
- **`sendBatch(iterable, peer)`** (`:154-158`) is lazy. It enqueues with `bytes=0`. The iterator is pulled one frame at a time only after `#waitForWritable` (`:278`). Each pulled frame's bytes are counted transiently (`:292-298`, `:327-330`). After a successful write, the next item is pre-pulled so an exhausted batch leaves the head immediately (`:315-325`). At most one chunk is held.
- **Admission.** `#enqueueSend` (`:216-241`):
  - It refuses targeted work for retired peers (`:228-232`).
  - **Over capacity is fatal:** `#failOverload()` closes the socket with "collab send backlog exceeded its limit; restart sharing and rejoin" (`:233-236`, `:243-252`). A per-chunk overflow is also fatal (`:294-297`).
  - **So paging or fetch replies must never be emitted as many eager `send()`s.** Each counts fully up front, and a burst of 16 × 1 MiB eager replies (or four 4 MiB transcript replies) under backpressure kills the room. Use `sendBatch` with a lazy generator (as `#snapshotChunks` does), or keep each reply ≤1 MiB and one per request.
- **Writability.**
  - `#waitForWritable` (`:352-370`) requires the socket to be OPEN and `bufferedAmount < 64 KiB`. When blocked it lowers the threshold to 32 KiB (hysteresis) and polls every 25 ms or on `#wakeSender`.
  - `#sendEnvelope` re-checks before `ws.send` (`:334-350`).
  - Sealing is async WebCrypto (`crypto.ts:38-47`).
- **Queue is one global FIFO** across peers (`:86`, `:271-332`). There is no per-peer fairness: a targeted batch blocks broadcasts and other peers' replies until it is exhausted (see §3).
- **Discard APIs.**
  - `dropPeer(peerId)` (`:160-171`) runs synchronously on `peer-left` via `#applyPeerLifecycle` (`:533-554`).
  - `discardPendingSends()` is used by `stop()` for the goodbye (`:380-394`, `host.ts:514-521`).
  - Room recreation drops all targeted work (`:193-214`), then `onRoomRecreated` → `CollabHost.#handleRoomRecreated` clears `#peers` (`host.ts:938-964`).
  - A batch iterator's `return()` is called on cancel (`:186`), so generators can clean up in `finally`.
- **Implication for history paging:** a page reply should be a lazily-generated batch of ≤512 KiB chunk frames (reuse `#snapshotChunks`-style sizing), tagged with `reqId` and `final`. A guest budget bounds the *page*, not the transport chunk. There is no per-peer rate API. Pacing is purely transport drain, and head-of-line blocking argues for modest page sizes.

---

## 8. Existing tests in `packages/coding-agent/test/collab/` by area

**Helpers:**
- `helpers/in-memory-relay.ts`
  - `installInMemoryRelay()`/`uninstallInMemoryRelay()` swap `globalThis.WebSocket` for a `FakeWebSocket`.
  - The `InMemoryRelay` mirrors the relay's envelope routing and peer-joined/left controls on microtasks, with real sealing (`in-memory-relay.ts:1-14`, `:23-90`, `:92-158`).
  - `bufferedAmount` is 0 unless a test drives it (`:30-31`).
- `helpers/throttled-host.ts`
  - `makeSnapshot()` builds 96 × 16 KiB entries (`:22-39`).
  - `makeHostContext(snapshot, seen)` is a **stub** `sessionManager` with only `getSessionId`, `getCwd`, `snapshotForReplication` and `onEntryAppended` (`:46-92`, especially `:53-58`).
  - `instrumentRelay(relay, {throttle})` records host→relay target peer ids and optionally inflates `bufferedAmount` (`:94-127`). `waitFor` (`:129-135`).
- `helpers/registry-host-process.ts`: registry IPC only; not relevant.

**Stub sessionManagers.** Several host tests stub `sessionManager` with only the four members above: `read-only.test.ts:43-51`, `chunked-welcome.test.ts:57-88`, and `throttled-host.ts:53-58`. **If the hello path starts calling `getBranch`/`getEntry`/`getLeafId` unconditionally, those stubs break.** Keep the no-tail path on `snapshotForReplication`, or extend the stubs. Tests that use a real `SessionManager.inMemory()`: `host-compaction-guest-sync.test.ts:178`, `discarded-entry-marker.test.ts:42`, `replication-shrink.test.ts:577-625`, `session-replication.test.ts`.

**By area:**
- **Hello / welcome / proto / raw guest harness.**
  - `read-only.test.ts`: `joinAsGuest(link, name, token?)` builds a raw `CollabSocket` guest that sends `{t:"hello", proto, name, writeToken}` on open and filters broadcast frames (`read-only.test.ts:89-140`, filter `:94-107`). This is the easiest place to send extra hello fields.
  - It also covers read-only welcome (`:322`), write capability (`:350`) and forged tokens (`:457`).
- **Snapshot train / chunking.**
  - `chunked-welcome.test.ts:219-272` asserts the welcome is small, then contiguous `snapshot-chunk`s, >1 chunk, `final` only on the last, and the ids in order.
  - Other cases in the same file cover guest-side join failure (`:200`, `:274`, `:293`, `:315`).
- **Shrink / placeholder.**
  - `replication-shrink.test.ts`:
    - unit tests of `shrinkReplicatedEntry` (`:350-523`): verbatim when fitting `:351`, string clamp `:363`, many strings `:372`, giant key `:396`, many keys `:418`, 50k-deep `:436`, UTF-8 `:461`, cycle `:475`, chain connected `:503`
    - `shrinkReplicatedEvent` (`:525-575`)
    - real-relay size tests using `startTestRelay(RELAY_MAX_PAYLOAD)` (`:309-348`, `:577-625`, `:626+`, e.g. "terminates the train with final:true and substitutes a typed placeholder" `:627`)
  - `session-replication.test.ts`: `onEntryAppended` inline images vs externalized persistence (`:25`), hook-failure isolation (`:57`), `ingestReplicatedEntry` foreign ids plus leaf (`:66`), `snapshotForReplication` deep copy (`:94`).
- **Live path and compaction.**
  - `host-compaction-guest-sync.test.ts` (real host + real guest, `settleFrames` polling `:133-140`, `makeHostContext(manager)` `:31-57`, `makeGuestHarness` `:71-125`).
  - `discarded-entry-marker.test.ts` (real manager, raw guest, replay via `ingestReplicatedEntry` `:84-89`; a template for "replay a received tail into a guest manager and assert `getBranch()`").
  - `host-bus-fallback.test.ts` (bus mirroring).
- **Queue / backpressure / peer lifecycle.**
  - `host-peer-left-queue.test.ts`: departed peer's queued snapshot discarded (`:34-107`, with throttle plus a manual `bufferedAmount = 0` drain loop `:84-86`); room recreation settles asks (`:109`); reissued id must not inherit write (`:157`); hello after peer-left ignored (`:211`).
  - `relay-client-backpressure.test.ts` (`BackpressuredWebSocket`, fake timers): overload is fatal (`:68`), byte bound (`:442`), >256 lazy chunks before live traffic (`:464`), high-water queuing (`:555`), goodbye under backpressure (`:589`), reconnect backlog (`:618`).
  - `relay-client-delivery.test.ts` (real local relay: batch plus live entry `:7`; peer lifecycle `:57`).
  - `relay-client-reconnect.test.ts`, `relay-client-isolation.test.ts`.
- **fetch-transcript.** `read-only.test.ts:293-321`. It writes a temp JSONL via `TempDir`, registers an `AgentRegistry` ref, and has a view-link guest fetch. This is the template for new request/reply tests.
- **Guest side** (other surveys): `guest-*.test.ts`, `steer-queue.test.ts`, `controller.test.ts`.

---

## 9. Insertion points

| # | Concern | Where | Notes |
|---|---|---|---|
| a | Hello tail/budget/resume fields (wire) | `packages/wire/src/index.ts:325-335` (`GuestFrame` hello) | Add optional fields (e.g. `tail?: { budgetBytes?: number }`, `resumeFrom?: { sessionId, entryId }`). No `COLLAB_PROTO` change (`:397`); extend the history comment `:384-396` to document the optional capability. |
| b | Parse hello fields on host | `host.ts:663-664` (switch passes positional args) → `host.ts:713` `#handleHello` signature | Pass the whole `frame` (or an options object) instead of 3 positional args. Validate types defensively (`typeof`, finite, >0). A malformed value degrades to the full snapshot, never throws (`name.trim()` throw precedent, §1). |
| c | Tail computation (turn-aligned, from last compaction, optional budget) | Replace/branch at `host.ts:735-749` | Use `ctx.sessionManager.getBranch()` (`session-manager.ts:3065`) filtered by `isWireSessionEntry`. Find the latest `compaction` on the path (`session-context.ts:140-147` semantics), then the index of its `firstKeptEntryId` (`< compactionIdx`), then back up with `findTurnStartIndex` (`packages/agent/src/compaction/compaction.ts:485`) or `isTurnStartEntry` (`:469`). With no compaction, start from the root or budget. With a budget, walk turns backwards from the leaf, summing `replicationByteLength(shrinkReplicatedEntry(e))`, always ≥1 turn. Copy only the selected entries (`copyForReplication` per entry, `replication-shrink.ts:296`) instead of the whole `#entries` deep copy. Decide how `reset_boundary` (not replicated, `host.ts:99-106`) interacts. Apply the image-strip threshold (`host.ts:741-748`) to the tail, and convert stripping to placeholders (row h). |
| d | Welcome capability + counts | `packages/wire/src/index.ts:346-361`; `protocol.ts:59-74`; construction `host.ts:752-763` | Add an optional capability flag (e.g. `caps?: { tail?: true; history?: true; value?: true }`). Add `snapshotStart`/first-entry id or `hasOlder: boolean`, and optionally `totalPathEntries`. Keep `entryCount` = entries actually in this train (the guest waits on it, `protocol.ts:65-71`, `guest.ts:314`). Old guests ignore unknown welcome fields [INFERENCE: the TUI guest destructures; confirm in guest surveys]. |
| e | History-page request/reply | New `GuestFrame` variant next to `fetch-transcript` (`packages/wire/src/index.ts:340`); new `HostFrame` next to `transcript` (`:377-378`) and rich variant in `protocol.ts:93-94` (must carry `SessionEntry[]`); dispatch case at `host.ts:678-680`; handler modelled on `host.ts:1093-1133` | Request `{reqId, before: entryId, budgetBytes?}`. Host: `getEntry(before)` plus membership in `getBranch()`; walk `parentId` back for whole turns. Reply as a lazy batch via `socket.sendBatch` (not eager `send`, §7) of ≤512 KiB frames `{reqId, entries, final, hasOlder}`. Every entry goes through `shrinkReplicatedEntry` (or the new placeholder-producing shrinker). Old hosts ignore the frame (`host.ts:681-682`), so gate on the welcome capability. |
| f | Full-value fetch request/reply | Same wire and dispatch locations as (e) | Request `{reqId, entryId, path, offset}`. Host: `getEntry(entryId)` (`session-manager.ts:3037`), resolve the path on the live in-memory entry (inline image data, `session-manager.ts:736-737`), serialize, reply with a byte range ≤ `MAX_REPLICATED_PAYLOAD_BYTES` (`replication-shrink.ts:55`) as `{reqId, data, offset, total, error?}`, mirroring `fromByte`/`newSize` (`host.ts:1104-1128`). Unknown entry or path, or a size/hash mismatch versus the placeholder, gives `stale`/`error`. Permission: follow `fetch-transcript` (served to view-link guests). |
| g | Placeholder producer | `replication-shrink.ts:143-152` (`clipString`), `:193-198` (array elision), `:348-361` (whole-entry placeholder) | Thread the current path through `WalkFrame` (`:159-172`) so each clip can emit a structured marker `{entryId, path, fullBytes}`. Add a structured `details` to the `collab-entry-too-large` placeholder carrying `{originalType, fullBytes}` (currently only in `content` text, `:359`). Keep the placeholder a `custom_message` so old guests still render it. |
| h | Image-strip → placeholders | `host.ts:742-748`; `messages.ts:666-763` | Do not call the index-shifting `stripImagesFromMessage` on the replication copy. Use a replication-specific variant that replaces each image with a placeholder block carrying `{entryId, path, mimeType, fullBytes}` at the original index, covering `content[]`, `details.images[]`, `bashExecution.images[]`, `fileMention.files[i].image`, and `custom_message.content[]` (currently skipped, `host.ts:745`). |
| i | Resume-from-entry-id | `#handleHello` before snapshot build (`host.ts:729-735`) | If `resumeFrom.sessionId === ctx.sessionManager.getSessionId()` (`host.ts:238`) and `resumeFrom.entryId` is on `getBranch()`, send welcome (`entryCount` = newer active-path entries after that index) plus a train of only those. Otherwise send `stale` (a welcome flag or distinct frame), then a normal tail. Enqueue synchronously so live traffic ordering (§3) holds. |
| j | Stale detection | Shared helper in `host.ts` near `#handleFetchTranscript` (`:1092`) | Stale when: the entry id is not in the index (`getEntry` undefined, e.g. `discardEntryDurably` `session-manager.ts:3137-3156`); it is not on the current `getBranch()` (branch/rewind moved the leaf, `:3117-3125`); the session id differs; or the value size/hash differs from the placeholder (in-place rewrite paths, `session-maintenance.ts:639-908`). Reply `{reqId, stale:true}` without hot retry, as the `transcript.error` contract (`protocol.ts:93`). |
| k | Mid-train second hello | `host.ts:727`, `:764` | Optional hardening: before enqueueing a new train for `fromPeer`, call `socket.dropPeer(fromPeer)` (`relay-client.ts:168-171`) to cancel the obsolete train. Today it runs to completion ahead of the new welcome (§2). |
| l | Per-peer state (if needed) | `host.ts:210` `#peers` map | Add capability flags per peer (e.g. `tail: boolean`) if later frames must know whether the guest opted in. The field-profile PR would add `profile` here too. |

**Field-profile (later PR) facts only:**
- The wire skeleton already declares only a subset of fields (`packages/wire/src/index.ts:104-167`), but the host ships the rich entry verbatim. The host frame type is the rich `SessionEntry` (`protocol.ts:83-84`; `replication-shrink.ts:341-343`: "the frame carries the rich entry and only *serializes* into the wire shape").
- So every non-rendered field (e.g. `compaction.preserveData`, `details`, usage) is paid for today. `copyForReplication`/`shrinkWalk` (`replication-shrink.ts:180`) is the natural single place to drop fields.

## Contradictions / risks vs the settled design

- **None blocking.** Unknown hello fields are tolerated (`crypto.ts:57`, `host.ts:664`). Unknown guest frame types are silently ignored by old hosts (`host.ts:681-682`), so a welcome capability flag is *required* for guests to know they can page, since there will be no error reply.
- "No content ever lost" currently fails in three places:
  - whole-snapshot image stripping leaves no marker and shifts indices (`host.ts:742-748`, `messages.ts:666-685`)
  - the whole-entry placeholder has no machine-readable fields (`replication-shrink.ts:352-360`)
  - the shape-preserving clips lose content with only char/item counts and no path (`replication-shrink.ts:148-152`, `:193-198`)
  
  All three are host-side and must change.
- The host mutates entries in place without notifying guests (§5). "Tap to load" can therefore return a different value than the one trimmed, and a stale check on the value (size/hash) is needed, not just on the entry id.
- `reset_boundary` is not replicated (`host.ts:99-106`). A tail "from last compaction" may include pre-`/clear` history that the host itself hides (`session-context.ts:446-465`).
- The existing `fetch-transcript` reply size (4 MiB, eager `send`) exceeds the 1 MiB replicated-payload ceiling. Do not copy that sizing for the new replies (§4, §7).
