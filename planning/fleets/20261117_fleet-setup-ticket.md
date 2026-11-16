# Fleet setup and commissioning

Written: 2026-11-17
Status: proposed additional ticket with provisional forecast allowances; not approved or entered into the source project tracker.
Source: user direction to add fleet setup to the accelerated project plan.
Owner: unassigned; project lead to assign before scheduling.

## Outcome

Provide a project-specific fleet environment with a computer hosting the hub and main development agents, plus additional computers where needed for distributed hardware access and control. Enable software work and authorised target build/test work with recorded evidence.

This is additional scope against the 101.4 Engineer-day traditional baseline. Its effort, equipment cost and availability must be included in the fleet scenario. No machine count beyond the main computer, specification, procurement cost or setup duration has been agreed.

## Scope

- Select and provision the main computer for the hub and main development agents. Assess build/test load, concurrent sessions, storage and service availability; model inference location remains a separate decision, so do not assume local GPU requirements.
- Identify whether existing developer or bench computers can supply distributed hardware access. Provision additional computers only where access, availability, isolation or capacity requires them.
- Install and configure the approved omp/ompc runtime, project repositories, toolchains, model access and project context. Configure network access and credentials within the approved project boundary.
- Register target identities and connections, assign hardware-owning agents and accountable humans, and establish exclusive access and permitted physical actions.
- Commission worker coordination, a software build/test path and the required target build/program/test/evidence path as their hardware becomes available. Record operating and recovery instructions.

Generic ompc feature development is not silently included. Identify any required platform change separately, estimate it once and link dependent work. Project-specific driver tests and fixtures remain with their owning implementation or verification tickets unless explicitly transferred here.

## Resource allocation to existing tickets

Each fleet re-estimate should attach the applicable resource requirements rather than repeat fleet provisioning effort:

| Resource field | Required information |
|---|---|
| Execution host | Main development computer, developer host or hardware-access host; required toolchain and access |
| Agent capacity | Concurrent workers needed and relevant build/test compute limits; model/provider limits where applicable |
| Physical resources | Board, probe, peripherals, fixture and operating conditions; stable identities when allocated |
| Ownership and occupancy | Hardware owner, exclusive/shared access, expected occupancy and reservation dependency |
| Availability | Earliest ready date, supplier/owner and missing prerequisites |
| Human input | Design decisions, supervision, review and acceptance authority |
| Evidence | Source/image revision, target configuration, logs, measurements and acceptance result |

Fleet provisioning is counted once in this setup ticket. Ticket-specific use, fixtures and test execution are counted in their respective work packages. Ongoing fleet maintenance, model consumption and infrastructure running costs are accounted for separately from one-off setup. Distinguish existing equipment reuse from new expenditure.

## Dependencies and scheduling

The project lead must confirm available machines, approved services/access and procurement needs. Hardware-specific commissioning depends on the relevant board, probe, fixture and safe operating conditions. The setup owner coordinates with hardware suppliers and target owners to establish availability dates.

Do not make every development ticket wait for every hardware station. Make main development capacity an enabling milestone for software work, and commission each hardware station before its dependent target work. Procurement lead time is calendar time, not engineer effort. Check whether co-hosted hub and worker loads interfere under the planned concurrency.

## Acceptance evidence

- The main computer runs the project hub and the planned initial development sessions; approved users can observe and control the intended sessions.
- A representative worker receives a bounded assignment and produces a revision-linked build/test result through the agreed coordination path.
- Each hardware station required by a ready work package demonstrates authorised target access and a relevant build/program/test cycle, with stable device identity and captured results. Conflicting access is prevented by the selected ownership mechanism.
- A restart or disconnected worker is reconciled against recorded task/resource state before reassignment; no reliance on the hub mailbox as a durable task store.
- The project lead accepts the inventory, access rules, operating instructions, measured capacity and remaining station-readiness dependencies. Approval of this setup does not approve product release or unrestricted physical operation.

These are planned acceptance checks, not results already observed.

## Estimate inputs still required

The setup owner supplies human effort by activity, machine availability or procurement lead time, equipment costs, expected initial concurrency and recurring operating costs. The project lead confirms the required initial capacity and which distributed stations are needed for each delivery wave. The fleet schedule includes setup and commissioning without adding their effort again to every dependent ticket.

## Provisional estimate for scenario modelling

The [scenario assumptions](20261117_fleet-scenario-assumptions.json) now allocate **5.5 Engineer days and 2.0 Principal days** to shared setup activities, plus **0.5 Engineer day and 0.1 Principal day per physical station** before scenario adjustments. The target configuration has two basic development-board stations, one prototype/plant station and one production fixture: **7.5 Engineer days and 2.4 Principal days** of one-off setup allowance. These are judgement estimates, not measured effort or procurement quotes. Station count is not computer count.

Shared activities include main configuration, governance, security review, durable task/evidence records, exclusive target access and first-wave forecast analysis. Host readiness waits only for its enabling activities; exclusive access gates hardware, and forecast analysis follows initial product work. The shared aggregate is a checksum, not a second charge above its component activities. See the [estimate and schedule](20261117_fleet-estimate-and-schedule.md) for scenario-adjusted totals and readiness milestones.
