# Smart Trolley: accelerated agent fleet delivery proposal

Written: 2026-11-17
Repository basis: `6bddf77`, plus the accompanying dated estimate inputs and model.
Status: planning forecast for executive, PM and software RGM review. Estimates are judgement allowances, not measured fleet performance or a delivery commitment.

## Recommendation

Replan the **101.4 Engineer-day** software scope around a project-specific omp-connected fleet. The target forecast is **28.7 Engineer days over 11.0 working weeks**, including setup and coordination for the 30 sized packages. That releases **72.7 Engineer days, about 72% of the baseline allocation**, and takes about half the source schedule's elapsed time.

Use a main hub/development computer, parallel workers with bounded deliverables, independent review and dedicated target-owning agents. Add hardware-access computers where equipment access or capacity requires them. Engineers retain contracts, decisions, integration, acceptance and exceptions rather than dispatching every build/test cycle.

Approve the initial capacity and operating controls against the target scenario, then update the forecast from delivery evidence. Use the cautious scenario for constrained delivery and the stretch scenario for the opportunity when resources and decisions are ready. The scenarios are planning cases, not confidence percentiles or guarantees.

## Quantified forecast

| Scenario | Engineer days, including setup and coordination | Principal days | Additional operator days | Elapsed working weeks |
|---|---:|---:|---:|---:|
| Traditional estimate | 101.4 | 15.2 | Not recorded | 21.5, draft source schedule |
| Cautious fleet | 38.2 | 16.6 | 4.4 | 17.4 |
| Target fleet | 28.7 | 12.7 | 4.4 | 11.0 |
| Stretch fleet | 25.4 | 12.2 | 4.4 | 9.4 |

