# Side request: verify the integrated flow

Sprint: [Collab side requests](../20261124_collab_side_request_sprint.md)
Depends on: [child](side_request_1_snapshot_child.md), [protocol](side_request_2_protocol.md), [browser interaction](side_request_3_web_interaction.md)
Written: 2026-11-24 at planning HEAD 0a7549cd98; prototype base f2b795ba74

## Context and scope

Prove the completed feature across the real host, Collab browser and subagent interface. The reported prototype result was 69 passing tests; this is not proof of an end-to-end side request, browser behavior or a deployed feature. The prototype is uncommitted reference only, and includes generated file noise. Revalidate planning HEAD, fork base, worktree status, integration branch and anchors before testing, then append a dated `Revalidated:` entry. No deployment is authorized.

## Reference anchors

All are relative to the local `collab-side-request-fork` worktree: `packages/coding-agent/src/task/side-request.ts:31-170`, `packages/coding-agent/src/collab/host.ts:754-756,1010-1018`, `packages/collab-web/src/components/shell/Composer.tsx:176-182,318-363`, and the prototype tests `packages/coding-agent/test/collab/read-only.test.ts:340-404`, `packages/collab-web/test/client.test.ts:424-513`, `packages/collab-web/test/composer.test.tsx:64-89`, `packages/coding-agent/test/session/session-manager-fork.test.ts:64-100`. Resolve actual integration and test paths afresh; these are starting anchors only.

## Acceptance and evidence

- Add or extend deterministic integration tests that start a real child from a live parent, assert the selected model, effective prompt, live tool definitions and completed conversation at the fork, execute a child-owned tool, observe its result in the subagent transcript, and send a follow-up. Keep the parent running and assert its turn and history are not diverted. Exercise a changed parent after capture, a partial multi-tool batch, persisted child reopen, unpersisted parent, child setup failure and cleanup, and concurrent shared-workspace access. Make conflict risk explicit rather than asserting filesystem isolation.
- Exercise the real wire and client for full-control/read-only, absent capability, older peer compatibility, attachments, error routing and draft preservation, including concurrent submissions and disconnect. Verify the existing send-when choices and ordinary parent prompts still work. Use real code paths, not just a mocked `startSideRequest`.
- Perform a local browser smoke using the active integration's served browser and a disposable session. On desktop and mobile-sized/touch viewports, open the existing hold-Send menu, select Side request, find the actual subagent, inspect output and send a follow-up while the parent works. Cover a pending host question, rejection or setup failure with retained draft, and a read-only or unsupported connection. Record environment, steps and observed results; do not capture private session content. This is local verification, not deployment.
- If an authorized real provider and cache usage metrics are available, make comparable parent and side requests using the normal supported path and record the provider, model, reported cache-read/write usage and relevant conditions. A provider-reported hit is evidence only for that run; no hit is required. If access or usage fields are unavailable, record that fact and the check attempted. Never infer a hit from timing, IDs or a mock, and do not require provider-boundary snapshots or byte-identical payloads.
- Run relevant unit, integration and browser checks once implementation is complete, plus the project's applicable build and type checks. Record exact commands, outcomes, environment and any unavailable provider check. Do not report unrun checks as passing. Review the product documentation for the control-link requirement, availability, shared workspace, child interaction and error behavior.

## Workflow

Use independent test authoring and execution, then standard and adversarial review per the planning index. Fix issues and repeat affected checks before marking the sprint complete. Record findings and evidence in the sprint's dated result report; do not deploy.
