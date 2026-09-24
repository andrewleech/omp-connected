# Upstream collab-web guest survey for the tail-first snapshot

Date: 2026-09-23
HEAD: c046df93c5 (omp-connected)
Upstream: fd3f8e3c56

Scope: the browser guest `packages/collab-web/` and the parts of `packages/wire` it uses, surveyed for the
tail-first snapshot work (upstream #9469, related #9328, #11859). All anchors are relative to the upstream
monorepo root (`hub/vendor/collab-web` in this repo) at fd3f8e3c56, except `hub/scripts/...`, which lives in
omp-connected. `[INFERENCE]` marks claims I derived from reading the code but did not run.

---

## 1. Collab client (`packages/collab-web/src/lib/client.ts`)

### Structure
- `GuestClient` owns a `CollabSocket` and publishes an immutable `GuestSnapshot` through a subscribe/getSnapshot pair
  (`packages/collab-web/src/lib/client.ts:1-9`, `:91`, `:165-175`).
- `GuestSnapshot` fields: phase, endedReason, header, entries, state, agents, progress, lifecycle, stream,
  streamDone, activeTools, working, readOnly, uiRequest, notices (`packages/collab-web/src/lib/client.ts:45-68`).
  It has no history, capability, or placeholder state yet.
- Timeouts (`packages/collab-web/src/lib/client.ts:70-75`):
  - `TRANSCRIPT_TIMEOUT_MS = 10_000`: one fetch-transcript round trip.
  - `WELCOME_TIMEOUT_MS = 30_000`: welcome must arrive after `connect()`.
  - `SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000`: time allowed between snapshot chunks.

### Connection lifecycle
- Constructor: parses the link, builds `CollabSocket`, and wires `onOpen`, `onFrame` and `onClose`
  (`packages/collab-web/src/lib/client.ts:132-142`).
- `connect()`: resets `ended` to `connecting`, calls `socket.connect()`, and arms the welcome timer only while
  `!#welcomed` (`packages/collab-web/src/lib/client.ts:144-157`).
- `#handleOpen()` runs on every successful open, including reconnects
  (`packages/collab-web/src/lib/client.ts:219-224`).
  - It sends `hello` with `{proto: COLLAB_PROTO, name, writeToken}`. This is the only place hello is built
    (`packages/collab-web/src/lib/client.ts:220`).
  - Phase becomes `waiting` on the first open and `reconnecting` afterwards
    (`packages/collab-web/src/lib/client.ts:221`).
- Socket open ordering: `CollabSocket` flushes queued envelopes (up to `MAX_PENDING_SENDS = 256`) before it calls
  `onOpen`. So guest frames queued while disconnected reach the host before the new hello
  (`packages/collab-web/src/lib/socket.ts:23`, `:115-120`, `:83-84`).
  - The host ignores a frame type it does not know: it logs it and sends no reply
    (`packages/coding-agent/src/collab/host.ts:680-681`).
  - `fetch-transcript` is served without checking hello state
    (`packages/coding-agent/src/collab/host.ts:677-679`).
  - `[INFERENCE]` A history or full-value request queued across a reconnect would run against a peer id that has
    not sent hello yet. Fail such requests on close rather than letting them queue.
- `#handleClose()`: clears the snapshot-progress timer (`packages/collab-web/src/lib/client.ts:226-235`).
  - With `willReconnect`, it sets phase to `reconnecting` and stops there.
  - It does **not** fail pending fetch-transcript requests. They wait out their 10 s timer.
- `#end()`: clears both timers and resolves every pending transcript request with `null`
  (`packages/collab-web/src/lib/client.ts:237-251`).
- Reconnect backoff is 1 s × 2^n, capped at 30 s, with ±25 % jitter
  (`packages/collab-web/src/lib/socket.ts:20-21`, `:214-222`).
- Guests retry when the room closes or goes missing (codes 4001/4004 after a first join)
  (`packages/collab-web/src/lib/socket.ts:179-184`).
- Two quirks found by reading the code:
  - `#welcomed` is never reset. On a reconnect the welcome timer is **not** re-armed (`:151`), so a host that never
    answers the second hello leaves the guest in `reconnecting` indefinitely.
  - A throw while applying a re-welcome only pushes a notice (`:281`). It does not end the session.

### Welcome handling (`packages/collab-web/src/lib/client.ts:292-317`)
- Every welcome resets the accumulator: `#entries = []` and `#publishedEntries = []` (`:296-297`).
- It also resets stream, activeTools, progress, lifecycle and uiRequests (`:300-307`).
- The guest reads `entryCount` only to test for `=== 0` (`:310-315`):
  - zero entries: phase goes straight to `live`;
  - otherwise: the snapshot-progress timer is armed and phase stays `waiting`/`reconnecting`.
- This contradicts the wire comment, which says guests wait until they have accumulated `entryCount` entries
  (`packages/wire/src/index.ts:352-358`). Only `final: true` ends loading.
- The client ignores unknown welcome fields, so an optional capability field is safe for old guests. Unknown host
  frame types fall through `default:` and are ignored (`packages/collab-web/src/lib/client.ts:407-409`).

### Snapshot-chunk accumulation (`packages/collab-web/src/lib/client.ts:318-331`)
- Each chunk runs `#entries.push(...frame.entries)`, then `#publishedEntries = [...#entries]`. That is an O(n) copy
  per chunk, and one `#commit()` per chunk (`:411`).
- `final: true` clears the timer and sets phase `live` (`:324-326`). Otherwise the progress timer is re-armed
  (`:327-328`).
- There are no id-based dedup or ordering checks: entries are appended in arrival order.
- There is no active-path filter. The guest renders whatever the host sends, flat, in order. Today the host sends
  every stored wire-eligible entry, including abandoned branches:
  - `packages/coding-agent/src/session/session-manager.ts:2724-2729`;
  - `packages/coding-agent/src/collab/host.ts:735`, `:749`;
  - `packages/coding-agent/src/collab/host.ts:99-118`.
- The host drops non-wire entry types (`packages/coding-agent/src/collab/host.ts:116-118`). As a result, the
  `parentId`s the guest holds can point at entries it never received. The guest cannot check parent-chain
  continuity locally; cursor walking has to be host-side.

### Phases
- `ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended"`
  (`packages/collab-web/src/lib/client.ts:27`).
- There is no `loading` value. Loading means `waiting` on the first join, or `reconnecting` on a re-welcome, until
  the final chunk arrives.
- Consumers of the phase:
  - Composer allows prompting only when `live` (`packages/collab-web/src/components/shell/Composer.tsx:116-122`);
  - Banners show "joining session…" or "reconnecting…" (`packages/collab-web/src/components/shell/Banners.tsx:12-27`);
  - the HeaderBar dot (`packages/collab-web/src/components/shell/HeaderBar.tsx:72`);
  - Transcript force-scrolls on `live` (`packages/collab-web/src/components/transcript/Transcript.tsx:288-291`).
- In unit tests the socket never opens, so phase stays `connecting` until `live`
  (`packages/collab-web/test/client.test.ts:101-111`).

### What a re-welcome resets
- Everything listed under welcome handling: entries, stream, tools, progress, lifecycle, ui requests, `working`
  (from `state.isStreaming`) and `readOnly`.
- Not reset: `#notices`, `#reqSeq`, `#pendingTranscripts`, `#welcomed`.
- The visible effect of a reconnect: the transcript empties on welcome (entries become `[]`), refills chunk by
  chunk, then force-scrolls to the tail on `live`. The user's scroll position is lost.

### Live `entry` and `event` application
- `entry` (`packages/collab-web/src/lib/client.ts:332-339`):
  - push, then republish a copy;
  - drop the stream ghost when a completed stream's assistant entry lands;
  - no dedup by id. A resume design must dedupe against entries that were already held.
- `event` goes to `#applyEvent` (`packages/collab-web/src/lib/client.ts:414-494`):
  - `message_*` set the stream ghost (`:416-428`);
  - `tool_execution_*` maintain `activeTools` (`:429-459`);
  - `agent_start`/`agent_end` set `working` (`:460-465`);
  - `notice`, retry and compaction events become notices (`:466-489`).
  - The host's live oversize notice arrives this way (`packages/coding-agent/src/collab/host.ts:447-453`).
- A `state` frame is authoritative for `working`. Idle clears activeTools
  (`packages/collab-web/src/lib/client.ts:343-359`).

### Fetch-transcript request/response plumbing (the pattern to reuse)
- The pending map `#pendingTranscripts: Map<reqId, {resolve, timer}>` and the counter `#reqSeq`
  (`packages/collab-web/src/lib/client.ts:86-89`, `:97-98`).
- `fetchTranscript(agentId, fromByte)` (`packages/collab-web/src/lib/client.ts:202-212`):
  1. allocates `++#reqSeq`;
  2. uses `Promise.withResolvers`;
  3. starts a 10 s timeout that resolves `null` (transient);
  4. registers the pending entry;
  5. sends `{t:"fetch-transcript", reqId, agentId, fromByte}`.
- The reply case `transcript` (`packages/collab-web/src/lib/client.ts:380-392`):
  - looks up by reqId, deletes, clears the timer;
  - resolves `{kind:"error"}` when `frame.error` is set, else `{kind:"rows"}`;
  - silently drops late replies for reqIds that already timed out
    (`packages/collab-web/test/transcript-polling.test.ts:66-81`).
- The result type splits terminal `error` from transient `null` (`packages/collab-web/src/lib/client.ts:77-84`).
  The decision logic is a pure function (`packages/collab-web/src/lib/transcript-poll.ts:14-35`) and is unit-tested.
- Consumer: the AgentDrawer polling effect (`packages/collab-web/src/components/agents/AgentDrawer.tsx:42-93`).
  It keeps cursor, carry and accumulator in closure variables and calls `setEntries(acc)`.
- The reply is single-frame: one reply resolves one reqId. If history pages can span several frames, the pending
  record needs an accumulator and an idle timer that is re-armed per frame. The current shape does not support that.

---

## 2. State publishing to React

- Binding: `useGuestSnapshot(client)` calls `useSyncExternalStore(client.subscribe, client.getSnapshot)`
  (`packages/collab-web/src/lib/use-guest.ts:5-11`).
- `#commit()` rebuilds the snapshot object and notifies every listener
  (`packages/collab-web/src/lib/client.ts:538-541`, `:514-536`).
- `#applyFrame` commits once per applied frame (`packages/collab-web/src/lib/client.ts:411`).
- Identity trick: `#publishedEntries` changes reference only on welcome, snapshot-chunk or entry frames
  (`packages/collab-web/src/lib/client.ts:122-129`, `:519-523`). Streaming, state and bus frames reuse the old
  array. This is tested (`packages/collab-web/test/client.test.ts:339-368`) and benchmarked
  (`packages/collab-web/bench/client-frames.bench.ts:1-9`).
- `Session` reads the whole snapshot (`packages/collab-web/src/app.tsx:122-123`) and passes `entries`, `stream`,
  `activeTools`, `working` and `phase` to `<Transcript>` (`packages/collab-web/src/app.tsx:169-177`). So every
  commit re-renders `Session`, HeaderBar, Composer and Transcript.
- Re-render cost while a snapshot loads:
  - `[INFERENCE]` about one React render per `snapshot-chunk` frame. Frames are decrypted in separate async ticks
    (`packages/collab-web/src/lib/socket.ts:151-167`), so there is little batching.
  - Each render pays several O(n) costs:
    - the `results` Map rebuild (`packages/collab-web/src/components/transcript/Transcript.tsx:267-275`);
    - the `tailTools` scan over every block (`:296-314`);
    - `entries.map` element creation (`:326-328`);
    - the client-side array copy (`packages/collab-web/src/lib/client.ts:323`).
  - `EntryRow` is memoized, so only new rows render in full (`:174-187`, `:262`).
  - `followTranscriptTail` runs after every render (`:281-284`).
  - Net effect: quadratic-ish work in chunk count × n. With a 512 KB chunk (`packages/coding-agent/src/collab/host.ts:130`),
    26 MB is about 52 renders of growing n. Tail-first removes most of it.
- There is no virtualization. Every entry stays mounted (`packages/collab-web/src/components/transcript/Transcript.tsx:326-328`).
  `content-visibility` and `overflow-anchor` are not used anywhere in `src`.

---

## 3. Transcript rendering

- Component: `Transcript` (`packages/collab-web/src/components/transcript/Transcript.tsx:264-363`).
  - Props (`:12-23`): `entries`, `stream`, `streamDone`, `activeTools`, `working`, `compact`, `host`, `phase`.
  - The AgentDrawer reuses it in compact mode with no `phase`
    (`packages/collab-web/src/components/agents/AgentDrawer.tsx:172-180`). New props must be optional.
- Row dispatch: `EntryRow` (`packages/collab-web/src/components/transcript/Transcript.tsx:187-262`).
  - Rendered:
    - user messages (`:192-197`);
    - assistant messages through `AssistantBody` (`:198-203`, `:106-165`);
    - `custom_message` of type `collab-prompt` (`:210-223`);
    - other `custom_message` entries with `display` set (`:224-232`);
    - compaction as a divider whose summary appears **only as a `title` tooltip** (`:234-239`);
    - branch_summary (`:240-245`);
    - model and thinking changes (`:246-257`).
  - Skipped: toolResult messages (paired into cards instead), developer messages, unknown types (`:204-206`,
    `:258-260`).
- Tool pairing: the `results` map, keyed by `toolCallId`, is built from every entry
  (`packages/collab-web/src/components/transcript/Transcript.tsx:267-275`). Prepending older pages feeds it with no
  extra work, as long as pages hold whole turns. The map holds `ToolResultMessage` only, **not the entry id**.
- Tail lock:
  - `followTranscriptTail(el, lock, force)` sets `scrollTop = scrollHeight` while locked. `force` re-arms the lock
    (`packages/collab-web/src/components/transcript/Transcript.tsx:35-39`).
  - `updateTranscriptTailLock` locks when within 40 px of the bottom (`:41-44`). It runs `onScroll` (`:320-323`).
  - `lockRef` starts `true` (`:278`).
  - A follow effect runs on `[entries, stream, activeTools, working]` (`:280-284`). It uses `useEffect`, not
    `useLayoutEffect`.
  - A forced follow runs on the `phase === "live"` transition (`:286-291`).
  - Tested as a pure function (`packages/collab-web/test/transcript.test.tsx:153-173`).
- Where "load earlier" goes: at the top of `.tr-root`, before `entries.map`
  (`packages/collab-web/src/components/transcript/Transcript.tsx:325-326`).
  - Show it only when `hasEarlier` is set. Render it disabled with a spinner while a request is in flight.
  - The first tail entry will usually be the compaction divider (`:234-239`), so the control sits directly above it.
- Scroll-anchor preservation on prepend:
  - Detect a prepend: `entries[0].id` changed while the last id stayed the same.
  - Record `scrollHeight - scrollTop` before the commit and restore it in a `useLayoutEffect` after.
  - The existing follow effect (`:281-284`) is harmless there, because the user is unlocked when they tap the
    control at the top.
  - `[INFERENCE]` Native CSS scroll anchoring (`overflow-anchor`) is uneven, notably in Safari. Restore the position
    explicitly instead of relying on it.
  - Do not reuse the `phase` force-follow for page loads.

---

## 4. Placeholders and images today

### `collab-entry-too-large` whole-entry placeholder
- Host shape (`packages/coding-agent/src/collab/replication-shrink.ts:348-361`):
  - `{type:"custom_message", id, parentId, timestamp, customType:"collab-entry-too-large", display:true, content:"…[<type> entry, <bytes> bytes omitted for collab session: too large to replicate]"}`;
  - there are **no `details`**; the original type and size exist only inside the prose string.
- The constant lives in coding-agent (`packages/coding-agent/src/collab/replication-shrink.ts:58`), not in
  `pi-wire`. Compare `COLLAB_PROMPT_MESSAGE_TYPE` (`packages/wire/src/index.ts:169-175`).
- Web rendering: no special case. It falls through to the generic custom row
  (`packages/collab-web/src/components/transcript/Transcript.tsx:224-232`), which shows a `tr-chip` reading
  `collab-entry-too-large` followed by `MsgContent` (Markdown of the prose).
- Where to attach "load full" for (a) whole-entry placeholders:
  - add a branch next to the `collab-prompt` special case
    (`packages/collab-web/src/components/transcript/Transcript.tsx:210`) that renders a button;
  - the entry id is available as `entry.id`;
  - loading replaces the entry in `#entries` by id, so the row re-renders through the memo identity check (`:176`).

### Truncated strings inside an entry
- `clipString` head-truncates any string leaf in place and appends `\n…[N chars elided for collab session]`
  (`packages/coding-agent/src/collab/replication-shrink.ts:148-152`). The shrink passes range from 64 KiB to 64
  chars (`packages/coding-agent/src/collab/replication-shrink.ts:103-111`).
- Array tails are clipped as well.
- No structured metadata survives: no entry id, field path or full size. The guest sees only prose.
- Where such strings render on the web:
  - Markdown text blocks (`packages/collab-web/src/components/transcript/Transcript.tsx:82`, `:88`, `:127`);
  - thinking (`:67-78`, `:123`);
  - tool-call args, through `ToolView` and its renderers;
  - tool results, through `Output`/`ResultText` (`packages/collab-web/src/tool-render/parts.tsx:106-132`,
    `:154-179`).
- `Output` already has a "⋯ N more lines" expand button (`packages/collab-web/src/tool-render/parts.tsx:125-129`).
  It is the natural slot for "load full (N bytes)".
- Constraints for (b) sub-entry placeholders:
  - Tool renderers are host-agnostic and are also bundled into HTML exports
    (`packages/collab-web/src/tool-render/types.ts:1-13`; `packages/collab-web/scripts/build-tool-views.ts:1-8`).
    The load capability must therefore be an optional `ToolRenderHost` method
    (`packages/collab-web/src/tool-render/types.ts:42-47`), provided by `toolHost` in
    `packages/collab-web/src/app.tsx:132-140`. The export host would not provide it.
  - `ToolCard` does not receive the tool-result entry id (`packages/collab-web/src/components/transcript/ToolCard.tsx:7-16`).
    The `results` map (`packages/collab-web/src/components/transcript/Transcript.tsx:267-275`) needs to carry the
    owning entry id, and `AssistantBody` has to forward it (`:128-144`).
- Simplest guest-side design: "load full" refetches the **whole entry** by id and swaps it in `#entries`.
  - A swapped toolResult entry produces a new `results.get(id)` reference. `entryRowEqual` then re-renders the
    owning assistant row (`packages/collab-web/src/components/transcript/Transcript.tsx:179-183`).
  - Field-path patching is only needed if a single field can itself exceed the transport budget.

### Images
- Wire `ImageContent` is `{type:"image", data(base64), mimeType}` (`packages/wire/src/index.ts:23-29`).
  - Allowed in user, developer, toolResult and custom_message content (`:68`, `:77`, `:95`, `:130`).
  - Not allowed in assistant content (`:49`).
- User and custom messages render inline `<img src="data:…">` with no click-to-open
  (`packages/collab-web/src/components/transcript/Transcript.tsx:89-97`; CSS `.tr-msg-img`, max-height 240 px, at
  `packages/collab-web/src/components/transcript/transcript.css:75-78`).
- Tool results use `ResultImages` (`packages/collab-web/src/tool-render/parts.tsx:195-213`).
  - Thumbnails; a click decodes to a Blob URL and opens it in a new tab (`:181-192`).
  - Called from the generic renderer (`packages/collab-web/src/tool-render/generic.tsx:23`) and from bash, browser,
    eval, read and generate_image (see §5).
  - `resultImagesOf` accepts only blocks with a string `data` and `mimeType`
    (`packages/collab-web/src/tool-render/util.ts:159-169`).
- `generate_image` merges `details.images` into content
  (`packages/collab-web/src/tool-render/tools/generate-image.tsx:11-22`).
- Host image stripping (above 24 MiB total, `packages/coding-agent/src/collab/host.ts:79`, `:742-748`):
  - removes image blocks outright, so array indices shift, and removes `details.images`
    (`packages/coding-agent/src/session/messages.ts:666-685`, `:724-747`);
  - leaves a trace only when nothing else remains: `[image removed]` text (`:681-683`).
  - Today the guest cannot tell that an image existed.
- `[INFERENCE]` When `clipString` hits a base64 `data` string above 64 KiB, the result is a broken `<img>`, because
  the elision marker ends up inside the data URL.
- Where to attach (b) for images:
  - an image placeholder block, ideally at the same index, carrying mimeType and size, rendered as a "tap to load
    image" tile in `MsgContent` (`packages/collab-web/src/components/transcript/Transcript.tsx:89-97`) and in
    `ResultImages` (`packages/collab-web/src/tool-render/parts.tsx:195-213`);
  - `resultImagesOf` must not drop the placeholder;
  - the loaded image can reuse `openImage` for full-size viewing.

---

## 5. Tool renderers: `details` fields read (for the later field-profile PR)

- Every renderer reads `result.content` text through `ResultText`/`resultTextOf`
  (`packages/collab-web/src/tool-render/util.ts:148-157`).
- Renderers that call `ResultImages` also read image blocks.
- `ToolView` reads `details.xdev.{mode,tool,args,inner}` for `write` results
  (`packages/collab-web/src/tool-render/ToolView.tsx:45-60`).
- The registry and its aliases are in `packages/collab-web/src/tool-render/registry.ts:37-83`.

| Renderer | `details` fields read | Anchor |
|---|---|---|
| read | `resolvedPath`, `suffixResolution.{to,from}`, `summary.elidedSpans`, `conflictCount`, `truncation` (checked with `isRecord` only). Also images and text. | `packages/collab-web/src/tool-render/tools/read.tsx:17-28`, `:71-98` |
| edit / apply_patch | Summary reads `diff` (skipped on error). Body reads `perFileResults[]`, or the top level, as `{path, diff, firstChangedLine, op, move, isError, displayErrorText\|errorText, diagnostics.{summary,messages,errored}}`. | `packages/collab-web/src/tool-render/tools/edit.tsx:76-92`, `:106-108`, `:191-214` |
| grep | `matchCount`, `fileCount`, `truncated`, `error`, `missingPaths`. **`displayContent` is not read.** | `packages/collab-web/src/tool-render/tools/grep.tsx:44-54` |
| ast_grep | `matchCount`, `fileCount`, `filesSearched`, `limitReached`, `scopePath`, `parseErrors`, `parseErrorsTotal`. `displayContent` is not read. | `packages/collab-web/src/tool-render/tools/ast-grep.tsx:37-46` |
| ast_edit | `fileReplacements`, `parseErrors`, `totalReplacements`, `filesTouched`, `filesSearched`, `limitReached`, `scopePath`, `parseErrorsTotal`, **`displayContent` (rendered as a diff)** | `packages/collab-web/src/tool-render/tools/ast-edit.tsx:45-71`, `:175-176` |
| bash | `async.{state,jobId}`, `exitCode`, `wallTimeMs`, `timeoutSeconds`, `requestedTimeoutSeconds`. Also images and text. | `packages/collab-web/src/tool-render/tools/bash.tsx:28-30`, `:47-51`, `:90-91` |
| browser / puppeteer | `action`, `name`, `url`, `browser`. Also images. | `packages/collab-web/src/tool-render/tools/browser.tsx:15-20`, `:100` |
| eval / js / python / notebook | `cells[].{index,title,code,language,output,status,durationMs,exitCode}`, `jsonOutputs`, `notice`. Also images. | `packages/collab-web/src/tool-render/tools/eval.tsx:292-331`, `:347-372` |
| fetch | `url`, `finalUrl`, `contentType`, `method`, `notes`, `truncated` | `packages/collab-web/src/tool-render/tools/fetch.tsx:8-36` |
| generate_image | `images[]` (merged into content), `provider`, `model`, `revisedPrompt`, `imagePaths` | `packages/collab-web/src/tool-render/tools/generate-image.tsx:11-22`, `:57-63` |
| glob / find | `fileCount`, `resultLimitReached`, `scopePath`, `error`, `meta`, `truncated`, `truncation`, `missingPaths` | `packages/collab-web/src/tool-render/tools/glob.tsx:15-31` |
| write | `diagnostics.{server,messages,summary,errored}`, `madeExecutable` | `packages/collab-web/src/tool-render/tools/write.tsx:16-24`, `:47-53` |
| task | `results[]` (id/description/assignment/durationMs/index…), `progress[]` (status/id/description/lastIntent/currentTool/toolCount/tokens/durationMs), `totalDurationMs` | `packages/collab-web/src/tool-render/tools/task.tsx:24-26`, `:137-154`, `:175-208` |
| job (await/poll/cancel_job) | `jobs[].{id,type,status,label,durationMs,resultText,errorText}`, `cancelled[].{id,status}` | `packages/collab-web/src/tool-render/tools/job.tsx:66-97`, `:189` |
| hub | Presence of `daemon`/`daemons`/`terminalRows`/`spec`/`state`/`cursor`, `jobs`/`agents`, `receipts`/`waited`/`inbox`/`peers` (used for dispatch) | `packages/collab-web/src/tool-render/tools/hub.tsx:20-36` |
| irc | `waited`, `inbox`, `peers`, `receipts` (nested message and peer fields) | `packages/collab-web/src/tool-render/tools/irc.tsx:110-187` |
| github | `watch.{mode,repo,run,state,headSha,note,runs,failedLogs}`, `checkouts`, `runIds`, `failedJobs[]` | `packages/collab-web/src/tool-render/tools/github.tsx:179-199`, `:279-311` |
| debug | `snapshot.{id,source,adapter,status,program,frameName,stopReason,line,column,exitCode,needsConfigurationDone}`, `action` | `packages/collab-web/src/tool-render/tools/debug.tsx:23-43` |
| lsp | `serverName`, `action` | `packages/collab-web/src/tool-render/tools/lsp.tsx:159-169` |
| goal | `goal.{objective,status,tokenBudget,tokensUsed,timeUsedSeconds}`, `op`, `completionBudgetReport` | `packages/collab-web/src/tool-render/tools/goal.tsx:16-28`, `:90-113` |
| todo | `phases` | `packages/collab-web/src/tool-render/tools/todo.tsx:142-143` |
| ask | `results[]` or the top level: `question`, `selectedOptions`, `customInput`, `id`, `note`, `timedOut` | `packages/collab-web/src/tool-render/tools/ask.tsx:101-140`, `:209` |
| resolve | `action`, `extra`, `reason`, `sourceToolName`, `label`, `title`, `planFilePath` | `packages/collab-web/src/tool-render/tools/resolve.tsx:48-66` |
| web_search | `response.{provider,model,authMode,sources,usage.{inputTokens,outputTokens,totalTokens,searchRequests}}`, `error` | `packages/collab-web/src/tool-render/tools/web-search.tsx:68-88` |
| retain | `count` | `packages/collab-web/src/tool-render/tools/memory-retain.tsx:30`, `:42` |
| recall / reflect / report_tool_issue / yield / generic | none (content text only) | per the grep scan |

Notes for the field-profile PR:
- The read tool's `details.displayContent` is produced host-side (for example
  `packages/coding-agent/src/tools/read.ts:2552`, `:2707`) and grep's at `packages/coding-agent/src/tools/grep.ts:1559`.
  The web never reads either one.
