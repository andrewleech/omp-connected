# Smart Trolley fleet execution and assurance plan

**Status:** proposal for human assignment and approval. Role assignments, automation classes, access controls and operating rules below are not approved or active. This plan makes no measured throughput, acceleration, staffing, or readiness claim.

## Operating model

A **project coordinator** maintains the authoritative task and dependency state, assigns ready work, controls integration flow, checks resource conflicts and escalates blocked decisions. The coordinator does not approve requirements, safety interpretations, physical-operation exceptions or release.

**Deliverable workers** are assigned dynamically to bounded, independent software or evidence packages. A worker owns its task through implementation and submitted evidence; it does not self-approve. **Independent reviewers** are assigned separately from producers and assess the change and evidence against its contract. **Stable target-owning workers** retain responsibility for a particular board/bench station, its configuration, reservation calendar, target records and repeatable HIL execution. They may run their own assigned work but do not surrender target authority to whoever is currently coding. All role assignments are proposed; a human project lead assigns people and approves access.

### Work, branches and integration

Each task has a durable record outside hub messages: unique task ID, owner, status, dependencies, input revisions, acceptance criteria, branch/worktree, evidence links and decisions. Give each worker an owned branch/worktree and one bounded deliverable; avoid concurrent edits to the same working tree. A designated **integration owner** maintains the integration branch, orders merge candidates by dependency and review readiness, resolves conflicts with the owners, and records the merged revision. Workers do not merge directly to a release branch. Integration ownership is a proposed role, assigned by the project lead; it may be the coordinator only if workload and separation of duties permit.

### Task contract and resource fields

Before dispatch, the coordinator records:

| Field | Required content |
|---|---|
| Deliverable and boundary | Task ID, outcome, exclusions, dependencies, acceptance criteria and accountable task owner |
| Inputs | Requirement/interface decision IDs and revisions, source revisions, approved context and assumptions |
| Execution resources | Execution host, toolchain/access, worker capacity and compute/provider limits where applicable |
| Physical resources | Board, probe, fixture, peripherals, operating conditions, stable target identity, target owner and reservation/occupancy |
| Human resources | Required decision makers, supervision, independent reviewer and acceptance authority |
| Evidence | Source/image revision, configuration, commands/procedure, logs, measurements, results and reviewer disposition |
| Recovery | Current state, last durable checkpoint, safe-to-repeat assessment and handoff owner |

A task is ready only when prerequisites, decisions, resources and permissions are recorded. Fleet provisioning is counted once in the [setup ticket](20261117_fleet-setup-ticket.md); ticket-specific execution, occupancy and fixtures remain attached to the consuming tasks.

## Decision and review authority

The project lead assigns accountable human authorities for product requirements, interfaces, safety interpretation, target operation and acceptance. Workers may identify options and document evidence, but MUST NOT turn an inference or unresolved question into an approved requirement. The designated human decision authority resolves requirement conflicts and interface changes in a versioned decision record with rationale, owner, date and affected tasks. A changed decision or interface invalidates dependent assumptions and evidence until impact is assessed and required work is repeated.

Use these three review modes, all proposed and subject to explicit human approval:

1. **Initial mode: human review of every merge.** An independent human reviewer approves each change before integration.
2. **Later mode: approved low-risk classes only.** A human may explicitly approve specific change classes for automated merge checks after evidence from initial operation. Scope, controls, exclusions, monitoring and revocation criteria are recorded. No class is implicitly exempt.
3. **Always human consequential decisions.** Human authority is REQUIRED for requirements/interface decisions, safety or physical-operation changes, exceptions to approved procedures, acceptance of consequential test evidence, and release/ship decisions. Automated checks or agent review cannot replace these approvals.

## Context and evidence integrity

The repository's approved requirements, interface contracts, decision records, task state, target inventory and accepted evidence are authoritative shared context. Each record has an owner, revision and provenance. Worker notes, summaries, chat and hub mailboxes are working memory only; they can aid navigation but cannot override primary records or prove completion. Link observations to source revision, target/configuration and evidence. Before using cached context, check its revision. On requirement, interface, firmware, fixture or target-configuration change, mark affected assumptions/evidence stale, identify dependent tasks, and rerun or re-review as required. Do not copy sensitive inputs beyond the approved project boundary.

## HIL and physical-operation controls

Reserve each physical target through the target owner and a shared durable reservation record. Record target identity, task, operator, purpose, start/end window, configuration, approved procedure and handoff. A reservation is exclusive for actions that can alter target state; shared passive observation is allowed only when the owner records that it cannot interfere. Hardware tools available in a session do not establish permission or exclusive ownership. Use stable device identities, not transient device paths. The target owner confirms the safe starting state and documents restoration or safe shutdown at the end. Stop on unexpected behavior, uncertain state, conflicting access or out-of-procedure conditions; preserve evidence and escalate to the accountable human. Reset, erase, flash, energize, actuate, disconnect, change calibration and operate plant only when that action is explicitly permitted in the approved task/procedure and the required human authority is recorded. No unattended physical action or exception is implied by this plan.

Mandatory physical verification and elapsed soak are unchanged by fleet size or coding throughput. In particular, retain prototype dry-out confirmation, safe disconnect with venting and lights-off behavior, extended offline logging/replay, outage recovery/resume, every-channel commissioning tests including forced faults, system integration and the required soak. The source leaves soak duration and some acceptance details open; the accountable humans must define them. More workers do not shorten required physical test coverage or elapsed biological/plant behavior.

