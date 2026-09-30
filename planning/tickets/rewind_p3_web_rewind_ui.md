# collab-web: rewind mode (desktop esc-esc, mobile Rewind button)

Phase: 3
Depends on: rewind_p2_host_rewind_frame, rewind_p1_web_leaf
Written: 2026-09-30 at upstream 81c851de5f
Revalidated: pending

## Context
Design R9 to R11 and Q5. This is the user-visible feature: go back to an earlier prompt from the web UI, including on a phone, and get that prompt back in the composer to edit and resend.

## Scope
In scope:
- client API `sendRewind`;
- rewind-mode state;
- transcript row marking;
- composer esc-esc and the Rewind button;
- draft restore;
- styles for desktop and compact layouts.

Out of scope:
- the sibling-branch strip;
- Esc interrupting a turn (Q5);
- non-prompt targets (R11).

## Files and anchors
- `src/lib/client.ts`:
  - frame handling `:302-440`;
  - `sendPrompt`/`sendAbort`, which the new sender sits beside;
  - the snapshot shape at `:553` (add `canRewind` from `welcome.rewind` and `readOnly`).
- `src/components/shell/Composer.tsx`:
  - `:128-140` `send`/`onKeyDown` (textarea keydown, IME-aware via `composingRef`);
  - `:142-196` `ui-request` form mode (no rewind while it's open);
  - `:198-247` actions row (Stop, Send).
- `src/components/transcript/Transcript.tsx`:
  - `:187-200` `EntryRow`, where user rows render `Row kind="user"` and collab prompts are custom-message rows;
  - `:265-282` tail `WINDOW` (a target above the window must scroll into view and mount);
  - `:36-44` tail lock.
- `src/components/shell/shell.css`: composer and compact styles.
- Concurrent edits in the same files:
  - guest-commands (slash autocomplete in `Composer.tsx`, which closes on Escape, `CommandUi.tsx`);
  - collab-web-image-attach (composer attachments).

## Design constraints
- **Client.**
  - `sendRewind(entryId): Promise<{ draft?: string; images?: ImageContent[] }>` rejects with the host's `error`.
  - `reqId`s are local. Pending requests reject on disconnect or a new welcome.
  - Never send without `welcome.rewind`.
- **Targets** (R11): published entries that are user requests, meaning `message` with role `user`, or `custom_message` whose message is a user-turn initiator (collab guest prompts, user-invoked skill prompts).
  - collab-web depends only on `pi-utils` and `pi-wire` (not `pi-tui`, where `isUserRequestEntry` lives), so port the predicate with a test that pins it to the same cases. If the maintainer prefers, move it into `pi-wire` for both sides instead.
  - The rewind UI shows only when at least one target exists.
- **Entering rewind mode.** It's allowed only when all of these hold: the guest can rewind, the host is idle, no `ui-request` is open, and no autocomplete is open.
  - Desktop: Escape twice within 500 ms in an empty composer textarea, ignored while IME composing. Escape with text in the composer keeps today's behaviour (nothing), like the TUI.
  - Everywhere: a Rewind button in the composer actions (icon plus label, with the label hidden in compact layout like the others). On a phone this is the only entry point. The button is disabled with a tooltip while busy.
- **In rewind mode.**
  - A banner replaces the composer input: "Pick a prompt to go back to" with Cancel.
  - Targets get a visible affordance on the row, and every other row is dimmed. The latest target is preselected and scrolled into view.
  - Keys: Up and Down move between targets, Enter picks, Escape cancels.
  - A tap or click on a target picks it. There is no confirmation step, because nothing is lost and the TUI doesn't confirm either.
  - Mode exits on a pick, on Cancel, if the host starts streaming, or if the connection drops.
- **After a pick.**
  - Show a pending state on the banner until `rewind-result` arrives.
  - On success, put `draft` in the composer, replacing its text (the TUI rule for user targets), and focus it.
  - If images came back and this build can't attach them, show a notice "N images from that prompt weren't restored".
  - On error, show a notice and stay in rewind mode.
  - The transcript itself is cut back by the `leaf` frame, not by the UI.
- **Windowing.** Picking a target outside the mounted tail window must work: the target list comes from `entries`, not from mounted rows. Scroll into view with the tail lock released.
- **Accessibility.** Targets are buttons with an accessible name ("Rewind to: <first line of prompt>"), and the banner is a live region.

## Acceptance criteria and tests
- **`test/client.test.ts`:**
  - `sendRewind` resolves on a matching `rewind-result` and rejects on `error`;
  - pending requests reject on a new welcome;
  - there's no send without `welcome.rewind`.
- **`test/composer.test.tsx`:**
  - esc-esc in an empty composer enters rewind mode;
  - a single Esc, or Esc with text, does not;
  - the Rewind button is hidden without the capability, hidden for read-only, disabled while busy;
  - a pick sends the frame, and the draft lands in the composer;
  - an error keeps the mode.
- **`test/transcript.test.tsx`:**
  - in rewind mode only prompt rows are selectable;
  - Up, Down and Enter pick the expected entry id.
- **Browser check** against a live fleet host through the dashboard (control mode):
  - desktop 1440x900: esc-esc, arrows, Enter;
  - iPhone 13 viewport: Rewind button, tap a prompt, draft in composer;
  - screenshots in the phase report. Use a throwaway session; never put screenshots of real sessions in the repo.

## Workflow shape
Default. The implementer must read `skill://frontend-design` first, and match the existing collab-web look rather than add a new style.

## Open questions
Q3 (images), Q5 (Esc to interrupt).
