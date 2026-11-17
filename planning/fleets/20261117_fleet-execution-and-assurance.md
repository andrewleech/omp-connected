# Smart Trolley fleet execution and assurance plan

**Status:** proposed operating model for human assignment and approval. The roles, automation classes, access controls and operating rules are not approved or active. Source inspection and planning provide no evidence of commissioning, completed tests, measured throughput, acceleration, staffing or readiness.

## Operating model

A **project coordinator** maintains the authoritative task and dependency state, assigns ready work, controls integration, checks resource conflicts and escalates blocked decisions. The coordinator cannot approve requirements, safety interpretations, physical-operation exceptions or release.

**Deliverable workers** receive bounded, independent software or evidence packages and own them through implementation and evidence submission. They cannot approve their own work. **Independent reviewers**, assigned separately from producers, assess each change and its evidence against the task contract. **Stable target-owning workers** remain responsible for a board or bench station, its configuration, reservations, target records and repeatable hardware-in-the-loop (HIL) execution. They may execute assigned work, but target authority stays with them rather than passing to the current software worker. The human project lead assigns people and approves access.

### Work, branches and integration

Each task has a durable record outside hub messages: unique task ID, owner, status, dependencies, input revisions, acceptance criteria, branch/worktree, evidence links and decisions. Each worker receives an owned branch/worktree and one bounded deliverable, without concurrent edits to the same working tree. A designated **integration owner** maintains the integration branch, orders merge candidates by dependency and review readiness, resolves conflicts with the owners and records the merged revision. Workers cannot merge directly to a release branch. The project lead assigns the integration owner, who may also be the coordinator if workload and separation of duties permit.

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

The project lead assigns accountable human authorities for product requirements, interfaces, safety interpretation, target operation and acceptance. Workers may identify options and record evidence, but MUST NOT treat an inference or unresolved question as an approved requirement. The designated human authority resolves requirement conflicts and interface changes in a versioned decision record with rationale, owner, date and affected tasks. A changed decision or interface invalidates dependent assumptions and evidence until its impact is assessed and required work is repeated.

The three review modes require explicit human approval:

1. **Initial mode: human review of every merge.** An independent human reviewer approves each change before integration.
2. **Later mode: approved low-risk classes only.** After evidence from initial operation, a human may explicitly approve specific change classes for automated merge checks. The approval records scope, controls, exclusions, monitoring and revocation criteria. Every other class remains subject to human review.
3. **Always human consequential decisions.** Human authority is REQUIRED for requirements/interface decisions, safety or physical-operation changes, exceptions to approved procedures, acceptance of consequential test evidence, and release/ship decisions. Automated checks or agent review cannot replace these approvals.

## Context and evidence integrity

Approved requirements, interface contracts, decision records, task state, target inventory and accepted evidence in the repository are the authoritative shared context. Each record has an owner, revision and provenance. Worker notes, summaries, chat and hub mailboxes may help locate records, but cannot override them or prove completion. Link observations to source revision, target/configuration and evidence. Check the revision before using cached context. When requirements, interfaces, firmware, fixtures or target configurations change, mark affected assumptions and evidence stale, identify dependent tasks and repeat execution or review as required. Keep sensitive inputs within the approved project boundary.

## HIL and physical-operation controls

The target owner reserves each physical target in a shared durable record containing target identity, task, operator, purpose, start/end window, configuration, approved procedure and handoff. Actions that can alter target state require an exclusive reservation. Shared passive observation is permitted only when the owner records that it cannot interfere. Session tool access confers neither permission nor exclusive ownership. Use stable device identities rather than transient device paths. The target owner confirms the safe starting state and records restoration or safe shutdown at the end. Unexpected behaviour, uncertain state, conflicting access or conditions outside the procedure require a stop, preserved evidence and escalation to the accountable human. Reset, erase, flash, energise, actuate, disconnect, calibration changes and plant operation each require explicit permission in the approved task/procedure and a recorded human authority. Unattended physical actions and exceptions require explicit approval.

