# Smart trolley: agent fleet pitch working brief

Written: 2026-11-16
Source baseline: user-supplied traditional project report, distilled in [traditional baseline](20261116_smart-trolley-traditional-baseline.md).
Repository revision at preparation: `083b26e`.
Status: proposal framing, not an approved delivery plan or revised estimate.

## Executive proposition

Use a project-specific agent fleet to reduce the **101.4 Engineer-day traditional plan**. The [17 November proposal report](20261117_fleet-proposal-report.md) forecasts **28.7 Engineer days over 11.0 working weeks** in its target scenario, including setup and coordination for the 30 sized tickets. Principal review and additional operator effort are separate; unsized work remains outside that finish.

Engineers direct architecture, resolve ambiguity and approve consequential changes. Parallel software workers deliver bounded packages; dedicated hardware-owning agents build, program and test identified targets under human authority. Measure accepted outcomes, human effort and elapsed time rather than agent count, generated code or token consumption.

## Traditional baseline

The user confirms **101.4 Engineer days** as the comparison baseline. The report separately includes **15.2 Principal engineer days** and about **21.5 elapsed weeks** under draft staffing assumptions. The rounded **117 person-day** headline combines roles. Keep engineering effort, oversight and calendar time separate.

| Baseline fact | Consequence for the pitch |
|---|---|
| 30 sized tickets remain draft; ERP link, phone UI and release verification are unsized and excluded from totals | Compare the sized scope; resolve the unsized work before forecasting the full release |
| AX-mini software, ERP-side software, PC recipe-authoring/fleet-view software and air-generation plant are outside the estimate | Keep the same exclusions and account for external dependencies separately |
| 76.4 Engineer days are classified before hardware; 25.0 with hardware | Host development offers parallel work; these effort categories do not define the elapsed critical path |
| Schedule totals are 101.4 Engineer days and 15.2 Principal engineer days; headline rounded role figures are 101.5 and 15.5 | The estimate owner must reconcile the discrepancy |
| Hardware dates and soak duration are unset | Faster coding alone cannot establish a delivery date |
| 12 of 40 evidenced entries rest on AI inference alone | Accountable humans must resolve those claims before dependent work proceeds |
| The estimate's AI-assistance basis is unconfirmed; tickets have undefined speed-up labels | Confirm the personal-agent baseline to distinguish its contribution from fleet orchestration |
| The laboratory-equipment, non-medical-device process basis is inferred and unconfirmed; no completed hazard analysis is supplied | Confirm assurance requirements before sizing review effort or comparing schedules |

The [baseline extraction](20261116_smart-trolley-traditional-baseline.md) records the figures and source locators. The source is a forecast, not observed performance.

## Project-specific candidate execution lanes

Run packages as their dependencies become ready. Preserve the recovered predecessors unless an engineer revises the contracts.

| Lane | Candidate work | Readiness and acceptance boundary |
|---|---|---|
| Foundations and contracts | Scheduler, host simulation, controller interfaces and configuration contracts | Agree interfaces and establish host-testable behaviour before dependent implementation |
| Parallel software work | Sensor/actuator drivers, storage, recipes, events and alarms | Launch each package only when its own predecessors are ready; prove behaviour against the common harness |
| Control and recovery | Pressure/VPD control, irrigation, disconnect and resume | Respect driver, simulator and lifecycle dependencies; host evidence does not replace prototype confirmation |
| Interfaces | REST API/ICD, pairing, phone interface and ERP link | API follows recipe store, events and identity; resolve and size the phone/ERP work before forecasting completion |
| Target execution | Board bring-up, target driver checks, self-test and provisioning | Reserve identified hardware and peripherals under a named human authority; capture physical fault and channel evidence |
| Integration and acceptance | Prototype integration, dry-out confirmation, offline/recovery tests, soak and release evidence | Converge on a tested revision; retain physical elapsed tests and authorised release review |

Start with several ready host-testable packages and independent board evidence from a target owner when hardware is available. Reuse the proposed host simulation harness. Fail-safe venting with software stopped, actual dry-out behaviour and full channel commissioning still need physical evidence.

Hardware supply depends on Mechanical, Electrical, Systems and the client. Assign a supplier and date to each PCBA, prototype trolley, production fixture and required pump/air source. A target owner reserves and operates equipment; procurement and readiness remain external dependencies. A named human must approve permitted physical actions before unattended operation.

## What changes from the traditional approach

The user describes one or two engineers, each with one personal coding agent. The fleet assigns bounded work packages with contracts, owners and acceptance evidence. Interfaces, hardware, integration and human review bound concurrency.

The project must provide or verify coordinator behaviour, signal-triggered dispatch, cross-review routing, scheduling, hardware reservations, durable memory and approval enforcement. These requirements are not established omp-connected capabilities.

## Audience decisions

| Audience | Decision supported | Evidence needed |
|---|---|---|
| Executives | Whether to fund a measured change in delivery model | Accepted scope delivered earlier, cost per accepted outcome, remaining delivery risk and a credible comparison with the baseline |
| PMs | How to replace the sequential schedule with dependency-driven execution | Work-package dependency graph, readiness criteria, resource constraints, accepted milestones and an updated critical path |
| Software RGM | Whether the approach retains the required engineering assurance | Explicit human authorities, traceability, independent review, target evidence, controlled changes and unchanged release acceptance obligations |

