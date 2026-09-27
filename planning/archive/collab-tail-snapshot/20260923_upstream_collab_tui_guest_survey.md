# Upstream Collab TUI guest survey (tail-first snapshot, #9469)

Date: 2026-09-23
HEAD: c046df93c5 (omp-connected)
Upstream: fd3f8e3c56

Scope: the terminal Collab guest (`packages/coding-agent/src/collab/guest.ts`,
`controller.ts`) and the code it calls to apply, store and render replicated
entries. All paths are relative to the upstream monorepo root
(`hub/vendor/collab-web`). Nothing was edited there.

`controller.ts` is host-side only. It owns `/collab` hosting and auto-start. Its only guest
touchpoints are "don't host while a guest owns the session" checks
(`packages/coding-agent/src/collab/controller.ts:83`, `:99`, `:126`, `:214`, `:279`)
and `resumeAfterGuest()`, which re-admits auto-hosting after the guest restores
the local session (`controller.ts:88-103`, called from `guest.ts:803`). Tail-first work needs no
changes in `controller.ts`.

---

## 1. Guest connection lifecycle

### Entry point
- `/join <link>` → `new CollabGuestLink(ctx).join(link)`
  (`packages/coding-agent/src/slash-commands/builtin-collaboration.ts:412-442`).
- `join()` parses the link, claims `ctx.collabGuest` synchronously, imports the room
  key and builds a `CollabSocket` with `role: "guest"` (`guest.ts:259-278`).

### hello construction
- Sent from `socket.onOpen`, so it is sent again on every (re)connect (`guest.ts:290-306`):
  ```ts
  socket.send({ t: "hello", proto: COLLAB_PROTO, name: collabDisplayName(this.#ctx), writeToken: this.#writeToken });
  ```
- Wire grammar for `hello`: `packages/wire/src/index.ts:325-335`. `COLLAB_PROTO = 3`
  (`wire/src/index.ts:397`). The host rejects any mismatch with a targeted `error`
  (`packages/coding-agent/src/collab/host.ts:718-724`). The host's dispatcher
  destructures only `name`, `proto` and `writeToken` (`host.ts:663-664`). Extra optional hello
  fields are therefore ignored by old hosts, so they are a safe opt-in channel.

### welcome handling
- `onFrame` pushes every frame onto the strictly ordered `#applyChain`
  (`guest.ts:167-168`, `:307-348`).
- `welcome` clears the welcome timer and calls `#beginWelcome(frame, joined)`. The
  `joined` flag becomes `isResync`. If `entryCount === 0` it finalizes immediately
  (`guest.ts:311-318`).
- `#beginWelcome` latches `header`, `state`, `agents`, `readOnly` and
  `entryCount` into `#pendingSnapshot` and arms the snapshot-progress timer
  (`guest.ts:407-419`). The welcome frame shape is declared twice: once in the wire package
  (`wire/src/index.ts:346-361`) and again as a richly typed copy in
  `packages/coding-agent/src/collab/protocol.ts:59-74`. **Any new welcome capability field
  must be added to both.**
- A pre-welcome `error` fails the join with the host's message
  (`guest.ts:328-337`). This is the proto-mismatch path.

### `#pendingSnapshot` accumulation
- Type `PendingSnapshot` (`guest.ts:78-86`). Field `entries: SessionEntry[]`
  grows via `push(...frame.entries)` (`guest.ts:427-441`).
- Completion: `frame.final || pending.entries.length >= pending.entryCount`
  (`guest.ts:434`). An orphan chunk (no pending welcome) is dropped (`guest.ts:429-431`).
