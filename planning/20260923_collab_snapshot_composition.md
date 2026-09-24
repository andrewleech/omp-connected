# Collab snapshot composition — harness session (2026-09-23)

Date: 2026-09-23
HEAD: c046df9

Evidence for the tail-first snapshot work (upstream #9469; related #9328, #11859).

## Method
- Session file: `~/.omp/agent/sessions/-harness/2026-09-16T20-22-43-843Z_01a0abe2-….jsonl`
  (omp 18.2.9, host pid 10269).
- Host sends every stored entry whose type is in `WIRE_SESSION_ENTRY_TYPES`
  (`host.ts:99-106`); `snapshotForReplication` copies all `#entries`, not just
  the active branch (`session-manager.ts:2751-2756`).
- Sizes are compact-JSON bytes per entry; wire check via CDP on the relay socket
  (binary frames; CDP reports base64, so divide by 4/3).

## Totals
| Measure | Value |
|---|---|
| File | 27.6 MB, 8537 entries |
| Wire-eligible entries | 5555, 26.4 MB |
| Observed on relay socket | 54 frames, 26.5 MB, ~5.7 s |
| Off active path (abandoned branches) | 0.2 MB |
| Images | 0 |
| Compactions on path | 18 |
| After last compaction's kept point | 0.1 MB |

The earlier "~100 MB" figure was a measurement error (base64 CDP payloads plus a
second socket).

## Tail curve (newest first)
| Bytes | Entries | User turns |
|---|---|---|
| 0.5 MB | 119 | 5 |
| 1 MB | 358 | 26 |
| 2 MB | 722 | 46 |
| 5 MB | 1683 | 65 |
| whole | 5490 | 127 |

`last 150 entries` = 0.6 MB.

## Where the bytes are
| Field | MB | Share | Read by collab-web? |
|---|---|---|---|
| `toolResult.details` | 10.0 | 38% | partly (below) |
| `toolResult.content[text]` | 5.9 | 22% | yes |
| `assistant thinkingSignature` | 2.5 | 9% | no |
| `assistant.providerPayload` | 1.7 | 6% | no |
| `toolCall.arguments` | 1.4 | 5% | yes |
| thinking text | 0.8 | 3% | yes |

Inside `details`:
- `read`: `displayContent` 3.1 MB, `truncation` 0.9 MB. Web reads only
  `conflictCount` and whether `truncation` is present (`read.tsx:25-26`).
- `edit`: `oldText` 1.6 MB and `newText` 1.5 MB are unused; web renders
  `details.diff` (0.5 MB, `edit.tsx:107`).
- `grep`: `displayContent` 0.6 MB, unused (only `ast-edit.tsx` reads it).

Fields the web guest never reads: ~11.9 MB (45%). The TUI guest reuses omp
renderers and may read more of them — unverified.

## Size distribution
- Largest entry 0.2 MB; top 10 = 4%, top 100 = 19%.
- 17 entries > 64 KB, totalling 1.6 MB; none reach the 1 MB shrink ceiling.

## Implications for the design
1. Tail-first paging is the dominant win: a 1 MB tail is 26 of 127 turns,
   ~26× smaller.
2. The last compaction is a natural tail boundary (0.1 MB here); page older
   history on demand.
3. A guest-declared field profile (drop signatures, provider payloads, unused
   `details`) roughly halves any page. Worth a second PR, independent of paging.
4. Lazy-loading oversized entries buys little *bandwidth* for this session
   (1.6 MB total), but it is required for completeness — see T2.
5. Dashboard: re-clicking the already-selected session reloads the iframe and
   the whole snapshot (`app.ts:535-536` → `selectSession`).

## Decisions (2026-09-23, user)
These are T1 and T2 in [the design](20260923_collab_tail_snapshot_design.md).
- **T1 — Budget belongs to the guest, not the host.** The host imposes no
  fixed byte cap on a page. The guest may send a budget (the web UI will);
  the host fills it with whole turns, always at least one. A guest that sends
  no budget gets everything, as today. Frame chunking stays: it is transport
  sizing, not a content limit.
- **T2 — No content is lost, only deferred.** Images and large tool output
  must be viewable in full. Anything the host trims to fit a page is sent as
  a placeholder carrying its entry id, field path and full size; the guest
  shows it with a "tap to load" control that fetches the full value. This is
  in scope for the fork, in the same PR as paging.
- Consequence: with tail-first pages the snapshot stays well under the host's
  existing 24 MB `WELCOME_IMAGE_STRIP_THRESHOLD` (`host.ts:79`, `:747-752`),
  so images are no longer stripped. The existing 1 MB per-entry shrink
  (`MAX_REPLICATED_PAYLOAD_BYTES`, `replication-shrink.ts:55`) and its
  "too large" placeholder become T2 placeholders that can be loaded in full.
