# Upstream issue: guests go stale on host rewind; let guests rewind

Phase: 0
Depends on: rewind_p0_repro (the issue quotes its results)
Written: 2026-09-30 at upstream 81c851de5f
Revalidated: pending

## Context
There is no upstream issue for this. A search on 2026-09-30 for "collab rewind", "collab navigateTree", "collab tree guest" and "collab branch guest stale" found nothing relevant. CONTRIBUTING.md asks for an issue or Discord discussion before multi-package changes, and this touches coding-agent, wire and collab-web.

## Scope
Draft the issue text and save it to `planning/pr-drafts/collab-rewind-issue.md`. Opening it needs the user's explicit approval of the final text; never open it without that.

## Content the issue must cover
- **Title**, roughly: "collab: guests don't follow host tree navigation, and can't rewind".
- **Bug.** After esc-esc (or `/tree`, or turn recovery dropping a failed turn) on the host, guests keep showing the abandoned turns. Include the repro steps and what collab-web and the TUI guest showed, from `rewind_p0_repro`.
- **Cause, briefly.**
  - Leaf moves append no entry, so the host sends nothing.
  - collab-web renders entries in arrival order and never reads `parentId`.
  - The full join snapshot ships every branch in file order.
- **Related bug (B3).** Replicated `parentId`s can point at entries the host doesn't replicate, which cuts the guest's branch walk short. Include the numbers from the probe.
- **Proposed fix, part 1.**
  - A `leaf` frame, plus `leafId` in `welcome`.
  - Replicated parent links rewritten to the nearest replicated ancestor.
  - Guests show the walk from the leaf.
  - Mention the `SessionManager` leaf-change hook.
- **Proposed feature, part 2.**
  - A `rewind` guest frame with a `rewind-result` reply, needing the write token and refused while streaming.
  - The host runs the same code as its own esc-esc, and the draft goes back to the requesting guest only.
  - collab-web gets a per-prompt context menu on desktop and a long-press menu on touch screens, with "Rewind to before this prompt" and "Fork new session from this point". Esc-Esc remains an optional desktop rewind shortcut; there is no persistent Rewind button.
  - Fork-session storage, ownership and host operation need a maintainer-aligned design decision before implementation (Q8).
- **Question for the maintainer (design Q2).** A welcome flag vs a capability list vs a `COLLAB_PROTO` bump. Note that #10462 proposed `capabilities` with proto 4, and that the guest-commands work (if it's upstream by then) extends proto 3 without a bump.
- **Relation to #13389.** The two are independent, but tail-joined guests rejoin when the new leaf is outside their window.
- **Offer to do the work**, as two PRs.

## Design constraints
- Write it in the user's voice with the `writing-style` skill:
  - Australian English;
  - no emdashes, emoji or filler;
  - short paragraphs;
  - code anchors as `path:line` at the current upstream sha.
- Keep it factual and conservative, with no adjectives such as "comprehensive". Don't list files changed.

## Acceptance criteria
- The draft is saved, and the user has approved it or asked for changes.
- If approved, the user or the main agent (with approval) opens it. The issue number is then recorded in the design doc, and the PR drafts link it.

## Workflow shape
Main agent only.

## Open questions
Q7 in the design (Discord post) is the user's call.