- `#finalizeSnapshot()` (`guest.ts:444-513`):
  1. Writes `[header, ...entries]` as JSONL to
     `<configRoot>/collab/<roomId>.jsonl`, **overwriting** the replica each time
     (`guest.ts:449-451`).
  2. `session.switchSession(replicaPath, { preserveLocalCwd: true })`
     (`guest.ts:455`). This runs the full `/resume` machinery
     (`packages/coding-agent/src/session/agent-session.ts:9450-9603`). It loads the
     file into `SessionManager`, then calls
     `agent.replaceMessages(buildDisplaySessionContext().messages)` (`agent-session.ts:9580`, `:9595`).
  3. Clears transient UI and the agent mirror, applies host state/model/thinking, and
     re-seeds agents and the observer registry (`guest.ts:461-474`).
  4. `renderInitialMessages({ clearTerminalHistory: true })`, a destructive full
     transcript replay (`guest.ts:481`). On failure it seals orphaned live blocks
     (`guest.ts:482-502`).
  5. Reloads todos, sets `#readOnly`, sets `#welcomed = true`, and shows "Joined…"/"Reconnected…"
     (`guest.ts:504-512`).
- Until `#welcomed` is set, `#applyFrame` drops live frames (`guest.ts:338`). The host
  queues the whole chunk train synchronously right after the welcome, so live frames cannot
  overtake it (`host.ts:729-730`, `:752-764`).

### Timeouts
- `WELCOME_TIMEOUT_MS = 30_000` (`guest.ts:63`). It is armed in `join()` (covers a
  blackholed handshake, `guest.ts:366-368`) and again in `onOpen` (`guest.ts:299`).
- `SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000` per chunk, re-armed on every chunk
  (`guest.ts:71`, `:436-439`, `:531-538`).
- **Both timers only arm while `#joinReject !== null`, i.e. during the first
  join** (`guest.ts:516`, `:532`, doc at `:181-187`). A stall during a reconnect falls
  through to normal socket-close handling. No timer covers a reconnect-time snapshot.
- `TRANSCRIPT_TIMEOUT_MS = 20_000` is the per-request timeout for the existing
  on-demand fetch (`fetch-transcript`, used for subagent transcripts) (`guest.ts:72`,
  `:218-235`). This is the ready-made pattern for history and placeholder requests.

### Reconnect / `onOpen` resets
- `onOpen` sets `#welcomed = false`, `#pendingSnapshot = null`, clears the progress
  timer, re-arms the welcome timer, and resends hello (`guest.ts:290-306`). The comment
  says "the host will resend the full chunk train". Today every reconnect re-downloads and
  rewrites the whole replica and redoes `switchSession` plus a destructive re-render.
- `onClose` clears both timers and flushes pending transcript requests with `null`
  (`guest.ts:349-352`). A reconnecting close only shows a dim status (`guest.ts:358-361`). A
  terminal close restores the local session (`guest.ts:362-363`).
- `bye` restores the local session (`guest.ts:604-607`). Leave/restore:
  `#restoreLocalSession` → `#runRestoreLocalSession` → `#resumeLocalSession`
  (`guest.ts:793-847`). The replica file is left on disk (`guest.ts:825-826`).

---

## 2. What the TUI guest does with snapshot entries (definitive)

**Answer: it ingests them into a real local `SessionManager` and loads them into the
local `Agent`'s message array. It also renders them. By design, it never sends
them to a model provider. But two ungated input paths upstream can make the guest's
local `AgentSession.prompt()` run a real model turn over the replicated messages.
Those paths are a bug to fix, not a reason to replicate provider-replay fields.**

Evidence:

- **Stored in SessionManager.** The snapshot is written as a session file and loaded via
  `switchSession` (`guest.ts:449-455`). Live `entry` frames go through
  `sessionManager.ingestReplicatedEntry(frame.entry)` (`guest.ts:553`). That call is
  `#recordEntry` (`packages/coding-agent/src/session/session-manager.ts:2706-2708`), which
  appends to `#entries`, inserts into the index (making the entry the new leaf), **appends to
  the replica file**, and fires `onEntryAppended` (`session-manager.ts:1560-1576`,
  `:445-449`). It does not de-duplicate.
- **Fed to the agent's context array.** `switchSession` calls
  `agent.replaceMessages(sessionContext.messages)` (`agent-session.ts:9595`). Live
  message entries append (`guest.ts:554-555`). Compaction and branch-summary entries rebuild
  the array from `buildDisplaySessionContext()` (`guest.ts:556-563`). The class doc says the
  array exists for "/dump, context estimates" (`guest.ts:550-552`; header `guest.ts:4-8`).
