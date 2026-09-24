# claude-net reference review

Date: 2026-09-22
HEAD: ea1ccb0695
Reference: https://reference-host.your-tailnet.ts.net:4815/

## Direct browser observations

| Viewport | Observation |
|---|---|
| Desktop (1800x1200 rendered) | A compact top bar remains across the viewport. The 184px left Channels rail is an independent scrolling region; a message log occupies the remaining width. The rail contains grouped live-session rows and per-host Launch controls rather than pushing the main surface down. |
| Phone (390x844) | The default surface hides the session rail completely. The top bar retains an explicitly labelled hamburger, brand, agent count, and theme control; the message log remains full width. |
| Phone drawer open (390x844) | Hamburger opens an overlaid left drawer, roughly 80% width, with a Close control and a dimmed/blocked main region. Session rows remain scrollable in the drawer. This directly demonstrates the requested left-pane behaviour; it was screenshot-confirmed. |

The live reference was displaying its message-log page; no real selected session was available to exercise its prompt/control path. Therefore session-level interactions below are principles from its rendered structure, not claims of a completed live action.

## Transferable interaction principles

1. **Region transformation, not scaling:** desktop navigation is inline; compact navigation is an overlay. The primary active work surface never becomes a third of a stacked page.
2. **Persistent compact chrome:** global identity/connectivity stays visible, while density is reduced on phone rather than hidden arbitrarily.
3. **Session-local controls:** session state and actions live next to the active transcript/composer, not in a distant permanent inspector. Adapt this to Hub as the requested floating active-Collab bar.
4. **Explicit access and attention:** the interactive prompt is the destination after selecting a writable session; status/actions are visible while reading history.
5. **Touch-safe behaviour:** drawers have visible dismiss controls and must add backdrop/Escape/focus restoration; mobile should use safe-area-aware dimensions and protect terminal/composer space when the virtual keyboard appears.

## Non-goals

Do not clone claude-net’s visual design, routing, PWA model, mirrored transcript API, launch controls, or stop operation. Hub has a capability-URL iframe contract and must retain it.
