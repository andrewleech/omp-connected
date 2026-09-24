# Host: make every trimmed value a loadable placeholder, and serve fetch-value

Phase: 1 (tail snapshot)
Depends on: tail_p1_wire_contract
Written: 2026-09-23 at HEAD c046df93c5 (upstream fd3f8e3c56)
Revalidated: pending phase entry
Revalidated: 2026-09-24 at fork base a1b3b83a7f — executed as fork 319cf55c9 (shrinker/images by a subagent, fetch-value by main). Deviations: new module collab/replication-images.ts instead of a variant in session/messages.ts; image-only arrays (`bashExecution.images`, `details.images`) drop the image with `removed: true` on its record, because TUI renderers draw every element there as an image (wire `CollabElided.removed`); over-ceiling entries placehold images before clipping so base64 is never clipped as a string; fetch-value serves wire entry types only (a view-link guest could otherwise read `session_init`).

## Context
Decision T2 (user): nothing is lost, only deferred. Today content is lost in three places
([host survey](../20260923_upstream_collab_host_survey.md) §6):
- the clipped-string and clipped-array markers carry no metadata;
- the whole-entry placeholder keeps its type and size only in prose;
- image stripping filters blocks out, which shifts indices.

## Scope
In scope:
- `collabElided` metadata produced by `shrinkReplicatedEntry`;
- in-place image placeholders;
- the `fetch-value` handler with a hash check.

This applies to both full and tail modes: old guests ignore the extra field, and keeping
indices stable helps everyone.

Out of scope: the guest UI (phase 2); live-event shrinking (`shrinkReplicatedEvent`), because events have no identity to fetch from.

## Files and anchors
- `replication-shrink.ts`:
  - `shrinkWalk` `:174-273`: record `{path, kind, bytes, hash}` whenever `clipString` (`:143-152`) or array clipping (`:193-198`) fires. Paths are relative to the entry root;
  - `shrinkPayloadShape` `:300-317`: return the collected list;
  - `shrinkReplicatedEntry` `:348-361`: attach `collabElided`. For the whole-entry placeholder use `[{path:[], kind:"entry", ...}]` and add `details: { omittedType, bytes }`.
  - This keeps the ≤ 1 MiB ceiling guarantee: the metadata is small, but measure after attaching it and cap the list length (e.g. 64 entries, then a single entry-level record).
- Image stripping, `session/messages.ts:666-763` (`stripImagesFromMessage` and its helpers):
  - add a collab-only variant that replaces each image block **in place** with `{type:"text", text:"[image <mime>, <size> not sent]"}` and records `{path, kind:"image", mimeType, bytes, hash}`;
  - cover `details.images` (`:724-749`), `bashExecution.images` (`:706-710`) and `fileMention.files[i].image` (`:750-758`);
  - `host.ts:742-748` calls the variant. Don't change `stripImagesFromMessage` itself: other callers need the filtering behaviour.
  - Also cover `custom_message` images. Today they are skipped (`host.ts:745`).
- `fetch-value` handler in `host.ts` next to `fetch-transcript` (`:677-680`, pattern `:1092-1133`):
  - `getEntry(entryId)` (`session-manager.ts:3037`);
  - walk `path`, `JSON.stringify` the value, and compare its `Bun.hash` with the `hash` the guest echoes in the request (copied from `collabElided`);
  - reply with at most 512 KiB of `data` from `offset`, plus `total` and `final`;
  - a missing entry or path, or a hash mismatch, gets `error: "stale"`;
  - use one lazy `sendBatch` per request, not eager `send()`.

## Design constraints
- The visible placeholder types stay the same (string, text block, `custom_message`), so old and TUI guests render them unchanged (T5).
- The live `entry` path (`host.ts:445-456`) uses the same shrinker, so it gains metadata automatically. Check that `oversizedEntryNotice` (`replication-shrink.ts:363-377`) still fires.
- Hash with `Bun.hash` over the JSON of the **original** value, captured before clipping.

## Acceptance criteria and tests
Extend `test/collab/replication-shrink.test.ts`, which owns the placeholder contract, plus
the new tail test file:
1. Clipped string: `collabElided` has the path, and `fetch-value` pages reassemble exactly the original string.
2. Clipped array, and a whole-entry placeholder: the same round-trip.
3. Images: the stripped copy keeps its array length with a text block at the original index. Fetching the image reproduces the original `data`. `details.images`, `bashExecution` and `fileMention` are covered.
4. The host mutates the entry in place after the snapshot (simulate `session-maintenance.ts:639` pruning): `fetch-value` gets `stale`.
5. A 5 MB image under throttling: ranged reassembly, and the room survives.
6. Existing tests stay green: branch continuity across an omitted entry (`:503`), and train termination (`:626-661`).
7. Full-mode snapshot of the phase 0 test session: no image is silently dropped. Every stripped image has a placeholder.

## Workflow shape
Implementer on sonnet, tests on haiku, standard and adversarial review on opus, looped.
Runs in parallel with tail_p1_host_tail_history; shares `host.ts` with it (that ticket's
agent owns merges).

## Open questions
None.