- **Rendered.** The initial render is `renderInitialMessages` (`guest.ts:481`). Live rendering
  is events-only: `#applyEvent` → `eventController.handleEvent` (`guest.ts:617-634`). Entries
  are "never rendered directly" (`guest.ts:550`).
- **Host model is applied as pure agent state.** `session.agent.setModel(state.model)`,
  `setThinkingLevel`, `setDisableReasoning` (`guest.ts:642-654`). So the replica agent is
  configured for the host's provider and model.
- **Intended guards (prompts go to the host):**
  - Enter/submit: the guest branch forwards via `collabGuest.sendPrompt` and blocks `/`, `!` and
    python input (`packages/coding-agent/src/modes/controllers/input-controller.ts:1002-1027`).
    `sendPrompt` emits a `prompt` frame (`guest.ts:391-394`).
  - Esc sends `abort` to the host (`input-controller.ts:516-524`).
  - `/retry` is host-only (`input-controller.ts:1528-1532`).
  - Slash commands are gated by `COLLAB_GUEST_ALLOWED_COMMANDS` (`guest.ts:43-57`,
    `packages/coding-agent/src/slash-commands/builtin-registry.ts:136-140`).
  - Subagent focus is blocked (`packages/coding-agent/src/modes/controllers/session-focus-controller.ts:66`).
  - The replica agent never runs a turn, so AgentSession auto-compaction and title logic tied
    to the local agent's own events never fire. Replicated events go only to
    `EventController` (`guest.ts:633`).
- **Local provider-call paths that are NOT gated for a guest (code-path evidence):**
  1. **Follow-up key** (`app.message.followUp`, default `ctrl+q`/`ctrl+enter`,
     `packages/tui/src/app-keybindings.ts:144-147`) → `handleFollowUp()`
     (`input-controller.ts:646-648`). The function has no `collabGuest` check. It reaches
     `this.ctx.session.prompt(text, { images })` (`input-controller.ts:1662-1747`,
     prompt at `:1741`, or `:1727` when streaming). Skill commands on the same path go to
     `#invokeSkillCommand` (`:1704`).
  2. **`->` / `=>` yield-queue shorthand** is parsed at `input-controller.ts:971-978`,
     *before* the guest gate at `:1005`. `#queueForYield` then calls
     `onInputCallback(submission)` (→ `main.ts:751-752` `submitInteractiveInput` →
     `session.prompt`, `packages/coding-agent/src/main.ts:424`, `:441`) or calls
     `session.prompt`/`session.followUp` directly (`input-controller.ts:1592-1624`).
     `main.ts` has no guest check.

  Either path makes the guest's *local* `AgentSession` start a turn. That turn uses the host's
  model id (`guest.ts:649`) and **the guest's own credentials**, with the replicated message
  array as context. This is the only way `thinkingSignature` / `providerPayload` could ever be
  replayed from a guest. **[INFERENCE]: not executed.** A throwaway probe driving
  `InputController.handleFollowUp()` with `ctx.collabGuest` set could not run: the vendor
  checkout has no built `pi_natives` binary (`packages/natives/native/loader-state.js:895`),
  and building is out of scope. The control flow above is unconditional on `collabGuest`.
  No existing test covers either path. The fix is to gate both paths, not to keep signatures.
- **Replay-driven UI that could start a local turn:** a replicated `tool_execution_end` for
  an `xd://propose` write triggers `ctx.handlePlanApproval(...)` on the guest
  (`packages/coding-agent/src/modes/controllers/event-controller.ts:1947-1986`). It
  returns early unless the guest's *local* `planModeEnabled` is set
  (`packages/coding-agent/src/modes/interactive-mode.ts:5216-5220`). `/plan` is not in the guest
  allowlist, so this is effectively inert **[INFERENCE]: a guest that had plan mode on locally
  before `/join` was not traced.**
- **`/dump` builds a provider request without network I/O.** `dumpLlmRequestToTmpDir`
  converts the agent messages with `convertMessagesToLlm` and writes JSON to tmp
  (`agent-session.ts:11078-11111`, "no network round-trip" at `:11082`). `/dump` is
  guest-allowed (`guest.ts:44`), so its sidecar would show missing signatures as missing, but
  nothing is sent.