- ast_edit **does** read `displayContent`.

---

## 6. Tests

- Framework: `bun:test`, including `vi.useFakeTimers` and `vi.spyOn`.
- Location: `packages/collab-web/test/*.test.ts(x)`.
- There are no component-DOM or e2e browser tests. Component tests use `renderToStaticMarkup` plus Bun's
  `HTMLRewriter` (`packages/collab-web/test/transcript.test.tsx:1-4`, `:58-84`) and a one-line `HTMLElement` shim
  (`packages/collab-web/test/transcript-dom-shim.ts:1-4`).
- Relevant files:
  - `packages/collab-web/test/client.test.ts`:
    - helpers `welcomeFrame`, `snapshotChunk`, `liveClient` (`:55-68`);
    - chunk-timeout test (`:96-125`);
    - entries identity tests (`:339-368`);
    - UI-request send spy on `CollabSocket.prototype.send` (`:288-311`), which is the pattern for asserting what the
      hello and history frames contain.
  - `packages/collab-web/test/transcript-polling.test.ts`: the reqId request/response contract (`:30-82`) and the
    pure decision function (`:84-144`).
  - `packages/collab-web/test/socket-reconnect.test.ts`: `ScriptedWebSocket` fake (`:8-63`) for reconnect and
    re-hello flows (`:71-116`).
  - `packages/collab-web/test/transcript.test.tsx`: static render plus tail-lock unit test (`:153-173`).
  - Others: `composer.test.tsx`, `tool-view.test.tsx`, `markdown.test.tsx`, `link.test.ts`, `codec.test.ts`,
    `local-relay.test.ts`.
