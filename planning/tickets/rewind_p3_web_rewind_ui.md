# collab-web: message context menu for rewind and fork

Phase: 3
Depends on: rewind_p2_host_rewind_frame, rewind_p1_web_leaf
Written: 2026-09-30 at upstream 81c851de5f
Revalidated: pending

## Context
Design R9 to R13 and Q5, Q8, Q9. A writable guest can rewind the host session from the web UI or fork a separate named session from a prompt, including on a phone.

## Scope
In scope:
- client API `sendRewind`;
- per-prompt context menu for rewind and fork;
- rewind draft restoration;
- touch and keyboard interaction;
- compact-layout styling.

Out of scope:
- the sibling-branch strip;
- Esc interrupting a turn (Q5);
- non-prompt targets (R11);
- fork-file creation, launcher invocation and host/wire changes (Q9).

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
  - Only target prompts expose the actions; the menu is available only to guests who can rewind.
- **Menu.** Right-click opens the menu on desktop; long-press opens it on touch screens. It offers "Rewind to before this prompt" and "Fork new session from this point". There is no persistent Rewind button.
- **Rewind.** Available only when the host is idle and no `ui-request` or autocomplete is open. Esc-Esc remains an optional desktop shortcut for selecting a rewind target. Selecting rewind sends the entry id; on success, the selected prompt's draft replaces composer text and receives focus.
- **Fork.** Ask for a session name, then start `ompc --detach <name> --resume <new-session-file>`. The new process owns a distinct session file; the original process and file remain untouched. Once the extension registers it, the hub discovery flow adds it to the WebUI list for the user to select. Q9 must determine how OMP safely creates the selected-prompt copy; do not raw-truncate a live session file.
- A rewind shows a pending state until `rewind-result` arrives.
- If images came back and this build can't attach them, show a notice "N images from that prompt weren't restored".
- On error, show a notice without losing the selected target.
- The transcript itself is cut back by the `leaf` frame, not by the UI.
- **Windowing.** Rewind must work for a target outside the mounted tail window: the target list comes from `entries`, not mounted rows, and the row scrolls into view before selection.
- **Accessibility.** The context menu and its actions have accessible names and keyboard navigation; the optional keyboard shortcut remains available on desktop.

## Acceptance criteria and tests
- **`test/client.test.ts`:**
  - `sendRewind` resolves on a matching `rewind-result` and rejects on `error`;
  - pending requests reject on a new welcome;
  - there's no send without `welcome.rewind`.
- **`test/composer.test.tsx`:**
  - Esc-Esc in an empty composer remains a keyboard route to select a rewind target;
  - a single Esc, or Esc with text, does not start rewind.
- **`test/transcript.test.tsx`:**
  - right-clicking a target prompt opens the menu; a long-press opens the same menu on touch;
  - choosing rewind sends the expected entry id and a successful result restores the draft;
  - fork asks for a name, starts a separate process from a distinct session file, leaves the original session available, and adds the registered new session to the WebUI list;
- **Browser check** against a live fleet host through the dashboard (control mode):
  - desktop 1440x900: open a prompt's context menu and rewind; also check the Esc-Esc shortcut;
  - iPhone 13 viewport: long-press a prompt to open the menu, then rewind and check the draft;
  - screenshots in the phase report. Use a throwaway session; never put screenshots of real sessions in the repo.

## Workflow shape
Default. The implementer must read `skill://frontend-design` first, and match the existing collab-web look rather than add a new style.

## Open questions
Q3 (images), Q5 (Esc to interrupt), Q9 (safe selected-prompt fork and launcher).