- **Only non-render TUI reader of signatures:** the status-line context memo's
  `messageFingerprint` adds signature *lengths* to a cache key
  (`packages/tui/src/status-line/component.ts:106-205`). That is correctness-neutral. The guest's
  context meter uses the host's `state.contextUsage` override anyway
  (`status-line/component.ts:2083-2087`; `SessionState.contextUsage` at
  `wire/src/index.ts:233`).

Conclusion for design: in intended operation, the TUI guest needs no
`thinkingSignature` or `providerPayload`. The Enter path is gated, and every rendering or
status consumer either ignores those fields or uses only their lengths as a cache key.

---

## 3. History rendering, partial history and prepending

### How the transcript is built
- `renderInitialMessages` (`packages/coding-agent/src/modes/utils/ui-helpers.ts:907-1039`)
  builds `viewSession.buildTranscriptSessionContext({ collapseCompactedHistory:
  settings.get("display.collapseCompacted"), keepDanglingToolCalls })` (`ui-helpers.ts:909-912`).
  It renders incrementally into a staged `TranscriptContainer`, swaps the tree in atomically
  (`:915-1007`), and with `clearTerminalHistory` issues `requestRender(true, { clearScrollback: true })`
  (`:1021-1022`).
- **`display.collapseCompacted` defaults to `true`**
  (`packages/coding-agent/src/config/settings-schema.ts:1245-1254`). In collapsed transcript mode
  the context builder emits (`packages/coding-agent/src/session/session-context.ts:466-596`):
  - the kept region, starting at `compaction.firstKeptEntryId` and advanced to the next turn
    start inside it (`:543-571`);
  - then the compaction summary divider (`:587-590`);
  - then post-compaction entries (`:592-596`);
  - a later `/clear` `reset_boundary` wins over the compaction (`:446-465`).
  With `collapseCompacted=false`, every path entry renders with inline dividers (`:405-445`).
  **So by default the TUI already displays only the tail from the latest compaction.** Everything
  older is downloaded but never shown.
- The host's compaction already triggers a destructive rebuild on the guest
  (`event-controller.ts:2189-2205` → `rebuildChatFromMessages`,
  `interactive-mode.ts:2767`, `:2797-2799`). The TUI routinely drops pre-compaction rows
  from the screen.
- Path walking tolerates a missing ancestor. `pathTo()` stops when `parentId` is not in
  the index (`session-manager.ts:510-545`, loop at `:532-536`), and `tree()` treats orphans as
  roots (`session-manager.ts:547-561`, doc `:3106-3107`). **A tail-only replica whose first
  entry's `parentId` is absent is structurally fine.**
- The leaf is the last entry inserted: `insert()` sets `#leaf = entry.id`
  (`session-manager.ts:445-449`), and loading is `#index.rebuild(entries)` in file order
  (`session-manager.ts:440-443`, `:1540`). **File order is the leaf contract. Older pages must go
  *before* existing lines, never be appended.** Appending them via `ingestReplicatedEntry` would
  move the leaf backward.

### Is the chat append-only? Is there scrollback paging?
- Yes, it is append-only with native terminal scrollback. `TranscriptContainer` blocks move
  `active → settled → committed`. "committed: logically retired; replay never rewinds this state"
  (`packages/tui/src/chrome/transcript-container.ts:61-64`, `:149-150`). Committed rows live in
  the terminal's own scrollback (`packages/tui/src/tui.ts:127-131`). Only a full replay with
  `clearScrollback` rewrites them (`tui.ts:2141-2146`, `:2799-2803`).
- Even Ctrl+O expansion does not alter committed blocks: "blocks already committed to
  terminal history stay at their committed presentation" (`input-controller.ts:2406-2416`).
- There is no in-app scrollback paging. Inline mouse clicks exist only behind the opt-in
  `tui.mouse` setting and only for mutable-viewport lines, resolving subagent ids for
  click-to-focus (`input-controller.ts:421-428`, `:759-760`;
  `packages/tui/src/prompt/composer.ts:473-477`). Retired rows are never clickable.

