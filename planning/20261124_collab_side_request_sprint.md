# Collab side requests: sprint plan

Written: 2026-11-24 at planning HEAD 0a7549cd98
Reference: local `collab-side-request-fork` worktree, base `f2b795ba74`

## Goal

A writable Collab guest can start an independent, interactive subagent from a snapshot of the current session, inspect its progress and output, and send follow-up messages while the parent continues its own work. Reuse the current model, live prompt and tool definitions, and completed conversation at the fork point. The child executes tools in its own session and shares the workspace with the parent.

## Starting point and boundaries

The fork worktree is an uncommitted prototype, not an accepted implementation or a deployment. Treat its paths below as reference anchors, not as files to copy wholesale. Its changes include generated file noise; distinguish generated changes from source changes before selecting work. The reported prototype run had 69 passing tests, but those tests do not establish end-to-end side-request startup, child execution, or browser operation. This sprint is a plan only. It does not authorize deployment.

Before execution, revalidate the planning HEAD and the fork base, worktree status, active integration branch, current source and later planning decisions. Resolve each anchor against that state and append a revalidation entry to each ticket. The prototype is uncommitted, so comparing committed revisions alone is insufficient; inspect its current working diff without altering user work. Confirm where the running integration serves its Collab browser, and inspect its actual composer and hub rather than assuming the prototype's menu is present there.

## Delivery order

1. [Snapshot and child execution](tickets/side_request_1_snapshot_child.md): capture a coherent, resumable branch and safely bind live capabilities. This is the prerequisite for an actual side request.
2. [Collab protocol and errors](tickets/side_request_2_protocol.md): advertise and authorize the capability, route requests and return usable failures. Depends on ticket 1's child API. Can be designed alongside ticket 1.
3. [Composer and subagent interaction](tickets/side_request_3_web_interaction.md): extend the existing send-when menu in the active integration, and expose actual child discovery, output and follow-up. Depends on tickets 1 and 2. UI investigation can start earlier.
4. [Integrated verification](tickets/side_request_4_verification.md): independently exercise the real flow, persistence, concurrency, compatibility and provider-reported cache usage when available. Depends on tickets 1 to 3.

Implementation, independently authored tests, and standard plus adversarial reviews follow the planning index execution model. Fix findings and repeat the relevant checks. Each implementation ticket includes its own tests; ticket 4 owns cross-layer proof rather than replacing those tests.

## Contracts

- Snapshot the current model, live system prompt and live tool definitions and the completed conversation at the fork point. Do not include an unfinished assistant tool batch in a way that creates orphaned calls or results. Persist enough state for a valid child resume and follow-up, without mutating the parent history or diverting its running turn.
- The child is a real interactive subagent with independent identity, lifecycle, transcript, tool execution and follow-up. Rebind executable tools to the child context; do not execute parent-bound closures. Fail clearly if a required tool cannot be safely bound. Parent and child use the same workspace, not isolated copies. Concurrent edits, commands and shared resources may conflict; surface this fact, preserve normal permission checks, and do not claim conflict prevention.
- Full-control guests may request a side task when the host advertises support. Read-only and older/unsupported peers must not gain the capability. Preserve the draft and attachments on rejection or send failure, and show actionable errors. The host remains the authority.
- Extend the active integration composer's current hold-Send send-when choices, without replacing existing modes or their normal semantics. Verify that its actual Collab subagent interface exposes the new child, output and follow-up; a host registry entry by itself is not acceptance.
- Favor normal cache reuse for the fork where supported. There is no requirement to capture a provider-boundary snapshot, force byte-identical requests, or guarantee a cache hit. Report only real provider-reported cache usage when available; otherwise record that it was unavailable.

## Exit criteria

All four tickets meet their acceptance criteria, including automated regression tests and a browser smoke against a local test instance. A provider check records actual reported cache usage when available, without inferring a hit. The user-visible flow, limits, shared-workspace warning and any compatibility behavior are documented in the product's existing documentation. Record evidence and any unavailable checks; do not deploy as part of this sprint plan.

## Revalidated: 2026-11-26

Checked at planning HEAD `903d96f`.

- Fork: upstream/main is now `d9a63f498b` (v19.2.x), 5868 commits past the prototype base `f2b795ba74`. Collab host, protocol, wire, web guest, session and task paths all changed, so the prototype diff is reference only. Work goes on a fresh branch `collab-side-request` off `d9a63f498b`, in its own worktree. The prototype worktree is untouched.
- Upstream now has `/btw` (ephemeral side turn, `Agent.buildSideRequestContext`, promotion to a forked session with branch reason `btw`). Inspect and reuse it only where it serves the snapshot contract; a child here is an interactive subagent, not an ephemeral turn.
- Hold-Send menu: the existing send-when choices (In / At / When idle) are the popover in `hub/src/webui/lib/scheduled-send.ts`, an overlay on the unpatched same-origin Collab guest, not part of `packages/collab-web`. The prototype's guest-side menu is not carried over. The guest exposes a small embed API; the hub popover gets a Side request mode. Ticket 3 splits into a guest part (fork) and a hub part (this repo).
- Wire contract chosen for all tickets: guest `{t:"side-request", reqId, text, images?}`; host replies only to the sender `{t:"side-request-result", reqId, ok:true, agentId}` or `{..., ok:false, message}`; welcome carries `sideRequests?: true`.

## Result: 2026-11-26

Tickets 1 to 4 executed on branch `collab-side-request` in the fork and in this repo. Evidence, checks, review findings and open items are in [the results report](20261126_collab_side_request_results.md). Not deployed and not yet merged into the fleet integration.