- Test seam: `applyFrameForTest(frame)` (`packages/collab-web/src/lib/client.ts:214-217`).
- Benchmark: `bun packages/collab-web/bench/client-frames.bench.ts`.
- Running one file, verified here (24 pass, 0 fail):
  `cd packages/collab-web && bun test test/client.test.ts test/transcript.test.tsx`.
  - The package script runs everything: `"test": "bun test --parallel"` (`packages/collab-web/package.json:32`).
  - Type check: `check:types` → `tsgo -p tsconfig.json --noEmit` (`:34`). `tsconfig` includes `src`, `scripts`
    and `test` (`packages/collab-web/tsconfig.json:3`).
- Manual harness:
  - `bun run mock-host` (`packages/collab-web/scripts/mock-host.ts:1-10`) serves `fixtureEntries`
    (`packages/collab-web/scripts/fixture.ts:65`).
  - It handles `hello` at `packages/collab-web/scripts/mock-host.ts:185-209`, sending welcome plus a single
    `final: true` chunk, and dispatches frames at `:253-274`.
  - It must learn the tail and history frames too.
- **Wire conformance test: does not exist.**
  - `packages/wire/src/index.ts:7` names `packages/coding-agent/test/collab/web-wire.types.ts`, but that file is
    absent at fd3f8e3c56 and has no git history (`git log --all` on the path is empty).
  - The only wire test checks constants (`packages/wire/test/constants.test.ts`: `COLLAB_PROTO === 3`, etc.).
  - What conformance exists is structural:
    - Host `CollabFrame` takes guest frames verbatim from wire (`Exclude<GuestFrame, {t:"prompt"}>`,
      `packages/coding-agent/src/collab/protocol.ts:54-57`). New hello fields and new guest frame variants added to
      `pi-wire` reach the host type automatically.
    - Host→guest frames are **re-declared** in `packages/coding-agent/src/collab/protocol.ts:59-96`, and nothing
      type-checks them against wire `HostFrame` (`packages/wire/src/index.ts:345-380`). A new welcome capability
      field and new reply frames must be added in both places by hand.
    - Adding a `satisfies`/assignability check would close the gap.