### Realistic TUI UX
- **Partial (tail-only) history:** supported without renderer changes if the tail starts at or
  before the display start that `session-context.ts:543-571` computes. That start is the
  turn start at or after `firstKeptEntryId`. A tail that starts at the compaction entry itself
  would visibly lose the kept turns compared with today. Rounding the boundary back to the
  turn containing `firstKeptEntryId` is safe, because the builder hides any extra prefix
  (`:563-568`).
- **"Load earlier":** prepending is only feasible as a destructive replay. Fetch pages →
  rewrite the replica as `header + older + existing` → `switchSession(replica)` →
  `renderInitialMessages({ clearTerminalHistory: true })`. That is exactly the
  `#finalizeSnapshot` tail (`guest.ts:449-481`), and the same destructive repaint that
  compaction, resync and `/resume` already use (`event-controller.ts:2201-2202`,
  `selector-controller.ts:1988-1990`). With the default `collapseCompacted=true` the newly
  loaded entries are *not displayed* anyway. They matter for `/export` (`exportToHtml` of the
  replica, `builtin-collaboration.ts:174-196`), `/dump`, `collapseCompacted=false`, and the
  "Session compacted N times" status, which counts compaction entries in the replica
  (`ui-helpers.ts:1009-1020`).
  - Trigger: a verb on the already guest-allowed `/collab` command (`guest.ts:54`), e.g.
    `/collab history [all|<n>]`. It must be handled before the guest early-exit at
    `builtin-collaboration.ts:392-395`, next to `status` (`:315-333`).
- **Placeholders:** the renderer contract matters more than any expansion UI.
  - TUI renderers read heavy fields as strings: `grep`/`ast-grep`/`ast-edit` call
    `(details.displayContent ?? text).split("\n")` (`packages/tui/src/tools/grep.ts:352`,
    `ast-grep.ts:117`, `ast-edit.ts:153`), and `read` reads `displayContent.text`
    (`packages/tui/src/tools/read.ts:341`).
  - A non-string placeholder object in a string field would throw. Renderer throws are caught
    and fall back to raw text output (`packages/tui/src/chat/tool-execution.ts:980-1022`,
    `:1138-1170`), so the UI degrades rather than crashes.
  - **Recommendation for the shared placeholder contract:** keep placeholders
    **schema-compatible**. Replace a string field with a string marker (the existing
    `clipString` marker style, `packages/coding-agent/src/collab/replication-shrink.ts:143-152`).
    Replace an image block with a text block. Omit a whole entry as today's typed
    `custom_message` (`replication-shrink.ts:348-361`), which the TUI already renders via the
    generic `CustomMessageComponent` (`ui-helpers.ts:245-249`). Carry `{entryId, fieldPath,
    fullBytes}` in an additive side field. Old TUI guests will then render every placeholder
    legibly with zero code.
  - Expansion in a terminal: an explicit `/collab expand [last|all]` fetches the fields,
    patches the replica entries, and does the same destructive replay. In-place expansion of
    committed rows is impossible (see above). Ctrl+O cannot be the trigger either: it is a
    global live-block toggle (`input-controller.ts:2369-2378`) and would need a network
    round-trip in a key handler.
  - **Images:** the TUI shows images inline only with `terminal.showImages` on a graphics-capable
    terminal (`ui-helpers.ts:600`, `:654-669`; `packages/tui/src/tools/read.ts:342`). User-message
    images become links through `putBlobSync` (`ui-helpers.ts:109-120`, `:283-289`). A fetched
    image can be written to the guest blob store and shown the same way.

---

## 4. Heavy fields the TUI renderers read (for the later field-profile PR)

Replay dispatch: `ui-helpers.ts:474-758`. Tool blocks get `ToolExecutionComponent(renderToolName,
args, …)` (`:595-608`) and `updateResult(message)` with the whole `toolResult` message
(`:686`, `:707`). The built-in renderer then gets `{ content, details, isError }`
(`tool-execution.ts:1000-1003`, `:1148-1151`).

