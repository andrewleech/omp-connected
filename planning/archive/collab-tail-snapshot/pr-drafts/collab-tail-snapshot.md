---
upstream_repo: can1357/oh-my-pi
upstream_base: main
local_branch: collab-tail-snapshot
status: open
title: "feat(collab): load the session snapshot tail-first"
pushed_branch: https://github.com/andrewleech/oh-my-pi/tree/collab-tail-snapshot
pr: https://github.com/can1357/oh-my-pi/pull/13389
head: abc0446c6
---

I use collab a lot from my phone over tailscale, and joining a long running session was painfully slow. The web guest downloads the whole session before it shows anything, which for one of my sessions is 23 MB. On mobile that's slow to arrive and eats into the data plan, every time the page is opened or reconnects.

With this change the web guest asks for just the latest turns and pages back through older history as you scroll up. That 23 MB session now joins with about 1 MB and is live in around half a second.

## How it works

- The guest asks for a tail in `hello` (`snapshot: { mode: "tail", maxBytes }`) and the host sends as many whole turns from the end of the active branch as fit in `maxBytes`, always at least one.
- Older pages come from `fetch-history`, using entry ids as cursors. If compaction or a branch move takes the cursor off the active branch the host answers `stale` and the guest re-joins for a fresh tail.
- Anything the host trims for size (images, clipped tool output, entries over the 1 MiB ceiling) carries a `collabElided` record, and the guest fetches the original with `fetch-value` when you tap it.

There's no `COLLAB_PROTO` bump. The additions are optional fields and new frames, and the host only sends `welcome.history` when it honoured a tail request, so old guests and old hosts get the full snapshot as they do now. The TUI guest doesn't opt in yet.

This sits on top of the recent collab-web work from igasmi and can1357 (render window, snapshot buffering and progress banner), which I've kept as is. "show N earlier" mounts rows the browser already holds before asking the host for more. The window now pins by entry id rather than index, since prepending a page shifts the indexes.

It also includes a host fix: if a guest says hello again while its previous snapshot train is still queued, the old train is dropped rather than draining ahead of the new welcome.

Fixes #9469. Refs #9328, #11859.

## On the open questions in #9469

- Web guest only for now. The TUI keeps the full snapshot and renders placeholders as it does today.
- The guest picks the size (collab-web asks for 1 MiB for the tail and each page), the host has no limit of its own. Existing frame chunking and the per-entry shrink still apply.
- Pages start on `isTurnStartEntry` boundaries from compaction.
- Earlier history loads from a scroll sentinel near the top, or a "load earlier messages" button.
- On reconnect, pending requests fail and the guest reloads the tail, keeping your position if the top row is still there.

Trade-offs: a tail guest only follows the active branch, so abandoned branches from before the tail aren't shown. The host also doesn't clamp `maxBytes`, so a guest can ask for everything in one page, which costs the same as today's full snapshot.

## Testing

Browser guest through my own hub over the relay:

- 23 MB (~5,500 entry) session: live in 0.54-0.60 s over 3 runs, 1,045,308 bytes in 5 frames. From a stock host it's a 23.3 MB train and the stock guest still hadn't settled after 29 s.
- Paging back to the first turn: 1194 rows, no duplicates or gaps, and the row I was reading moved by at most 1 px as each page landed.
- A trimmed 2.7 MB screenshot loads in 0.3-0.5 s.
- The new web guest against a stock 18.2.9 host gets the full snapshot and shows none of the new controls.

The TUI guest is only covered by the existing tests. `bun run check:ts` passes, and the collab tests pass (271 in coding-agent, 123 in collab-web).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
