# Dashboard: don't reload the session when its own card is clicked

Phase: any (independent of the tail work)
Depends on: none
Written: 2026-09-23 at HEAD c046df93c5
Revalidated: pending
Revalidated: 2026-09-24 — executed. "Surface is live" is `state.selectedAccess !== null` (set only after a link opened; a failed open leaves it null, so clicking retries). Playwright: `dashboard.spec.ts` "clicking the open session's card keeps its Collab document" (fails with the guard removed) and "clicking a session whose room failed to open retries it". Deployed. Live check on hub-host not possible: the headless tab hangs while the 26.5 MB harness snapshot renders.

## Context
Found while measuring ([composition](../20260923_collab_snapshot_composition.md), item 5).
The card click handler always calls `selectSession()`. That function blanks the iframe and
reopens Collab, so clicking the session that's already open downloads the whole snapshot
again (26.5 MB for the harness). On mobile, tapping the current session in the drawer to
dismiss the drawer triggers this.

## Scope
In scope: the card click path.
Out of scope: the refresh path, which already guards the same room (`app.ts:319-327`).

## Files and anchors
- `hub/src/webui/app.ts:535-538`: `card.onclick = () => { selectSession(session); if (isCompactLayout()) closeDrawers(); }`.
- `hub/src/webui/app.ts:350-364`: `selectSession` blanks the frame at `:357`.
- `hub/src/webui/app.ts:319-327`: the existing "same room" rule to reuse. Clicking must compare the same key the refresh path compares.

## Design constraints
- If the clicked session is already selected **and** its surface is live (an iframe with a non-blank `src`, or an active `tailViewer`), only close the drawers.
- If it's selected but its surface failed or is blank, reselect as today: clicking again is the retry.

## Acceptance criteria and tests
- Playwright (`hub/tests/e2e/dashboard.spec.ts`): after the session opens, clicking its card again leaves the iframe `src` and the document unchanged. Check a `window` marker set inside the iframe before the click.
- At the compact viewport, the same click closes the drawer without a reload.
- A failed surface is still retried by clicking.

## Workflow shape
The main agent. Small change.

## Open questions
None.