| Tool / message | Fields read | Anchor |
|---|---|---|
| read (single) | `details.displayContent.{text,startLine,lineNumbers}`, fallback `content[text]`, `content[image]`, `details.meta` | `packages/tui/src/tools/read.ts:336-345`, `:450-452` |
| read (grouped) | `details.displayContent.{text,startLine,lineNumbers}`, fallback text | `packages/tui/src/chat/read-tool-group.ts:450-457` |
| read images | `toolResult.content[type=image]` → `assistantComponent.setToolResultImages` | `ui-helpers.ts:654-669` |
| edit | call: `args.edits`, `args.input`/`_input` (hashline/sloppy/apply_patch), `args.diff`, `args.newText`, `args.patch`, `args.previewDiff`; result: `details.diff`, `details.perFileResults[].diff`, `details.firstChangedLine`, `details.diagnostics`, `details.path` | `packages/tui/src/tools/edit.ts:423-425`, `:580-587`, `:664`, `:712`, `:727-729`, `:1039-1043`, `:1093`, `:1122-1151` |
| grep | `details.displayContent` (string), `details.displayTargets`, fallback `content[text]` | `packages/tui/src/tools/grep.ts:46-48`, `:274`, `:352` |
| ast-grep / ast-edit | `details.displayContent` (string), fallback text | `packages/tui/src/tools/ast-grep.ts:34`, `:117`; `ast-edit.ts:35`, `:153` |
| write | `args.content` (full file body) | `packages/tui/src/tools/write.ts:77-79`, `:379`, `:426` |
| bash/eval exec messages | `output`, `images`, `meta.truncation` | `ui-helpers.ts:156-181` |
| user/developer | `content` text + image blocks (materialized to blob links) | `ui-helpers.ts:271-293`, `:109-120` |
| assistant | content blocks (text/thinking/toolCall); `usage`, `duration`, `ttft` for usage rows | `ui-helpers.ts:486-642` |
| compaction | `summary`, `shortSummary`, `tokensBefore/After`, `warning`, `method`; snapcompact archive only when **not** collapsed (`preserveData`) | `session-context.ts:188-193`, `:428-440`, `:497-509` |

Fields the TUI does **not** read for display: `thinkingSignature`, `textSignature`,
`thoughtSignature`, `redactedThinking.data` (used only as lengths in a status-line cache key,
`status-line/component.ts:140-190`), and `providerPayload`, which only the non-transcript LLM
context uses (`session-context.ts:467-503`, `:512-514`). OpenAI remote-compaction
`replacementHistory` is LLM-only (`session-context.ts:537-542`). Consumers that read
*everything*: `/dump` (`builtin-collaboration.ts:225-257`), `/export` (`:174-196`), `/copy`
(`:539-543`). A field profile must treat those as "degraded but allowed" on a guest.

---

## 5. Relevant existing tests and helpers
All under `packages/coding-agent/test/collab/` unless noted.

