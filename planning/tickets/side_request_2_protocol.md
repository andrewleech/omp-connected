# Collab: authorize and route side requests

Sprint: [Collab side requests](../20261124_collab_side_request_sprint.md)
Depends on: [snapshot and child execution](side_request_1_snapshot_child.md)
Written: 2026-11-24 at planning HEAD 0a7549cd98; prototype base f2b795ba74

## Context and scope

Expose the child-start operation to writable Collab guests through the existing wire and host, with capability negotiation and errors the guest can act on. The host, not the browser, is the authorization boundary. Do not implement child snapshot logic or replace the ordinary prompt path. Revalidate planning HEAD, fork base and uncommitted worktree, integration branch and anchors before work; append a dated `Revalidated:` entry. The uncommitted prototype is a reference, not accepted code; filter its generated file noise.

## Fork reference anchors

Relative to the local `collab-side-request-fork` worktree:

- `packages/coding-agent/src/collab/protocol.ts:61-82`: prototype side-request frame and optional welcome capability. Check the shared wire grammar and all clients as well.
- `packages/coding-agent/src/collab/host.ts:754-756,840-842,1010-1018`: dispatch, advertisement, write-token check and asynchronous error.
- `packages/collab-web/src/lib/client.ts:224-229,371-372`: prototype client gating and capability reset.
- `packages/coding-agent/test/collab/read-only.test.ts:340-404`, `packages/collab-web/test/client.test.ts:424-513`: existing prototype coverage, not end-to-end evidence.

## Design and acceptance

- Add a distinct side-request command with task text and supported attachments. Negotiate capability on welcome. A capable client connected to an older host must not offer or send it; an older client must continue its existing prompt behavior with the new host. Reset negotiated state on disconnect/reconnect and new welcome. Preserve compatibility for the TUI guest and other shared wire consumers.
- Require a full-control peer on the host, including for a forged frame. Reject read-only peers, empty requests, invalid or unsupported attachments and startup failures with a useful targeted response. Accept a valid side request while the parent is busy without queuing it as a parent prompt. Do not leak the request or error to unrelated guests. Use existing limits and validation conventions.
- Tie submission success/failure to the correct draft and request, including asynchronous child setup failures, multiple submissions, disconnect and reconnect. Choose the smallest compatible acknowledgment/correlation mechanism needed; a socket send alone is not proof of successful startup. On rejection or failure, the browser can keep or restore the exact text and attachments and display the reason; it must not discard or overwrite a newer draft.
- Return or publish enough identity for the browser to discover the actual registered child, without substituting a parent message for it. Keep normal parent prompt/abort, pending questions and existing guest permissions unchanged.
- Add host and client tests for full-control, forged read-only, capability absent/present, old/new peer combinations, busy parent, invalid payload, concurrent requests, targeted errors and failure/disconnect draft recovery. Update existing protocol and product documentation. No deployment.

## Workflow and evidence

Use the index execution model. Coordinate the result/error interface with [the browser ticket](side_request_3_web_interaction.md); the user-visible path must be proved by [integrated verification](side_request_4_verification.md). No provider-boundary snapshot, byte-identity or guaranteed-cache-hit requirement applies.