## Signals, permitted actions and boundaries

| Signal | Coordinator/automation may do | Must not do; boundary |
|---|---|---|
| Prerequisites and resources marked ready | Offer/assign a bounded task and notify its owner | Create new scope or bypass missing authority, dependency or reservation |
| Worker reports blocked or asks a decision | Record blocker, route to named decision authority and hold dependent work | Decide requirements or present an inference as approved |
| Worker submits change and evidence | Queue independent review; run approved software checks | Self-approve or merge outside the approved review mode |
| Review rejects or checks fail | Return task with findings; preserve revision/evidence | Suppress failures or mark accepted without disposition |
| Target reservation becomes available | Notify target owner and eligible task owner; prepare approved procedure | Flash/reset/actuate or assume target ownership automatically |
| Unexpected HIL result, unsafe state or conflicting reservation | Stop physical actions, preserve state/evidence, alert target owner and human authority | Retry destructive or state-changing action without assessment and permission |
| Worker/host disconnects or hub restarts | Reconcile durable task, branch, evidence and reservation state before reassignment | Treat message receipt/session presence as task completion or assume an operation stopped |
| Release candidate or consequential decision | Assemble revision-bound evidence for human decision | Release, accept safety interpretation or approve a consequential decision autonomously |

Signal-to-action automation is limited to these recorded rules and approved tools. The coordinator records the resulting task-state transition in the durable project record.

## Loss recovery and non-durable coordination

Hub mailboxes, events and session prompt queues are not the durable task ledger and may be lost. On worker or host loss, the coordinator checks the task record, branch/worktree and repository revision, artifacts, host/session status, and any active physical reservation. Mark state **unknown** until reconciled. For HIL, contact the stable target owner and establish the actual target and fixture state before any reassignment or repeat action. Preserve partial logs and identify the last known safe checkpoint. Reassign only after the original worker cannot continue, ownership is cleared, and the task owner judges whether remaining steps are safe to repeat. Idempotent host checks may be repeated under the task contract; physical or destructive actions require explicit state confirmation and renewed permission. Record recovery and handoff durably, then notify through hub messaging as a convenience, not as the record.

## Staged setup and commissioning

Commission capability in dependency order, without making all software work wait for every hardware station:

1. Confirm project boundary, approved services/access, available machines and accountable owners. Select and provision the main hub/development computer against planned session, build/test, storage and service load; do not assume local GPU or a fixed machine count.
2. Configure approved runtime, repository access, toolchains, model access and project context. Verify coordination and durable task records, then assign a representative bounded host task and capture revision-linked build/test evidence.
3. Inventory existing developer/bench computers and target stations. Provision additional distributed computers only where access, availability, isolation or capacity requires them. Record stable target identities, owners, safe states, permitted actions and reservation enforcement.
4. Commission each station when its board, probe, fixture and safe operating conditions are available. Demonstrate authorised target access and a relevant build/program/test/evidence cycle; resolve conflicting access before dependent HIL work begins.
5. Record actual capacity, remaining station dependencies, operating/recovery instructions and acceptance by the project lead. Setup acceptance does not approve unrestricted physical operation or product release.

Main development capacity enables host-testable work; each target station gates only work that needs that station. Include setup effort, equipment and recurring costs in the scenario once, distinct from task-specific work. Procurement lead time is calendar availability, not engineer effort.

## Acceptance milestones and forecast calibration

Milestones are evidence gates, not calendar promises:

- **Governance ready:** human role assignments, decision authorities, project boundary, review mode, access and physical-action policy approved and recorded.
- **Host path ready:** main host and coordination operate; representative bounded task reaches independent review with revision-linked build/test evidence; loss/restart reconciliation is demonstrated against durable state.
- **Station ready:** each station needed by currently ready work passes its authorised access, reservation/conflict, target-cycle and evidence checks. Other stations remain explicit dependencies, not a global software hold.
- **Integration ready:** dependency-complete changes enter the integration queue with accepted review/evidence and versioned requirement/interface decisions.
- **Product verification and release:** all applicable mandatory software and physical tests, soak, unresolved decisions and release evidence meet human-approved criteria; named human acceptance/release authority records the decision.

The first execution wave should include representative host-testable work with real dependency/interface boundaries, one integration cycle, independent review, and the first hardware-dependent work on a commissioned station when available. Record ready-to-accepted elapsed time, worker and human touch time, review/integration wait, rework, defects, resource occupancy, setup effort and cost, tied to task and revision. Compare forecast assumptions with observed outcomes, identify contention and omitted work, and revise the scenario transparently. One wave does not establish a project-wide acceleration factor. Do not claim schedule reduction until the estimate basis, human availability, hardware readiness, mandatory test durations and remaining uncertainty have been reconciled.

## Source basis

This plan applies the capability limits and controls in [fleet research and capabilities](20261116_fleet-research-and-capabilities.md), including non-durable hub messaging, absent native task scheduling, and the need for project-level task, review, evidence and hardware ownership records. Setup outcomes and resource allocation follow the [fleet setup ticket](20261117_fleet-setup-ticket.md). Project scope, mandatory verification and open decision limits are in the [traditional baseline](20261116_smart-trolley-traditional-baseline.md). These documents describe source inspection and planning proposals, not a commissioned fleet or completed tests.
