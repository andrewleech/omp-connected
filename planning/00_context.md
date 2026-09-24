# WebUI responsiveness and control planning

Date: 2026-09-22
HEAD: ea1ccb0695

## Goal
Make the OMP Hub WebUI usable on mobile and desktop while preserving direct interactive Collab control: selecting a session must open a ready-to-type control connection by default. Restore a compact, persistent session-status/control surface for active Collab state.

## Working design rules
- The reference application at `https://reference-host.your-tailnet.ts.net:4815/` is interaction/layout precedent, not an API or visual-copy requirement.
- Desktop uses a three-region workspace: session navigation, active terminal/prompt surface, and contextual collaboration/details.
- On compact screens, left and right regions are independently dismissible drawers with explicit controls and touch swipes; the active terminal remains the primary full-width surface.
- Choosing a session requests `access: "control"` by default. View-only remains an intentional, visible alternative, never a surprising default.
- Restore active-session metadata and controls as a compact overlay/status bar in the active Collab surface, without consuming terminal rows persistently.
- Preserve capability-URL security: relay URLs remain fragment-only and are freshly minted per browser guest.

## Planning document map
Read [00_index.md](00_index.md), then the dated audits, [the native-status-bar decision](20260922_status_bar_telemetry_decision.md), [the browser-test decision](20260922_browser_test_architecture.md), [the roadmap](20260922_webui_roadmap.md), and phase tickets. Settled decisions D1–D7 and dated Q1–Q2 decisions are recorded in the roadmap.

## Second track: Collab tail-first snapshot
Goal: joining a large session sends only its recent history, with older history and
trimmed content loaded on demand. This is implemented in the fork
`andrewleech/oh-my-pi` (branch `collab-tail-snapshot`) and contributed upstream as #9469.
Rules:
- Collab stays unpatched in this repo; the submodule tracks the fork branch until upstream merges it.
- The guest owns the byte budget.
- No content is lost; trimmed content is loaded on demand.
See the [design](20260923_collab_tail_snapshot_design.md) and the [roadmap](20260923_collab_tail_snapshot_roadmap.md).
