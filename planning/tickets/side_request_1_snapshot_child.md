# Side request: fork a safe interactive child

Sprint: [Collab side requests](../20261124_collab_side_request_sprint.md)
Depends on: none
Written: 2026-11-24 at planning HEAD 0a7549cd98; prototype base f2b795ba74

## Context and scope

A guest needs to ask a side question without steering or interrupting the parent. Create an interactive child from the parent's state at one fork point, persist it and run its request independently. The prototype is uncommitted reference material, not accepted code; examine its working diff and generated file noise at execution. Revalidate planning HEAD, fork base, current active integration and anchors before work, then append a dated `Revalidated:` entry.

Out of scope: Collab wire/UI, cross-layer browser verification, deployment, provider-boundary snapshot schemes, byte-identity guarantees and guaranteed cache hits. Those first three items belong to sibling tickets.

## Fork reference anchors

Paths are relative to the local `collab-side-request-fork` worktree and are starting points, not an instruction to copy the prototype.

- `packages/coding-agent/src/task/side-request.ts:31-170`: snapshots live state before asynchronous setup, forks a session, binds child tools and registers a lifecycle. Review cleanup and resumed behavior as well as the happy path.
- `packages/coding-agent/src/session/session-context.ts:31-32`: prototype snapshot entry used to reconstruct child context; inspect the corresponding session loading and branch code.
- `packages/agent/src/agent.ts:982-1001`: existing side-context construction; use existing mechanisms only where they serve this contract.
- `packages/coding-agent/test/session/session-manager-fork.test.ts:64-100`: prototype fork persistence coverage, not proof of full side-request startup.

## Design and acceptance

- At the fork point capture the parent's selected model, live effective system prompt, live tool definitions and completed conversation, including relevant compacted history. Later parent changes or streamed output must not mutate that snapshot. Define the boundary consistently for idle, streaming, tool-running and multi-tool turns.
- A partially streamed assistant response or incomplete tool-call batch must never leave orphan calls/results in the child. Preserve the complete prefix and a consistent persisted branch. Exercise one completed and one incomplete call in the same batch, as well as no matching persisted leaf. Reopen the child session and prove the same valid snapshot and follow-up behavior; do not silently claim persistence when the parent is not persisted. Return a clear failure or use a demonstrably safe existing persistence path.
- Instantiate real child-owned tool execution with the fork's live advertised definitions and normal authorization, extension and MCP rules. Never run a parent's session-bound tool closure as the child. Explicitly fail and clean up if a required tool cannot be safely bound; no leaked registry entries, MCP followers, sessions or background jobs. Test read/write tools, one missing binding and setup failure.
- Register a real independently identified interactive subagent with a lifecycle, transcript, output and ability to accept later messages. Its first request contains the side task and any supported images. Parent turn, queue, transcript, status and provider-session state are not redirected, aborted or overwritten by the child; child failures do not interrupt the parent. Test both concurrent progress and independent follow-up.
- Parent and child share the same working directory and workspace. Keep existing file and command permissions; make no promise of isolation or conflict prevention. Cover concurrent filesystem activity and verify each session retains its own context. The UI/docs ticket communicates the risk.
- Prefer existing supported cache affinity while keeping provider sessions independent. Model and prompt changes after forking do not silently change the child's initial snapshot. Do not require provider-boundary snapshots, byte-identical payloads, or cache hits.

## Workflow and evidence

Use the index execution model. Add focused tests for snapshot timing, interrupted tool batches, persistence/resume, tool binding and lifecycle. Record observed checks and failure cases. Update existing product documentation for the behavior owned here. Cross-layer and browser evidence belongs to [verification](side_request_4_verification.md). No unresolved design decision is required before inspection; choose the existing safe session mechanisms, or record a concrete blocker if their contracts cannot support this behavior.