---

## 7. Build

- `bun run build` (`packages/collab-web/package.json:29`):
  `rm -rf dist && bun build ./index.html --outdir=dist --minify` with hashed entry, chunk and asset names, then
  `mv dist/*.html dist/index.html && cp -R public/. dist/`.
- The entry is `index.html`, which loads `./src/main.tsx` (`packages/collab-web/index.html:74`). `main.tsx` mounts
  `<App/>` (`packages/collab-web/src/main.tsx:1-8`).
- Output: `packages/collab-web/dist/`, a static SPA (`packages/collab-web/README.md:20-23`).
- Dev: `bun run dev` (`bun ./index.html`) and `bun run mock-host` (`packages/collab-web/package.json:26-28`).
- `gen:tool-views` bundles `src/tool-render/standalone.tsx` into
  `packages/coding-agent/src/export/html/tool-views.generated.js`
  (`packages/collab-web/scripts/build-tool-views.ts:7`, `:13-21`). Renderer changes affect HTML exports only after a
  regen; the load-full affordance must degrade to nothing there.
- `index.html` loads a third-party analytics script (`https://um.can.ac/script.js`,
  `packages/collab-web/index.html:69`). The hub serves this build, so the script ships to hub users too. This is an
  observation only.
- omp-connected consumer: `hub/scripts/build-vendor-collab.sh`.
  - It resolves `COLLAB_WEB_SRC`, which defaults to `hub/vendor/collab-web/packages/collab-web` and can be overridden
    by env (`hub/scripts/build-vendor-collab.sh:11-18`).
  - It runs `bun run build` in the source directory (`:21`), then replaces `hub/dist/webui/collab/` with `dist/.`
    (`:13`, `:23-25`). The hub serves that directory at `/collab/` (`:2-3`).
  - Consequence: a fork implementation needs either the submodule pointed at our fork commit, or `COLLAB_WEB_SRC`
    set to a writable checkout. The pristine vendor tree cannot hold the change.
  - `bun run build` writes `dist/` inside the vendor tree. `dist` is ignored, so the tree stays git-clean; this was
    verified with `git status --porcelain` after the test run.

