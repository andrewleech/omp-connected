# collab-web: tap to load full content (entries, images, clipped output)

Phase: 2 (tail snapshot)
Depends on: tail_p2_web_tail_history (client request plumbing, entry swap)
Written: 2026-09-23 at HEAD c046df93c5 (upstream fd3f8e3c56)
Revalidated: pending phase entry
Revalidated: 2026-09-24 at fork 319cf55c9 — anchors moved: `MsgContent` Transcript.tsx:81, `AssistantBody` :106, results map :267, collab-prompt :210; tool-render lives at `src/tool-render/` (types.ts:42, parts.tsx Output :106, ResultImages :195, util.ts resultImagesOf :159). New: records with `removed: true` (image-only arrays) are restored by insertion at the original index, ascending; others replace in place. `value` errors: "stale" | "busy" | "malformed fetch-value" | "join before fetching values".
Revalidated: 2026-09-24 — executed as fork b78c5f483. Deviations: one card-level "load full output" control in ToolView instead of per-`Output` controls (Output only sees joined text; 30 renderers use it); `ToolRenderHostContext` lets `ResultImages` reach `loadFull` without touching ~40 renderer call sites; `loadFull` only exists after `welcome.history` (T4). Live: image 0.39 s, clipped output 0.44 s, whole entry 0.30 s; a real GuestClient patched all six fixture entries byte-identical to the originals. Not visible in collab-web: `details.images` (eval renderer doesn't show it) and `bashExecution` rows (not rendered), so removed-insertion is unit-tested only.

## Context
Decision T2 (user): images and large output must be viewable in full. The host sends
`collabElided` metadata and serves `fetch-value` (tail_p1_host_lossless). Evidence:
[web survey](../20260923_upstream_collab_web_survey.md) §4.

## Scope
In scope:
- `fetchValue` in the client with ranged reassembly;
- patching the entry by id;
- load controls for whole-entry placeholders, image placeholders, and clipped strings in message text and tool output.

Out of scope: the TUI (`/collab expand` is a follow-up).

## Files and anchors
- `client.ts`:
  - `fetchValue(entryId, path, hash)` loops over `offset` until `final`, using the same pending-request and timer pattern as `fetchHistory`;
  - `loadFull(entryId, elided)`:
    - sets the value at `path` in a structural copy of the entry, replacing the placeholder text block, clipped string or whole entry;
    - removes that item from `collabElided`;
    - swaps the entry into `#entries` by id and commits.
- `Transcript.tsx`:
  - whole-entry placeholder: a branch next to the `collab-prompt` case (`:210`) for `customType === COLLAB_ENTRY_OMITTED_CUSTOM_TYPE` (imported from wire after tail_p1_wire_contract), showing a "Load full entry (N MB)" button;
  - images in `MsgContent` (`:89-97`): render a "Tap to load image (mime, size)" tile for an image record at that path;
  - clipped text: a "Load full (N KB)" link after the elision marker.
- Tool output:
  - add an optional `loadFull?(entryId, elided)` to `ToolRenderHost` (`tool-render/types.ts:42-47`), provided by `toolHost` in `app.tsx:132-140`;
  - `Output` (`tool-render/parts.tsx:106-132`) has an expand button at `:125-129`, the natural slot for the load control;
  - `ResultImages` (`parts.tsx:195-213`) and `resultImagesOf` (`util.ts:159-169`) must keep placeholder tiles instead of dropping them;
  - the `results` map (`Transcript.tsx:267-275`) must carry the tool-result entry id, which `AssistantBody` (`:128-144`) forwards to `ToolCard` (`ToolCard.tsx:7-16`).
- Run `bun run gen:tool-views` after the `tool-render/` changes (`DEVELOPMENT.md:25-27`). HTML exports don't provide `loadFull`, so they show no control.

## Design constraints
- Placeholders must be readable without JS support: the visible text stays as it is.
- `stale` shows "content changed on the host; reload the session".
- Don't cache full values outside the entries array.

## Acceptance criteria and tests
- Unit tests:
  - reassembly across 3 frames;
  - patching at each path kind (whole entry; `message.content[i]`; `message.details.images[j]`; a nested string);
  - a `stale` reply surfaces as a notice;
  - a renderer without `loadFull` shows no control.
- A component test: clicking the image tile renders `<img>` with the original data.
- Manual, on the phase 0 session: every placeholder kind loads and matches the original. Screenshots on desktop and mobile.

## Workflow shape
Implementer on sonnet, tests on haiku, standard and adversarial review on opus, looped.

## Open questions
None.
