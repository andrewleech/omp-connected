# Smart trolley: agent fleet pitch working brief

Written: 2026-11-16
Source baseline: user-supplied traditional project report, distilled in [traditional baseline](20261116_smart-trolley-traditional-baseline.md).
Repository revision at preparation: `083b26e`.
Status: proposal framing, not an approved delivery plan or revised estimate.

## Executive proposition

Use the **101.4 Engineer-day traditional plan** as the comparison baseline. The objective is a dramatic reduction in delivery time through a project-specific agent fleet, with engineers directing architecture, resolving ambiguity and approving consequential changes. Use developer machines for parallel software work and dedicated hardware-in-the-loop agents for target build, deployment and test. Preserve named human accountability and release acceptance.

The proposed gain is shorter time to accepted outcomes through parallel execution and earlier feedback. Agent count, generated code and token consumption are not delivery measures. Published success stories establish useful design precedents, not a project acceleration factor.

## What the traditional report actually establishes

The user confirms **101.4 Engineer days** as the traditional-plan baseline for this pitch. The report separately includes **15.2 Principal engineer days** and models about **21.5 weeks elapsed** under its draft staffing assumptions. Its rounded **117 person-day** headline combines roles and is not the baseline for the engineering-work comparison. Keep engineering effort, human oversight and calendar delivery time separate when presenting the proposed reduction.

| Baseline fact | Consequence for the pitch |
|---|---|
| 30 sized tickets remain draft; ERP link, phone UI and release verification are unsized and excluded from totals | Do not promise delivery of the full scope against the headline estimate |
| AX-mini software, ERP-side software, PC recipe-authoring/fleet-view software and air-generation plant are outside the estimate | Keep the fleet comparison within the same included scope; account for external dependencies separately |
| 76.4 Engineer days are classified before hardware; 25.0 with hardware | There is a substantial host-development opportunity, but these effort categories are not the elapsed critical path |
| Schedule totals are 101.4 Engineer days and 15.2 Principal engineer days; headline rounded role figures are 101.5 and 15.5 | Preserve the discrepancy until the estimate owner reconciles it |
| Hardware dates and soak duration are unset | A faster coding lane alone cannot establish the delivery date |
| 12 of 40 evidenced entries rest on AI inference alone | Resolve those claims with accountable humans rather than multiplying them across agents |
| The estimate's AI-assistance basis is unconfirmed; individual tickets carry undefined speed-up labels | Establish a confirmed personal-agent baseline so any measured gain separates personal-agent assistance from fleet orchestration |
| The laboratory-equipment, non-medical-device process basis is inferred and unconfirmed; no completed hazard analysis is supplied | Confirm applicable assurance requirements before sizing review effort or comparing schedules |

These figures and their source locators are in the [baseline extraction](20261116_smart-trolley-traditional-baseline.md). They describe a forecast, not observed performance.

## Project-specific candidate execution lanes

The following is a proposal derived from the extracted dependencies, not a replacement estimate. Preserve genuine predecessor dependencies unless an engineer explicitly revises the contracts.

| Lane | Candidate work | Readiness and acceptance boundary |
|---|---|---|
| Foundations and contracts | Scheduler, host simulation, controller interfaces and configuration contracts | Agree interfaces and establish host-testable behaviour before dependent implementation |
| Parallel software work | Sensor/actuator drivers, storage, recipes, events and alarms | Launch each package only when its own predecessors are ready; prove behaviour against the common harness |
| Control and recovery | Pressure/VPD control, irrigation, disconnect and resume | Respect driver, simulator and lifecycle dependencies; host evidence does not replace prototype confirmation |
| Interfaces | REST API/ICD, pairing, phone interface and ERP link | API follows recipe store, events and identity; resolve and size the phone/ERP work before forecasting completion |
| Target execution | Board bring-up, target driver checks, self-test and provisioning | Reserve identified hardware and peripherals under a named human authority; capture physical fault and channel evidence |
| Integration and acceptance | Prototype integration, dry-out confirmation, offline/recovery tests, soak and release evidence | Converge on a tested revision; retain physical elapsed tests and authorised release review |