---

## 8. Insertion points

| Change | Where |
|---|---|
| **Tail opt-in in hello** (budget constant in the guest) | Wire: optional fields on the hello variant (`packages/wire/src/index.ts:325-335`); the host type picks them up through `protocol.ts:56`. Guest: a constant next to the timeouts (`packages/collab-web/src/lib/client.ts:70-75`), sent in `#handleOpen` (`:219-224`). An old host ignores the extra fields: `#handleHello` takes only `name`, `proto` and `writeToken` (`packages/coding-agent/src/collab/host.ts:664`, `:713`). Mock host: `packages/collab-web/scripts/mock-host.ts:185-209`. |
| **Capability detection from welcome** | Wire: an optional field on welcome (`packages/wire/src/index.ts:346-361`) **and** the duplicate in `packages/coding-agent/src/collab/protocol.ts:59-74`. Guest: record it in the welcome case (`packages/collab-web/src/lib/client.ts:292-317`) and publish history state (for example `hasEarlier`/`loadingEarlier`/`historyError`) through `GuestSnapshot` (`:45-68`) and `#buildSnapshot` (`:514-536`). Without the capability, never send history or full-value requests: the old host drops them silently (`packages/coding-agent/src/collab/host.ts:680-681`). |
| **History page request and prepend** | Wire: a new guest frame beside `fetch-transcript` (`packages/wire/src/index.ts:340`) and a reply frame beside `transcript` (`:378`), plus the host mirror (`packages/coding-agent/src/collab/protocol.ts:94`). Guest: a method modeled on `fetchTranscript` (`packages/collab-web/src/lib/client.ts:202-212`) with its own pending map (the `:86-89`, `:97` pattern) and a reply case (the `:380-392` pattern). Prepend with an id dedup set into `#entries` and republish the array (the `:322-323` pattern). The cursor is `#entries[0].id`. On `stale`, discard history state and re-hello or resnapshot. UI: the control at `packages/collab-web/src/components/transcript/Transcript.tsx:325`, new optional props (`:12-23`), wiring at `packages/collab-web/src/app.tsx:169-177`, and a `useLayoutEffect` scroll restore next to `:280-291`. |
| **Placeholder expansion fetch** | Wire: move or duplicate `collab-entry-too-large` into `pi-wire` next to `COLLAB_PROMPT_MESSAGE_TYPE` (`packages/wire/src/index.ts:169-175`). Give placeholders structured `details` (entry id, field path, full size) instead of prose-only content (`packages/coding-agent/src/collab/replication-shrink.ts:352-360`, `:148-152`). Guest: a `fetchEntry`/`fetchValue` method on the same reqId pattern, then swap the entry by id in `#entries`. UI: (a) `packages/collab-web/src/components/transcript/Transcript.tsx:209-232`; (b) `Output` (`packages/collab-web/src/tool-render/parts.tsx:106-132`), `MsgContent` (`packages/collab-web/src/components/transcript/Transcript.tsx:81-104`) and `ResultImages` (`packages/collab-web/src/tool-render/parts.tsx:195-213`), reached through an optional `ToolRenderHost` method (`packages/collab-web/src/tool-render/types.ts:42-47`, provided at `packages/collab-web/src/app.tsx:132-140`). The entry id is threaded through the `results` map and `ToolCard` (`packages/collab-web/src/components/transcript/Transcript.tsx:267-275`, `:133-143`; `packages/collab-web/src/components/transcript/ToolCard.tsx:7-16`). |
| **Resume id on reconnect** | `#handleOpen` (`packages/collab-web/src/lib/client.ts:219-224`): when `#everConnected` is set and the previous load finished, send the last held id (`#entries.at(-1)?.id`). Welcome case (`:295-297`): do not clear `#entries`/`#publishedEntries` when the host acknowledges a resume. Clear them on `stale` or a plain welcome, as today. Dedupe the resumed entries by id, because the `entry` case (`:332-334`) does not. Fail pending history and full-value requests in `#handleClose` (`:226-235`); today only `#end` does (`:243-247`). Consider re-arming a welcome timer per reconnect (`:151`). |
| **Per-page idle timeout** | The existing `SNAPSHOT_PROGRESS_TIMEOUT_MS` (`packages/collab-web/src/lib/client.ts:74-75`, `:260-273`) is **already an idle timer**, re-armed on welcome and on every non-final chunk (`:313-315`, `:327-328`). This is tested at `packages/collab-web/test/client.test.ts:96-125`. The whole-join timer is `WELCOME_TIMEOUT_MS` (`:72-73`, `:151-156`). For tail pages, keep the chunk idle timer for the initial tail. History and full-value requests get a per-request idle timer, like `TRANSCRIPT_TIMEOUT_MS` (`:205-208`), re-armed on each partial frame if replies are multi-frame. An idle timeout on a page request should reject that request with a retryable error, not `#end()` the session. |