Project governance must confirm the software RGM's role and authority. The title does not establish a regulatory classification.

## Proposed operating model

Use one coordinator to maintain dependencies, interface decisions, integration state and the evidence index. Split work by deliverable and context boundary rather than sending every task through a chain of specialists.

Workers use isolated branches or worktrees. A separate reviewer checks behaviour against requirements and runnable evidence. A different model may help cross-review, but models can share blind spots. A controlled integration lane accepts reviewed work, runs the relevant checks and publishes a known tested revision. Limit dispatch to available integration and human-review capacity.

Each hardware agent owns identified boards, probes and peripherals. Enforce reservations for programming, reset and peripheral changes; software workers request target jobs through that owner. The [execution and assurance plan](20261117_fleet-execution-and-assurance.md) defines access, evidence and recovery controls. The [setup ticket](20261117_fleet-setup-ticket.md) defines commissioning.

## Human review proposal

Start with human review of every merge. The policy below needs human approval; any later reduction applies only to explicitly approved classes supported by project evidence.

| Level | Permitted agent work | Human boundary |
|---|---|---|
| Read-only investigation | Inspect approved material, analyse failures, propose changes and prepare evidence | Human owner resolves requirement, scope and architecture decisions |
| Supervised implementation | Implement, test and independently cross-review in an isolated environment | Human approves merge; relevant owner approves interface and architecture changes |
| Bounded automation | Execute approved repeatable jobs, such as a build or test on a reserved target, within defined limits | Human approves the job class and limits; unexpected effects or out-of-scope actions stop for review |
| Release or consequential action | Assemble evidence and recommend a disposition | Authorised human approves release and any action classified as consequential by project policy |

Before unattended runs, approve operating conditions, reset/flash permissions, stop conditions and escalation under the project's safety and change-control rules.

## Signals and shared memory

Use signals to dispatch ready work within its existing scope:

| Signal | Proposed action | Boundary and evidence |
|---|---|---|
| Work package becomes ready | Coordinator assigns a worker with a frozen contract | Named scope, inputs, owner and acceptance conditions |
| Candidate change is ready | Independent reviewer checks the change and its evidence | Review outcome and unresolved findings; no self-approval |
| Build or target test fails | Responsible worker investigates the recorded failure | Bounded repair within assigned scope; repeat failure or changed assumptions escalates |
| Reserved hardware becomes available | Hardware owner executes the next authorised job | Confirm target identity, software revision and operating conditions |
| Requirement or interface changes | Coordinator identifies affected work and stale evidence | Human resolves scope and contract changes before dependent work proceeds |

Keep approved requirements, interfaces, architecture decisions, procedures, hardware inventory and accepted findings in shared, versioned records. Give each conclusion provenance and a revision. Confidential inputs stay within approved systems. Worker summaries remain working notes until reviewed.

## Evidence behind the strategy

The [source inventory](20261116_agent-orchestration-sources.md) records precedents and their limits: Anthropic's parallel research orchestration, Shopify's executable verification and shared knowledge, Stripe's human merge review and Uber's attribution chain. These accounts concern different environments and do not establish this project's delivery gain.

The [distilled research and capability map](20261116_fleet-research-and-capabilities.md) separates existing ompc primitives, external tools and proposed workflow additions. Anthropic's **90.2%** internal research-evaluation improvement is not a coding-speed multiplier. Unresolved podcast figures are excluded from the pitch. Keep product claims, first-party accounts and independently measured project results distinct.

## How to substantiate acceleration

Use real product work that exercises parallel software delivery and target integration. Keep the original acceptance criteria and record human intervention, failed attempts, rework, model spend and infrastructure use. Compare accepted outcomes with the baseline's stated assumptions.

Measure ready-to-accepted elapsed time, Engineer hours per accepted outcome, review/integration waiting, defect escapes, rework and hardware utilisation. Include setup and assurance effort. Report costs separately from elapsed time.

Recalculate from dependencies and finite resources. Sequential decisions, hardware, review capacity and release gates may set the finish. A measured result applies to the work classes exercised; any extrapolation needs an explicit basis.

## Inputs and decisions

The [baseline extraction](20261116_smart-trolley-traditional-baseline.md) records scope, units, staffing, dependencies and verification activities. The quantified report's [decision table](20261117_fleet-proposal-report.md#decisions-and-first-execution-wave) assigns accountable roles and closure evidence.

Open inputs include engineer-reviewed estimates; sizing of phone UI, ERP link and release verification; agreed staffing, rates and AI-assistance basis; hardware dates and soak durations; assurance requirements and release authority. Fleet inputs also need an inventory, access constraints, approved model/data services, review capacity, ownership rules and budget limits. Scenarios use assumptions and sensitivities until these inputs are confirmed and delivery evidence is available.

## Quantified planning package, 2026-11-17

The [proposal report](20261117_fleet-proposal-report.md) and [ticket-level estimate and schedule](20261117_fleet-estimate-and-schedule.md) provide the forecast. The [scenario inputs](20261117_fleet-scenario-assumptions.json) separate software concurrency, human review, hands-on operator capacity and typed physical resources. Setup is additional scope; shared prototype/fixture availability stays constant across primary scenarios. The [presentation generator](20261117_build-fleet-pitch.py) produces the [slide content](20261117_fleet-pitch-content.md) and [PowerPoint deck](20261117_fleet-pitch.pptx) for the executive/PM/software RGM pitch.
