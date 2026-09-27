# Tail snapshot: phase 1 (host and wire) result

Date: 2026-09-24
HEAD: c046df93c5 (omp-connected); fork `collab-tail-snapshot` at b87090670 (local, not pushed)

## Commits (on upstream main a1b3b83a7f)
| Commit | Content |
|---|---|
| 6220ba78c | test fixture session (phase 0) |
| 4197ae90e | wire: `hello.snapshot`, `welcome.history`, `fetch-history`/`history`, `fetch-value`/`value`, `CollabElided`, `COLLAB_ENTRY_OMITTED_CUSTOM_TYPE` moved to wire; type-level conformance file `test/collab/web-wire.types.ts` |
| 0cbd77574 | host: turn-aligned tail, `fetch-history`, per-peer cap of 16 queued fetches, re-hello `dropPeer` |
| 319cf55c9 | host: `collabElided` on every trim, image placeholders (`collab/replication-images.ts`), `fetch-value` |
| b87090670 | host: `fetch-history` only after a tail join (adversarial review finding) |

## Verification
- `bun test test/collab/` (coding-agent): 268 pass, 0 fail (baseline 229). collab-web: 98 pass.
- `tsgo --noEmit` clean in coding-agent and wire; oxfmt and oxlint clean.
- Mutation checks, each caught by a test: re-hello `dropPeer` removed; at-least-one-turn guard removed; `fetch-value` hash check removed; wire-type filter removed; tail gate removed; conformance key-set check (one-sided optional field).

## Reviews
- Standard review (opus): no findings; verdict correct, confidence 0.92.
- Adversarial review (opus), two findings:
  1. **Fixed** (b87090670): `fetch-history` was accepted from peers that never got `welcome.history`.
  2. **Not changed, by decision:** a `fetch-history` with no `maxBytes` copies and stringifies the branch prefix synchronously (~125 ms per request on a 34 MB session). A plain `hello` already costs the same per frame (full copy and stringify), so this adds no amplification over stock hosts; clamping the budget would break T1 (the host has no budget of its own). The 16-slot cap bounds queued work, not synchronous work. Worth mentioning in the PR as pre-existing.

## Contract changes made during phase 1 (design doc updated)
- `CollabElided.removed` for image-only arrays (TUI renders every element of `bashExecution.images` and `details.images` as an image).
- `fetch-value` serves wire entry types only.
- Over-ceiling entries have images placeheld before strings are clipped.
- Error strings guests may see: history: `stale`, `busy`, `malformed fetch-history`, `join before fetching history`, `history is only available after a tail join`; value: `stale`, `busy`, `malformed fetch-value`, `join before fetching values`.
