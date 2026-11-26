# Collab browser: add side requests to the send menu

Sprint: [Collab side requests](../20261124_collab_side_request_sprint.md)
Depends on: [child execution](side_request_1_snapshot_child.md), [protocol](side_request_2_protocol.md)
Written: 2026-11-24 at planning HEAD 0a7549cd98; prototype base f2b795ba74

## Context and scope

A full-control guest needs to launch a side task through the existing hold-Send menu and then use the actual Collab subagent UI to inspect and continue the child. Revalidate planning HEAD, fork base and uncommitted worktree, the active integration and anchors before work; append a dated `Revalidated:` entry. Identify which browser source is actually served by the integration. Inspect its existing hold-Send send-when choices and interaction semantics first: the prototype's new menu is not evidence that the active integration has the same menu. The prototype is unaccepted reference, including generated file noise.

## Fork reference anchors

Relative to the local `collab-side-request-fork` worktree:

- `packages/collab-web/src/components/shell/Composer.tsx:176-182,234-254,318-363`: prototype side-request submit, pending-question alternative and menu. These are not a prescription to replace the integration's existing menu.
- `packages/collab-web/src/lib/client.ts:224-229,371-372`: negotiated sender and host capability.
- `packages/coding-agent/src/collab/host.ts:1010-1018`: host dispatch and errors. Trace the current hub/subagent lifecycle, transcript and chat commands in the integration before implementing.
- `packages/collab-web/test/composer.test.tsx:64-89`: prototype test covers read-only controls, not side-request rendering and submission.

## Design and acceptance

- Extend the existing long-press Send send-when choices with Side request. Keep all current choices, default Send, keyboard/IME behavior, mouse/touch and accessibility intact. If the active integration has drifted, adapt to its actual composer, not the prototype. Offer the action only when connected, writable and the host advertises support; explain unavailability where existing UX does so.
- Submit the intended text and supported images through the negotiated protocol without steering or interrupting the parent. Keep or restore the draft and attachments on a rejected request, child-start failure or disconnect, without overwriting a newer draft; show a useful error. Clear only after the protocol reports successful startup. Cover concurrent submissions and new welcome/reset.
- Exercise the actual Collab subagent panel or equivalent, not merely the host registry: the new child becomes discoverable with an identifiable label, shows progress and output, and accepts a follow-up that reaches the same child. Preserve normal read-only restrictions. If the existing interface cannot support this, extend it minimally. Explain that parent and child share the workspace and can make conflicting edits; do not claim isolation.
- Preserve usable behavior when a host UI question is pending: side requests must not answer or discard that question, and the controls must not lose an existing draft. Do not create a second standalone menu if the existing menu can serve the action.
- Add component/client tests for existing and new modes, long press, keyboard access, capability and read-only states, image handling, pending question, errors, draft preservation and actual child discovery/output/follow-up. Update the existing Collab user documentation to describe the flow, authorization and shared workspace. No deployment.

## Workflow and evidence

Use the index execution model and relevant frontend guidance at implementation. The local browser smoke and actual provider reporting are owned by [integrated verification](side_request_4_verification.md). Do not impose provider-boundary snapshots, byte-identical requests or guaranteed cache hits.

## Revalidated: 2026-11-26

Checked at planning HEAD `903d96f`.

- Fork: upstream/main is now `d9a63f498b` (v19.2.x), 5868 commits past the prototype base `f2b795ba74`. Collab host, protocol, wire, web guest, session and task paths all changed, so the prototype diff is reference only. Work goes on a fresh branch `collab-side-request` off `d9a63f498b`, in its own worktree. The prototype worktree is untouched.
- Upstream now has `/btw` (ephemeral side turn, `Agent.buildSideRequestContext`, promotion to a forked session with branch reason `btw`). Inspect and reuse it only where it serves the snapshot contract; a child here is an interactive subagent, not an ephemeral turn.
- Hold-Send menu: the existing send-when choices (In / At / When idle) are the popover in `hub/src/webui/lib/scheduled-send.ts`, an overlay on the unpatched same-origin Collab guest, not part of `packages/collab-web`. The prototype's guest-side menu is not carried over. The guest exposes a small embed API; the hub popover gets a Side request mode. Ticket 3 splits into a guest part (fork) and a hub part (this repo).
- Wire contract chosen for all tickets: guest `{t:"side-request", reqId, text, images?}`; host replies only to the sender `{t:"side-request-result", reqId, ok:true, agentId}` or `{..., ok:false, message}`; welcome carries `sideRequests?: true`.