Fleet size and coding throughput do not change mandatory physical verification or elapsed soak. Retain prototype dry-out confirmation, safe disconnect with venting and lights-off behaviour, extended offline logging/replay, outage recovery/resume, every-channel commissioning tests with forced faults, system integration and the required soak. Accountable humans must define the soak duration and acceptance details left open by the source. Required physical coverage and elapsed biological/plant behaviour remain scheduling constraints.

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

Signal-to-action automation is limited to the recorded rules and approved tools. The coordinator records each resulting task-state transition in the durable project record.

## Loss recovery and non-durable coordination

Hub mailboxes, events and session prompt queues may be lost. After worker or host loss, the coordinator marks state **unknown** until the task record, branch/worktree, repository revision, artefacts, host/session status and active physical reservations are reconciled. For HIL, the stable target owner must establish the actual target and fixture state before reassignment or repeat action. Preserve partial logs and identify the last known safe checkpoint. Reassign only when the original worker cannot continue, ownership is cleared and the task owner judges the remaining steps safe to repeat. Idempotent host checks may be repeated under the task contract. Physical or destructive actions require explicit state confirmation and renewed permission. Record recovery and handoff durably before sending hub notifications.

## Staged setup and commissioning

Commission capability in dependency order. Hardware stations gate their dependent work, not all software development:

1. Confirm the project boundary, approved services/access, available machines and accountable owners. Select and provision the main hub/development computer for planned session, build/test, storage and service load. Decide local GPU needs and machine count rather than assuming them.
2. Configure the approved runtime, repository access, toolchains, model access and project context. Verify coordination and durable task records. Assign a representative bounded host task and capture revision-linked build/test evidence.
3. Inventory existing developer/bench computers and target stations. Provision additional distributed computers only where access, availability, isolation or capacity requires them. Record stable target identities, owners, safe states, permitted actions and reservation enforcement.
4. Commission each station when its board, probe, fixture and safe operating conditions are available. Demonstrate authorised target access and a relevant build/program/test/evidence cycle. Resolve conflicting access before dependent HIL work begins.
5. Record actual capacity, remaining station dependencies, operating/recovery instructions and project-lead acceptance. Unrestricted physical operation and product release require separate approval.

Main development capacity enables host-testable work. Count setup effort, equipment and recurring costs once in the scenario, separately from task-specific work. Procurement lead time affects calendar availability, not engineer effort.

## Acceptance milestones and forecast calibration

The milestones require evidence, not a promised date:

- **Governance ready:** human role assignments, decision authorities, project boundary, review mode, access and physical-action policy approved and recorded.
- **Host path ready:** main host and coordination operate; representative bounded task reaches independent review with revision-linked build/test evidence; loss/restart reconciliation is demonstrated against durable state.
- **Station ready:** each station needed by currently ready work passes its authorised access, reservation/conflict, target-cycle and evidence checks. Other stations remain explicit dependencies, not a global software hold.
- **Integration ready:** dependency-complete changes enter the integration queue with accepted review/evidence and versioned requirement/interface decisions.
- **Product verification and release:** all applicable mandatory software and physical tests, soak, unresolved decisions and release evidence meet human-approved criteria; named human acceptance/release authority records the decision.

The first execution wave should cover representative host-testable work with dependency/interface boundaries, one integration cycle, independent review and the first hardware-dependent work on a commissioned station when available. Record ready-to-accepted elapsed time, worker and human touch time, review/integration wait, rework, defects, resource occupancy, setup effort and cost against each task and revision. Compare results with forecast assumptions, identify contention and omitted work, and revise the scenario with recorded reasons. One wave cannot establish a project-wide acceleration factor. A schedule-reduction claim requires reconciliation of the estimate basis, human availability, hardware readiness, mandatory test durations and remaining uncertainty.

## Source basis

The [fleet research and capabilities](20261116_fleet-research-and-capabilities.md) establish the capability limits: hub messaging is non-durable, native task scheduling is absent, and project-level task, review, evidence and hardware ownership records are required. The [fleet setup ticket](20261117_fleet-setup-ticket.md) defines setup outcomes and resource allocation. The [traditional baseline](20261116_smart-trolley-traditional-baseline.md) records project scope, mandatory verification and open decisions.