Start by showing whether the fleet can advance several ready host-testable packages while a dedicated target owner produces independent board evidence. The project already proposes a host simulation harness; reuse that foundation rather than assuming hardware is required for every task. Conversely, fail-safe venting with software stopped, actual dry-out behaviour and full channel commissioning require physical evidence.

Hardware supply remains an external dependency involving Mechanical, Electrical, Systems and the client. Assign a supplier and delivery date for each PCBA, prototype trolley, production fixture and required pump/air source. Agent ownership means operational reservation, not control over procurement or hardware readiness. Assign a named human accountable for the permitted physical actions on each target before unattended operation.

## What changes from the traditional approach

The user describes a current plan based on one or two engineers, each working with one personal coding agent. The proposal changes the unit of delegation from a person's ongoing assistant session to a bounded work package with a contract, an owner and acceptance evidence. Engineers can direct several independent work packages while hardware owners execute target tests. Concurrency remains bounded by interface readiness, physical hardware, integration capacity and human review.

This is a proposed project-specific use of omp-connected. Coordinator behaviour, signal-triggered dispatch, cross-review routing, scheduling, hardware reservations, durable memory and approval enforcement are requirements to verify or provide, not capabilities established by this brief.

## Audience decisions

| Audience | Decision supported | Evidence needed |
|---|---|---|
| Executives | Whether to fund a measured change in delivery model | Accepted scope delivered earlier, cost per accepted outcome, remaining delivery risk and a credible comparison with the baseline |
| PMs | How to replace the sequential schedule with dependency-driven execution | Work-package dependency graph, readiness criteria, resource constraints, accepted milestones and an updated critical path |
| Software RGM | Whether the approach retains the required engineering assurance | Explicit human authorities, traceability, independent review, target evidence, controlled changes and unchanged release acceptance obligations |

The RGM role and its authority must be confirmed from project governance. This brief does not infer a regulatory classification from the audience title.

## Proposed operating model

One project coordinator maintains the dependency graph, interface decisions, current integration state and evidence index. It launches workers against independent scopes with sufficient context and clear acceptance conditions. Split by deliverable and context boundary rather than forcing every task through a long chain of specialist agents.

Implementation workers own isolated branches or worktrees. Cross-review uses a separate agent, preferably a different model where useful, and checks behaviour against requirements and runnable evidence. Different models can still share blind spots; model diversity does not establish independence or correctness by itself.

Hardware agents have explicit ownership of identified boards, debug probes and attached peripherals. A lease or equivalent enforced reservation prevents concurrent programming, reset or peripheral reconfiguration of the same target. Each result records the source revision, firmware image, board identity, configuration, test procedure and outcome. Software workers request hardware jobs rather than accessing a shared target outside its owner. Hardware quantity and availability constrain concurrency.

A controlled integration lane accepts reviewed work, runs relevant integration checks and publishes a known tested revision. Increased worker output must not become an unbounded integration or human-review queue.

## Human review proposal

These are proposed policy levels, not permissions granted by this document. Start with human review of every merge. Reduce review only for explicitly approved classes after project evidence supports the change.

| Level | Permitted agent work | Human boundary |
|---|---|---|
| Read-only investigation | Inspect approved material, analyse failures, propose changes and prepare evidence | Human owner resolves requirement, scope and architecture decisions |
| Supervised implementation | Implement, test and independently cross-review in an isolated environment | Human approves merge; relevant owner approves interface and architecture changes |
| Bounded automation | Execute approved repeatable jobs, such as a build or test on a reserved target, within defined limits | Human approves the job class and limits; unexpected effects or out-of-scope actions stop for review |
| Release or consequential action | Assemble evidence and recommend a disposition | Authorised human approves release and any action classified as consequential by project policy |

Hardware access does not imply permission to perform every physical action. Define permitted operating conditions, reset/flash permissions, stop conditions and escalation before unattended runs. Apply the project's actual safety and change-control rules once identified.