The target includes **7.5 Engineer days and 2.4 Principal days of one-off setup**. The [comparison boundary](#comparison-boundary) identifies the unsized work and exclusions; the [economics](#economics) distinguish released capacity from cash savings.

### Target delivery sequence

| Acceptance milestone | Working day from start | Evidence |
|---|---:|---|
| Main environment ready | 7.9 | Configuration, authorities, project access and durable records ready |
| First host package accepted | 11.9 | Implemented, independently reviewed and human-approved result |
| First target package accepted | 17.7 | Commissioned station, controlled operation and revision-linked target evidence |
| Early dry-out confirmation | 28.7 | Physical observation accepted before integrated prototype acceptance |
| Integrated prototype accepted | 41.1 | Functional target checks, including alarms, events and self-test, complete |
| System verification and soak accepted | 52.6 | Integrated revision, required fault/offline checks and physical observation |
| All sized work plus setup complete | 55.2 | Every sized package and setup activity complete, including design/release records |

These are calculated offsets from the start, not calendar commitments. The fleet model adds dry-out-before-integration as a risk-reduction policy. Each target stays reserved on the same commissioned station from manual preparation through execution and observation. The operator is occupied only during manual preparation.

### What changes the forecast

**Human review has more effect than worker count.** Retaining the original 15.2 Principal days for sized-ticket review increases the target schedule to **14.0 weeks**. Increasing new human/execution allowances by 25% gives **12.8 weeks**. Halving operator availability gives **13.7 weeks**; increasing it to 0.5 FTE gives **10.2 weeks**. Extending the assumed soak from five to ten working days adds one week.

Increasing execution slots from three to six or ten does not shorten the target schedule in this model. Review, physical work and dependencies set the limit. Start with capacity for ready work and expand when contention warrants it. The third basic board in the stretch configuration is commissioned but unused by its selected schedule.

Moving all resource-readiness dates 25 working days later changes the target to **14.4 weeks**. Initial decision allowance and physical readiness dates can overlap setup, so delays need not extend the finish one-for-one.

## Comparison boundary

The engineering comparison uses the user-confirmed **101.4 Engineer days**, with **15.2 Principal engineer days** separate. The source's **21.5 elapsed weeks** uses draft team/loading assumptions. It is an indicative comparator, not an observed sequential-agent result or an equal-resource experiment.

The 30 displayed sized-ticket values sum to **101.5 days**, a 0.1-day difference between report cards and schedule totals. The model keeps those individual values for traceability and uses 101.4 for savings.

The original **ERP link, phone UI and release verification** tickets remain unsized and outside the savings and finish milestone. AX-mini software, ERP-side software, PC authoring/fleet-view software and air-generation plant were excluded from the original estimate. The forecast covers all 30 sized packages and fleet commissioning. A full product release date still needs the unsized work, external dependencies and release process resolved; finishing the sized scope does not authorise shipment.

The source staffing model includes Test engineer 50%, but no explicit test-role effort total was recovered. No saving is claimed for that role. The forecast adds hands-on operator effort, scheduled against **0.25 FTE**, for fixture preparation and manual verification. Engineer and Principal effort separately covers technical intervention and acceptance. The project must agree who performs each role.

Scenario capacities are independently available role pools, not headcounts. If one person covers Engineer and operator duties, both allocations must fit their availability without conflicting assignments. The target requires **0.80 Engineer, 0.35 Principal and 0.25 operator FTE**, a total of **1.40 FTE**. Approval requires named people for each allocation.

## How the acceleration works

Workers implement and host-test independent packages against shared contracts. Separate reviewers check behaviour and evidence. Target-owning agents run authorised build, program, capture, diagnose and retest cycles without an engineer dispatching each step. Shared records retain decisions and accepted findings; each worker receives the context needed for its deliverable.

Host-testable packages can release dependent host work after host acceptance, while required physical confirmation is tracked separately. Hardware-dependent work releases successors only after target acceptance. Prototype integration also waits for the functional target checks added by the fleet model. These added acceptance dependencies are model assumptions; the recovered source dependencies remain visible.

The largest opportunity is the **76.4 Engineer days classified before hardware**. Agents can also automate repeatable execution within the remaining **25.0 hardware-associated days**, but target availability and physical test duration remain constraints. More software workers cannot shorten a required soak or resolve a client decision.

## Estimate method

The [work-package allowances](20261117_fleet-work-package-estimates.json) estimate Engineer involvement, Principal review, agent implementation, independent agent review and active target occupancy for each sized package. Each allowance estimates the new workflow directly. Control tuning, recovery, safe state and integration have larger human/target allowances than simpler storage or configuration work.

The [scenario assumptions](20261117_fleet-scenario-assumptions.json) vary agent slots, basic board-station count, human capacity and software execution/rework allowances. All primary scenarios assume boards ready at working day **5**, one prototype/plant station at day **10** and one production fixture at day **10**. A working day provides **eight hours of capacity**, with **five working days per week** and no overnight or weekend gain. An agent slot is one occupied execution resource, not an engineer or unlimited machine capacity.

Setup counts main-environment provisioning and each station's commissioning once. Recurring coordination reserves **0.10 Engineer FTE and 0.02 Principal FTE** within each scenario's allocation. These reserves reduce task capacity; their effort over the delivery period is included in the savings calculation. Ticket estimates retain task-specific briefing, intervention and acceptance.

Raw Principal ticket allowances increase by **50%** for human review of every merge plus decisions. The stretch scenario keeps that review allowance, target-active duration, physical acceptance effort and operator effort unchanged. All scenarios include a **two-day initial decision allowance**; later unresolved stakeholder decisions remain a risk.

Physical observation allows **five working days for system soak** and **two for dry-out**, unchanged across scenarios. These are unconfirmed planning allowances, not recovered requirements or measured biological durations. The test authority must approve replacement durations.

The system-soak procedure includes extended offline logging/replay observation, subject to confirmation by the test authority. Short disconnect, recovery and forced-fault checks retain explicit target/operator time. Dedicated target owners and serialised operation provide exclusivity; ompc has no native hardware locks.

The [reproducible model](20261117_fleet-model.py) expands tickets into human, implementation, review and target phases and schedules them against finite resource calendars. It produces a deterministic feasible list schedule, without proving optimality. It reports dependency-only path length separately from resource-limited finish. Sensitivities vary hardware readiness, worker concurrency, Engineer capacity, physical duration and execution/human allowances.

## Fleet setup and resources

Commission the environment against the [setup ticket](20261117_fleet-setup-ticket.md), including its resource fields and acceptance evidence. The forecast assumes a suitable main hub/development computer is available at the start. Procurement lead time remains a calendar dependency, separate from Engineer effort. Local GPU inference is not assumed. Commissioning must establish usable session/build concurrency, provider quotas, storage and service availability, including interference between co-hosted hub and workers.

Development boards support basic firmware/peripheral checks. The shared prototype/plant supports controls, physical lifecycle, integration, dry-out and soak; the production fixture supports provisioning. A prototype run reserves that pool exclusively. More basic boards cannot enable concurrent destructive tests on the one trolley.

Main-environment readiness enables software work; each station gates only the work that uses it.

ompc supplies session visibility, messaging, capable-host session launch/control and configuration primitives. The project must provide or verify durable task state, dependency dispatch, independent review policy, evidence provenance and hardware reservation. Any required generic platform development needs a separate estimate before schedule acceptance.

## Assurance and delivery gates

Use the [execution and assurance plan](20261117_fleet-execution-and-assurance.md) for task, review, evidence, target-access and recovery controls. Assign human authorities for requirements, interfaces, physical operation, engineering acceptance and release. Start with human review of every merge. Later automation needs explicit approval for recorded low-risk classes; consequential decisions and release remain human approvals. Different models may help cross-review, but model diversity alone establishes neither independence nor correctness.

Retain dry-out checks, software-stopped fail-safe venting/lights-off, offline logging/replay, outage recovery, every-channel commissioning with faults, integration and soak. Resolve the open process/safety classification before final assurance sizing. Accountable humans must review AI-inference-only requirements and open control/interface decisions.

Accepted tasks need revision-linked evidence and reviewer disposition. Keep task and reservation records outside the hub mailbox. Message receipt proves neither completion nor approval. Reconcile worker/host loss and the physical state before reassignment or repeat operation.

## Economics

Report human effort savings separately from calendar acceleration. A monetary saving needs agreed role rates, equipment quotes, model consumption and recurring operating costs.

With daily Engineer, Principal and operator rates E, P and O, the conservative sized-scope break-even allowance for additional equipment/service costs is:

`(101.4 - forecast Engineer days) × E + (15.2 - forecast Principal days) × P - forecast operator days × O`

This effort-based calculation assumes people can use unoccupied capacity elsewhere and charges follow assigned work. If the project reserves each role for the whole delivery window, use `elapsed working days × assigned role FTE × daily rate` instead. Report both utilised effort and reserved capacity before claiming cash savings. The baseline's focus/loading assumptions also need commercial agreement; fewer touch hours need not reduce invoices or salary costs by the same amount.

| Target charging basis | Engineer days | Principal days | Operator days |
|---|---:|---:|---:|
| Forecast utilised effort, including setup/coordination | 28.7 | 12.7 | 4.4 |
| Whole-window reserved capacity | 44.1 | 19.3 | 13.8 |

The reserved-capacity figures use **55.2 working days** at **0.80/0.35/0.25 FTE**, calculated before rounding. They are an alternative charging basis, not extra effort.

Forecast role days already include setup and coordination. Deduct additional equipment, model/service usage and other incremental operating costs to find the net saving. Reused equipment is not new capital expenditure, but existing compute/provider capacity can have an opportunity cost. External costs cancel only where scope and procurement match.

## Evidence behind the proposal

The [distilled research and capability map](20261116_fleet-research-and-capabilities.md) and [source inventory](20261116_agent-orchestration-sources.md) link the operating model to Anthropic's parallel orchestration, Shopify's executable verification and shared context, Stripe's human merge review, and Uber's attribution and event-driven workflows. These are mostly first-party accounts from different environments. They support the mechanisms, not this project's numerical forecast.

Anthropic's **90.2%** internal research-evaluation result is not used as a coding-speed multiplier. Unresolved podcast figures are excluded from the business case. The temporary source-report capture is absent; ticket IDs, estimates and dependencies were recovered from the prior visible extraction record. The [normalised input](20261117_traditional-ticket-inputs.json) records this provenance and the unrecovered fields.

## Decisions and first execution wave

| Decision | Accountable role | Evidence that closes it |
|---|---|---|
| Working scenario, human availability and initial capacity | Project lead with PM and engineering management | Agreed allocations, model/provider budget and main-machine capacity |
| Hardware/station supply and operating permissions | Hardware/Systems owners and physical-operation authority | Inventory, delivery dates, applicable test capability and approved operating envelope |
| Requirements, interfaces and process obligations | Product/Systems and software assurance authority | Versioned decisions resolving open assumptions and acceptance criteria |
| Scope completion | PM with interface owners and release authority | Sized phone UI, ERP link and release verification; confirmed exclusions and external dependencies |
| Commercial case | PM/commercial owner | Role rates, equipment quotes, model/operations budget and agreed comparison basis |

Start with setup, scheduler/interface contracts and the host simulation foundation. Run ready driver/storage work in parallel, then controls, recipes, lifecycle and interfaces in dependency order. Bring target owners online as stations become ready and integrate accepted changes continuously.

The first wave should deliver independent software packages through review and integration, plus a target cycle when hardware is ready. Record human touch time, agent execution, review/integration queues, rework, defects and target occupancy against the model's phases. Use those observations to re-estimate the remaining graph while product development continues.

## Deliverables and recalculation

- [Ticket-level estimate and schedule](20261117_fleet-estimate-and-schedule.md), [machine-readable results](20261117_fleet-model-results.json) and [phase schedule CSV](20261117_fleet-task-schedule.csv).
- [Presentation source](20261117_fleet-pitch-content.md), [editable PowerPoint](20261117_fleet-pitch.pptx) and [PDF presentation](20261117_fleet-pitch.pdf).
- [Source ticket inputs](20261117_traditional-ticket-inputs.json), [scenario assumptions](20261117_fleet-scenario-assumptions.json) and [new work-package allowances](20261117_fleet-work-package-estimates.json).

Recalculate the model with `uv run planning/fleets/20261117_fleet-model.py`. Rebuild the deck with `uv run planning/fleets/20261117_build-fleet-pitch.py --skill-dir /path/to/pi-pptx/skills`, using the PI template assets supplied by that skill. Re-export the updated deck to PDF using PowerPoint or LibreOffice. Changes to requirements, scope, resource dates or estimate assumptions require a new model run and refreshed pitch figures.

## Verification record

The model completed internal checks over **three primary scenarios, 19 sensitivity cases and the 25% allowance stress case**. Checks covered source-ticket coverage, precedence, review order, resource non-overlap, per-slot commissioning, continuous same-target reservations, physical durations, effort accounting and completion of every sized package. Independent source review closed the identified scheduling/accounting findings.

The **12-slide PowerPoint** was generated from the current model results and opened/exported by **LibreOffice 24.2**. All **12 rendered PDF pages** were visually inspected. The PPTX XML parses, current scenario/sensitivity figures are present, local document links resolve and deployment-detail checks pass. The deck specifies Calibri; this host substitutes Noto Sans in the preview. Native Microsoft PowerPoint rendering was not checked.

No trolley firmware, hardware station or live fleet was built, commissioned or tested during this planning work. These checks cover the planning model and presentation, not fleet productivity, physical test outcomes or delivery performance.