- `chunked-welcome.test.ts` (#3144):
  - Real `CollabHost` over the in-memory relay; the guest socket asserts a small welcome followed
    by an in-order multi-chunk train with only the last chunk `final` (`:219-272`).
  - `CollabGuestLink` join failure and cancel paths (`:200-217`, `:274-314`); host state applied
    only after replica activation (`:315-334`).
  - Guest ctx builders `makeFailingGuestContext` / `makeCancelledSwitchGuestContext` (`:90-176`)
    and the `makeLargeSnapshot` sizing trick (`:39-55`).
  - Natural home for "tail welcome + snapshotStart" and per-page chunk assembly tests.
- `discarded-entry-marker.test.ts`: real host `SessionManager` → guest `SessionManager.inMemory()`
  via `ingestReplicatedEntry`, asserting `getBranch()` ids (`:41-94`). Template for "tail page
  keeps the branch connected" and "prepended page yields the same branch".
- `session-replication.test.ts`: `ingestReplicatedEntry` keeps foreign ids and advances the
  leaf, plus a file round-trip (`:66-92`); `snapshotForReplication` deep-copies (`:94-111`).
  Directly relevant to the leaf/ordering contract in §3.
- `host-compaction-guest-sync.test.ts` (#9781): real guest `AgentSession` + `CollabGuestLink` + real
  host; asserts that the guest model context collapses behind the summary (`:1-12`, `:176-217`).
  Harness for "tail from compaction boundary gives the same agent messages as a full snapshot".
- `guest-subagent-badge.test.ts`, `guest-bus-mirror.test.ts`, `guest-ui-request.test.ts`:
  scripted fake host (`CollabSocket` with `role: "host"`) answering `hello` with hand-built
  `welcome` frames (`guest-subagent-badge.test.ts:122-140`). Best harness for guest-only
  assertions: hello fields, capability detection, `stale` handling, per-page timeout.
  `guest-ui-request.test.ts:521-567` covers proto handshake and fast-fail on host rejection.
- `guest-idle-reconciler.test.ts`: welcome/resync activity reconciliation (`:96-241`).
- `replication-shrink.test.ts`: shrink passes, typed placeholder, branch connectivity across an
  omitted entry (`:503-523`), train termination under an unshrinkable entry (`:626-661`), live
  placeholder notice (`:707-735`). This file owns the placeholder shape contract.
- `read-only.test.ts`, `controller.test.ts`: join/leave/ownership and view-link rules;
  `controller.test.ts:595-651` covers ownership through resync and host goodbye.
- Helpers (`test/collab/helpers/`):
  - `in-memory-relay.ts`: `FakeWebSocket`, `InMemoryRelay`, `installInMemoryRelay`,
    `uninstallInMemoryRelay` (`:23`, `:93`, `:144`, `:155`).
  - `throttled-host.ts`: `makeSnapshot`, `makeHostContext`, `instrumentRelay`, `waitFor`, and
    `HIGH_WATER_MARK` (`:15-129`), for backpressure and timeout tests.
  - `registry-host-process.ts`.
- Render side: `packages/coding-agent/test/modes/utils/render-initial-messages.test.ts` pins that
  display uses `buildTranscriptSessionContext({ collapseCompactedHistory: true })` (`:1-6`,
  `:239-242`). `packages/coding-agent/test/session-manager/build-context.test.ts:610-870` covers
  collapsed kept-region/turn-start semantics, which define the correct tail boundary.
- **Gaps:** no test drives `handleFollowUp` or the `=>` shorthand with `collabGuest` set (§2).
  No test covers reconnect-time snapshot stalls; timers are join-only (§1).

---

## 6. Insertion points and recommendation

| Concern | Insertion point |
|---|---|
| Wire grammar | `packages/wire/src/index.ts:324-340` (hello: optional `snapshot`/tail request + byte budget + resume id; new guest request frames next to `fetch-transcript` at `:340`); `:345-380` (welcome capability field; page/field reply frames and `stale`). Keep `COLLAB_PROTO` at 3 (`:397`). |
| Coding-agent frame types | `packages/coding-agent/src/collab/protocol.ts:54-96`. The welcome is redeclared at `:59-74`, so mirror the capability field there. |
| Tail opt-in (hello) | `guest.ts:300-305`. Add the optional tail request, the guest-chosen budget, and `resumeFrom` when `#welcomed` was reached before. |
| Capability detection | `#beginWelcome` (`guest.ts:407-419`): latch the host capability and the tail window (`snapshotStart`/`hasMore`/oldest cursor) into `PendingSnapshot` (`:78-86`). Promote to fields on `CollabGuestLink` in `#finalizeSnapshot` (`:444-513`). Old hosts omit the field, so the guest keeps full-snapshot semantics. The unknown-frame default at `guest.ts:612-613` already makes old guests ignore new host frames. |
| History fetch (request/response) | Mirror `readTranscript`: `#nextReqId` (`guest.ts:204`), a pending map like `#pendingTranscripts` (`:201`), a per-request timer (`:225-232`), the response case in `#applyFrame` (`:596-603`), and flushing on close/leave (`:349-352`, `:699-704`, `:820`). Accumulate page chunks privately per `reqId` until `final`, like `#accumulateSnapshotChunk` (`:427-441`). |
| Applying an older page | New method beside `#finalizeSnapshot`: rewrite the replica as `header + page + current #entries` so the leaf stays last (`session-manager.ts:440-449`), then `switchSession` + `renderInitialMessages({ clearTerminalHistory: true })` reusing `guest.ts:449-513`. Do not use `ingestReplicatedEntry` for older entries: it appends and moves the leaf (`session-manager.ts:1565-1566`, `:447`). Serialize on `#applyChain` (`guest.ts:167-168`). |
| Placeholder expansion | Same request pattern. Patch the target entry in the replica (header + entries rewrite) and replay. Trigger via a `/collab expand` verb in `builtin-collaboration.ts:305-333` (before the guest early-return at `:392`). The `collab` command is already guest-allowed (`guest.ts:54`). |
| Resume id | Track the newest held entry id: set it in `#finalizeSnapshot` and in the `entry` case (`guest.ts:549-566`); the SessionManager leaf is equivalent today (`session-manager.ts:447`). Send it from `onOpen` only when `joined` (`guest.ts:290-306`). On a "resumed" welcome, skip the file overwrite and `switchSession` (`guest.ts:449-459`). Instead `ingestReplicatedEntry` each delta entry, dropping ids already present because `#recordEntry` does not de-duplicate (`session-manager.ts:1560-1566`). Then `agent.replaceMessages(session.buildDisplaySessionContext().messages)` (precedent `guest.ts:563`) and run the rest of finalize (`:461-512`), including the destructive replay, because missed events will never render (`guest.ts:550`). On `stale`, fall back to the current full or tail path. |
| Per-page timeout | A new per-request timer (pattern `guest.ts:225-228`). Do **not** reuse `#armSnapshotProgressTimer`: it is join-only by design (`guest.ts:516`, `:532`). Consider arming a progress timer for resync/resume trains too, since reconnect stalls are uncovered today. |
| Tail boundary requirement for the host (TUI view) | The start must be at or before the turn containing `compaction.firstKeptEntryId` (`session-context.ts:543-571`), or the TUI loses the kept turns it shows today. A later `reset_boundary` supersedes it (`:446-465`). |
| Model-leak gating (independent fix) | Add `if (this.ctx.collabGuest)` handling in `handleFollowUp` (`input-controller.ts:1662`) and before the queue shorthand (`:971`). This keeps the claim in §2 true with no provider-replay fields on guests. |

### Recommendation: TUI guest opt-in in the same upstream PR?
**Keep the TUI guest on full snapshot in the upstream tail-first PR.** This is valid because
opt-in is per guest (`host.ts:663-664` ignores unknown hello fields; full snapshot is the
omitted-option default per #9469). Land TUI adoption as a follow-up. Reasons:

1. **The upstream issue targets the browser.** #9469 is titled and scoped for collab-web. The
   maintainer triage comment lists "whether tail mode is web-only or also supported by the CLI
   guest" as an open decision (issue comment 5385318681). Leaving the TUI out keeps the first PR
   reviewable and matches the issue.
2. **Low visible benefit, non-trivial TUI mechanics.** With the default
   `display.collapseCompacted=true`, the TUI already *displays* only the compaction tail
   (`settings-schema.ts:1245-1247`, `session-context.ts:466-596`). Tail mode would save
   bandwidth and time but change nothing on screen. Meanwhile "load earlier" and placeholder
   expansion in a terminal need replica-file prepend semantics, the leaf-order contract, a
   destructive scrollback replay, and new `/collab` verbs (§3). That deserves its own review.
3. **No new TUI code is needed for correctness in PR 1**, provided placeholders stay
   schema-compatible (string markers / text blocks / today's `custom_message`, §3). This
   applies equally to old TUI clients, which receive whatever shapes the new host emits.

Follow-up PR for the TUI, in order of value/risk:
- (a) **Resume id on reconnect.** No UX. Removes the full re-download on every relay blip
  (`guest.ts:290-306`). Needs the delta-ingest path in §6.
- (b) **Compaction-boundary tail** with no byte budget, plus `/collab history` for
  `/export`, `/dump` and `collapseCompacted=false` users.
- (c) `/collab expand` for placeholders and images.

If reviewers insist on CLI parity in PR 1, the smallest defensible slice is (a) plus sending
the tail request only when `display.collapseCompacted` is `true`. Separately, and regardless of
the tail work, the two ungated local-prompt paths in §2 should be fixed. They are the only way a
TUI guest could ever need `thinkingSignature`/`providerPayload`.