## Signals and shared memory

Use signals to reduce waiting, not to create uncontrolled new scope.

| Signal | Proposed action | Boundary and evidence |
|---|---|---|
| Work package becomes ready | Coordinator assigns a worker with a frozen contract | Named scope, inputs, owner and acceptance conditions |
| Candidate change is ready | Independent reviewer checks the change and its evidence | Review outcome and unresolved findings; no self-approval |
| Build or target test fails | Responsible worker investigates the recorded failure | Bounded repair within assigned scope; repeat failure or changed assumptions escalates |
| Reserved hardware becomes available | Hardware owner executes the next authorised job | Confirm target identity, software revision and operating conditions |
| Requirement or interface changes | Coordinator identifies affected work and stale evidence | Human resolves scope and contract changes before dependent work proceeds |

Keep approved requirements, interface contracts, architecture decisions, test procedures, hardware inventory and accepted findings in a shared, versioned project record. Attach provenance and revision to conclusions. Give workers the relevant context slice rather than copying every source into every prompt. Keep confidential project context within approved systems. Do not promote unreviewed worker summaries into authoritative requirements or decisions.

## Evidence behind the strategy

See the [source inventory](20261116_agent-orchestration-sources.md) for links and limitations. Useful precedents are Anthropic's parallel research orchestration, Shopify's executable verification of findings, Stripe's human merge review, Uber's attribution chain and Shopify's shared knowledge practices. These sources describe different environments; none establishes the delivery gain for this project.

The [distilled research and capability map](20261116_fleet-research-and-capabilities.md) connects these lessons to existing ompc primitives, external tools and proposed project workflow additions.

Do not use Anthropic's 90.2% internal research-evaluation improvement as a coding speedup. Do not use unresolved podcast figures as slide headlines. Product capability claims, first-party success accounts and independently measured project outcomes must remain distinct.

## How to substantiate acceleration

Select real baseline work that exercises both parallel software delivery and target integration. Keep the original acceptance criteria and record all human intervention, failed attempts, rework, model spend and infrastructure use. Compare accepted outcomes against the baseline's stated assumptions. A forecast estimate is a comparator, not an observed control experiment.

Measure elapsed time from ready to accepted, engineer hours per accepted outcome, integration/review waiting time, defect escapes, rework and hardware utilisation. Include setup and assurance effort. Report costs separately from elapsed time.

Recalculate the schedule from the dependency graph and resource limits. Do not divide total estimated effort by the number of agents. Required sequential decisions, hardware availability, review capacity and release gates may dominate the new critical path. A measured result supports only the work classes actually exercised; extrapolation to other classes must remain explicit.

## Information needed for a quantified pitch

The [baseline extraction](20261116_smart-trolley-traditional-baseline.md) records the source scope, units, staffing model, dependencies and stated verification activities. Open items include engineer-reviewed estimates; sizing of phone UI, ERP link and release verification; an agreed team, rates and AI-assistance basis; hardware dates and soak durations; assurance requirements; and release acceptance authority. The fleet proposal also needs the hardware inventory, access constraints, approved model/data services, review capacity, ownership rules and budget limits. Numerical scenarios can inform these decisions using explicit assumptions and sensitivities; they remain forecasts until confirmed and calibrated against delivery evidence.

## Quantified planning package, 2026-11-17

The [proposal report](20261117_fleet-proposal-report.md) and [ticket-level estimate and schedule](20261117_fleet-estimate-and-schedule.md) extend this framing into an explicit forecast. The [scenario inputs](20261117_fleet-scenario-assumptions.json) separate software concurrency, human review, hands-on operator capacity and typed physical resources. Fleet setup is additional scope, and shared prototype/fixture availability is held constant across the primary scenarios. The [presentation source](20261117_fleet-pitch-content.md) and [PowerPoint deck](20261117_fleet-pitch.pptx) provide the executive/PM/software RGM pitch. These forecasts cover the 30 sized tickets plus setup, before the three unsized items and product release verification.
