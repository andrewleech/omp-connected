# Fixture: a representative Collab test session with images

Phase: 0 (tail snapshot)
Depends on: tail_p0_fork_setup
Written: 2026-09-23 at HEAD c046df93c5 (upstream fd3f8e3c56)
Revalidated: pending phase entry
Revalidated: 2026-09-23 at fork base a1b3b83a7f — executed (fork 6220ba78c); see ../20260923_tail_snapshot_phase0.md. Corrections: whole-entry placeholder needs key-heavy size, not a long string; persistence caps strings at 500k chars.

## Context
The harness session has no images, 18 compactions, and 0.2 MB on abandoned branches
([composition](../20260923_collab_snapshot_composition.md)). T2 requires images to be
viewable, so phase 1–3 tests need a session that exercises every placeholder kind.

## Scope
In scope:
- a script in the fork's test helpers that builds a `SessionManager.inMemory()` session;
- the same session saved as a JSONL file for manual runs;
- baseline measurements.

Out of scope: tests of product behaviour.

## Files and anchors
- Session APIs:
  - `appendMessage` (`session-manager.ts:2731-2748` at the pin);
  - `appendCompaction(summary, shortSummary, firstKeptEntryId, tokensBefore)` (`:2865-2895`);
  - `branch(id)` (`:3113-3120`);
  - `appendMessageToBranch` (`:2754-2776`).
- Test helper pattern: `test/collab/helpers/throttled-host.ts:22-39` (`makeSnapshot`).
- Image block shape: `{type:"image", data, mimeType}` (`packages/wire/src/index.ts:23-29`). Images are allowed in user, toolResult and custom_message content.

## Design constraints
The session must contain at least:
- 200 turns;
- two compactions, where the last one's `firstKeptEntryId` falls mid-turn;
- one abandoned branch;
- a user image (~300 KB) and a tool-result image (~2 MB);
- a `details.images` entry;
- a single tool result whose size is in object keys (> 1 MiB), which the shrinker must turn into a whole-entry placeholder (a long string is only clipped);
- a tool result over 1 MiB made of strings over 64 KiB but under the 500,000-char persistence cap, which gets clipped;
- a bash turn larger than 1 MiB, to exercise the at-least-one-turn rule;
- a total over 24 MiB, so today's host strips the images.

The data must be deterministic: seeded, with no wall-clock values in content.

## Acceptance criteria and tests
- The helper is exported for use by phase 1 tests.
- The JSONL file opens with `omp --resume`, launched from the fork.
- Today's full-snapshot bytes and entry count are recorded, and so is the fact that the stock host strips its images (the log line from `host.ts:742-748`).

## Workflow shape
Part of the phase 0 implementer's work.

## Open questions
None.
