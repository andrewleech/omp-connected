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
