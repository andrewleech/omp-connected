# Fleet setup and commissioning

Written: 2026-11-17
Status: proposed additional ticket with provisional forecast allowances. It is not approved or entered into the source project tracker. Acceptance checks below are planned, not observed results.
Source: user direction to add fleet setup to the accelerated project plan.
Owner: unassigned; project lead to assign before scheduling.

## Outcome

Set up a project-specific fleet with one computer for the hub and main development agents, plus additional computers where distributed hardware access and control require them. Provide software development and authorised target build/test paths with recorded evidence.

Add setup effort, equipment cost and availability to the fleet scenario, outside the 101.4 Engineer-day traditional baseline. Only the main computer is specified as necessary. Additional computer count, specifications, procurement cost and setup duration remain open.

## Scope

- Select and provision the main computer for the planned build/test load, concurrent sessions, storage and service availability. Decide model inference location separately before setting any local GPU requirement.
- Assess existing developer and bench computers for distributed hardware access. Provision additional computers only where access, availability, isolation or capacity requires them.
- Install and configure the approved omp/ompc runtime, project repositories, toolchains, model access and project context. Set network access and credentials within the approved project boundary.
- Record target identities and connections. Assign hardware-owning agents and accountable humans, exclusive access and permitted physical actions.
- Commission worker coordination and a software build/test path. Commission each required target build/program/test/evidence path when its hardware becomes available. Record operating and recovery instructions.

Estimate any required generic ompc platform change separately and link dependent work. Count it once. Project-specific driver tests and fixtures stay with their implementation or verification tickets unless explicitly transferred here.

## Resource allocation to existing tickets

Attach these resource requirements to each fleet ticket re-estimate:

| Resource field | Required information |
|---|---|
| Execution host | Main development computer, developer host or hardware-access host; required toolchain and access |
| Agent capacity | Concurrent workers needed and relevant build/test compute limits; model/provider limits where applicable |
| Physical resources | Board, probe, peripherals, fixture and operating conditions; stable identities when allocated |
| Ownership and occupancy | Hardware owner, exclusive/shared access, expected occupancy and reservation dependency |
| Availability | Earliest ready date, supplier/owner and missing prerequisites |
| Human input | Design decisions, supervision, review and acceptance authority |
| Evidence | Source/image revision, target configuration, logs, measurements and acceptance result |

Count fleet provisioning once in this ticket. Count ticket-specific use, fixtures and test execution in their work packages. Account for ongoing fleet maintenance, model consumption and infrastructure running costs separately from one-off setup. Separate existing equipment reuse from new expenditure.

## Dependencies and scheduling

The project lead confirms available machines, approved services/access and procurement needs. The setup owner works with hardware suppliers and target owners to establish availability dates. Each hardware station needs its board, probe, fixture and safe operating conditions before commissioning.

Make main development capacity an enabling milestone for software work. Commission each hardware station before its dependent target work, without holding unrelated development. Treat procurement lead time as calendar time, separate from engineer effort. Check for interference between co-hosted hub and worker loads at the planned concurrency.

## Acceptance evidence

- The main computer runs the project hub and planned initial development sessions. Approved users can observe and control the intended sessions.
- A representative worker receives a bounded assignment and produces a revision-linked build/test result through the agreed coordination path.
- Each hardware station needed by a ready work package demonstrates authorised target access and a relevant build/program/test cycle, with stable device identity and captured results. The selected ownership mechanism prevents conflicting access.
- After a restart or worker disconnection, task and resource state are reconciled against durable records before reassignment. The hub mailbox is not used as the durable task store.
- The project lead accepts the inventory, access rules, operating instructions, measured capacity and remaining station-readiness dependencies. Product release and unrestricted physical operation require separate approval.

## Estimate inputs still required

The setup owner supplies human effort by activity, machine availability or procurement lead time, equipment costs, expected initial concurrency and recurring operating costs. The project lead confirms initial capacity and the distributed stations needed for each delivery wave.

## Provisional estimate for scenario modelling

The [scenario assumptions](20261117_fleet-scenario-assumptions.json) allocate **5.5 Engineer days and 2.0 Principal days** to shared setup, plus **0.5 Engineer day and 0.1 Principal day per physical station** before scenario adjustments. The target scenario's two basic development-board stations, one prototype/plant station and one production fixture give a one-off setup allowance of **7.5 Engineer days and 2.4 Principal days**. These are judgement estimates, not measured effort or procurement quotes. Station count is separate from computer count.

Shared activities cover main configuration, governance, security review, durable task/evidence records, exclusive target access and first-wave forecast analysis. Host readiness depends only on its enabling activities. Exclusive access gates hardware work, and forecast analysis follows initial product work. The shared total checks the sum of its activities and adds no second charge. See the [estimate and schedule](20261117_fleet-estimate-and-schedule.md) for scenario-adjusted totals and readiness milestones.
