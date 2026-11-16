# Smart Trolley: accelerated agent fleet delivery proposal

Written: 2026-11-17
Repository basis: `6bddf77`, plus the accompanying dated estimate inputs and model.
Status: planning forecast for executive, PM and software RGM review. Estimates are judgement allowances, not measured fleet performance or a delivery commitment.

## Recommendation

Replan the existing **101.4 Engineer-day** software scope around a project-specific omp-connected fleet. Use a main hub/development computer, parallel workers with bounded deliverables, independent review and dedicated target-owning agents. Add distributed hardware-access computers where the physical equipment or capacity requires them. Keep engineers focused on contracts, decisions, integration, acceptance and exceptions rather than manually relaying every build/test cycle.

Use the target scenario as the working delivery hypothesis, the cautious scenario to expose constrained delivery, and the stretch scenario as the opportunity when resources and decisions are ready. Approve the initial capacity and operating controls, then use actual delivery evidence to update the forecast. Do not treat a scenario as a confidence percentile or a guarantee.

## Quantified forecast

| Scenario | Engineer days, including setup and coordination | Principal days | Additional operator days | Elapsed working weeks |
|---|---:|---:|---:|---:|
| Traditional estimate | 101.4 | 15.2 | Not recorded | 21.5, draft source schedule |
| Cautious fleet | 38.2 | 16.6 | 4.4 | 17.4 |
| Target fleet | 28.7 | 12.7 | 4.4 | 11.0 |
| Stretch fleet | 25.4 | 12.2 | 4.4 | 9.4 |

The target releases **72.7 Engineer days, about 72% of the baseline engineering allocation**, and forecasts **about half the elapsed time** of the source schedule. It includes 7.5 Engineer/2.4 Principal days of one-off setup, plus ongoing coordination. This comparison covers the 30 sized packages and setup, before the unsized ERP link, phone UI and release verification. It is not a full-release date or an automatic cash saving.

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

These are calculated relative offsets, not calendar commitments. Dry-out-before-integration is an explicit fleet risk-reduction policy added to the source graph. The resource model holds each target continuously from manual preparation through its run and observation, on the same commissioned station; the operator is occupied only for the manual preparation portion.

### What changes the forecast

The most important sensitivity is **human review**, not worker count. Retaining the original 15.2 Principal days for sized-ticket review increases the target schedule to **14.0 weeks**. A 25% increase in new human/execution allowances gives **12.8 weeks**. Halving operator availability gives **13.7 weeks**; increasing operator availability to 0.5 FTE gives **10.2 weeks**. Extending the assumed soak from five to ten working days adds one week.

Increasing execution slots from three to six or ten does not shorten this model's target schedule: review, physical work and dependencies dominate. Provision expandable capacity, start with the ready workload and avoid buying machines merely to increase agent count. The third basic board in the stretch configuration is commissioned but unused by its selected schedule; additional hardware purchases need an actual contention case.

Hardware-delay effects are separate: moving all resource-readiness dates 25 working days later changes the target to **14.4 weeks**. Initial decision allowance and physical dates can overlap setup, so delays do not necessarily add one-for-one to the finish. All primary scenarios use the same physical readiness and one shared prototype/plant plus one production fixture.

## Comparison boundary

The like-for-like engineering comparison uses the user-confirmed **101.4 Engineer days**, with **15.2 Principal engineer days** accounted for separately. The source also models **21.5 elapsed weeks** under draft team/loading assumptions. That elapsed figure is an indicative report comparator, not an observed sequential-agent control or an equal-resource experiment.

The 30 displayed sized-ticket values sum to **101.5 days** because the report cards and schedule totals differ by 0.1 day. The model retains the individual displayed values for traceability and uses 101.4 for savings. It does not silently adjust ticket estimates to match a headline.

The ERP link, phone UI and release verification are three original unsized tickets. They remain visible but outside the sized-scope savings and finish milestone. AX-mini software, ERP-side software, PC authoring/fleet-view software and air-generation plant were excluded from the original estimate. The model cannot establish a full product release date until the unsized work, external dependencies and release process are resolved. A sized-scope finish includes every one of the 30 sized packages and fleet commissioning, not permission to ship.

The source has Test engineer 50% in its illustrative staffing model without a recovered explicit test-role effort total. This proposal does not invent a saving for that role. New hands-on operator effort is estimated separately and scheduled against 0.25 FTE: physical fixture preparation and manual verification do not become free agent work. Engineer/Principal effort separately covers technical intervention and acceptance. Actual role assignment must be agreed.

Scenario capacities are independently available role pools, not assumed headcounts. If the same person covers Engineer and operator duties, their allocations must fit that person's availability and the schedule must prevent conflicting assignments. The target's 0.80 Engineer, 0.35 Principal and 0.25 operator allocations sum to 1.40 FTE; approving the scenario requires identifying who supplies each allocation.

## How the acceleration works

The fleet changes both touch time and waiting time. Workers implement and host-test independent packages against shared contracts. Separate reviewers challenge behaviour and evidence. Hardware-owning workers execute authorised build, program, capture, diagnose and retest cycles without an engineer dispatching every step. Shared context preserves decisions and accepted findings while each worker gets the context needed for its deliverable.

The source dependencies remain visible. Host-testable packages can unlock other host work after host acceptance, with separate physical confirmation tracked where required. Hardware-dependent work only unlocks its successors after target acceptance. Prototype integration also waits for the functional target checks added by the fleet verification model. These added acceptance dependencies are model assumptions, not claims that the source graph contained them.

The largest opportunity is in the **76.4 Engineer days classified before hardware**. That does not make the remaining 25.0 hardware-associated days irreducible human effort: an owned test agent can automate repeatable execution. It does mean that target availability and physical test duration remain separate constraints. More software workers cannot shorten a required soak or establish a missing client decision.

## Estimate method

The [work-package allowances](20261117_fleet-work-package-estimates.json) estimate Engineer involvement, Principal review, agent implementation, independent agent review and active target occupancy for each sized package. These are direct new workflow estimates, not the original days divided by agent count. Control tuning, recovery, safe state and integration receive larger human/target allowances than simpler storage or configuration work.

The [scenario assumptions](20261117_fleet-scenario-assumptions.json) vary agent slots, basic board-station count, human capacity and software execution/rework allowances. All primary scenarios have the same physical readiness assumptions: boards at working day 5, one prototype/plant station at day 10 and one production fixture at day 10. Hardware timing effects are shown separately. Working days use an eight-hour capacity day and five-day week; no overnight/weekend gain is assumed. An agent slot is an occupied execution resource, not an engineer or unlimited machine capacity.

Fleet setup is additional scope: main environment provisioning and per-station commissioning are counted once. Recurring cross-fleet coordination reserves 0.10 Engineer FTE and 0.02 Principal FTE within the scenario's human allocation. Those reserves reduce capacity available for task phases, and their elapsed-period effort is included in savings. Task-specific briefing, intervention and acceptance remain in the ticket estimates.

Raw Principal ticket allowances are increased by 50% for explicit human review of every merge plus decisions. The stretch scenario does not reduce that review allowance, target-active duration, physical acceptance effort or operator effort. A sensitivity retaining the original 15.2 Principal days of ticket review exposes the effect of an optimistic review estimate. A common two-day initial decision allowance is included; later unresolved stakeholder decisions remain additional risk.

Physical observation allowances are **five working days for system soak** and **two for dry-out observation**, held constant across all scenarios. These are unconfirmed planning allowances, not recovered test requirements or measured biological durations. The test authority must replace them with approved durations. The model reserves a target continuously during each observation rather than treating the target as available to other jobs.

Extended offline logging/replay observation is included in the system-soak procedure as a model assumption to confirm with the test authority. Short disconnect, recovery and forced-fault checks also retain explicit target/operator time. The setup allowance includes authority assignment, project security review, versioned task/evidence/reservation records, controlled target access and initial forecast analysis. Exclusivity relies on dedicated target-owning access and serialised operation, not native ompc hardware locks.

The [reproducible model](20261117_fleet-model.py) expands tickets into human, implementation, review and target phases, then schedules against finite resource calendars. It reports a deterministic feasible list schedule, not a proven optimal schedule. Dependency-only path length and resource-limited finish are different outputs. Sensitivities isolate hardware readiness, worker concurrency, Engineer capacity, physical duration and larger execution/human allowances.

## Fleet setup and resources

The [setup ticket](20261117_fleet-setup-ticket.md) supplies the main hub/development computer and optional distributed computers for hardware access. The scenarios assume a suitable main machine is available at the start; purchasing delays are not hidden inside engineer effort. There is no assumed need for local GPU inference. The commissioning check must establish usable session/build concurrency, provider quotas, storage and service availability, particularly with hub and workers on the same computer.

Target resources are typed. Development boards cover basic firmware/peripheral checks; the shared prototype with plant covers controls, physical lifecycle, integration, dry-out and soak; the production fixture covers provisioning. A prototype run holds that shared pool exclusively. More basic boards do not allow concurrent destructive tests on the one trolley. Record supplier, readiness, stable identity, responsible human, target-owning worker and access rules for each resource.

Add execution host, target/fixture, occupancy, agent capacity, human input, readiness date and evidence requirements to the existing tickets. Do not repeat shared provisioning costs in each ticket. Software work can start when the main environment is ready; each hardware station gates only its own dependent work.

Existing ompc provides session visibility, messaging, capable-host session launch/control and configuration primitives. Durable task state, dependency dispatch, independent review policy, evidence provenance and hardware reservation are project workflow requirements. They must be provided or verified; this proposal does not claim they are native ompc features. Generic platform development is not included implicitly in commissioning allowances. Any necessary new platform work must be estimated and added before accepting the schedule.

## Assurance and delivery gates

Use the [execution and assurance plan](20261117_fleet-execution-and-assurance.md). Assign human authorities for requirements, interfaces, physical operation, engineering acceptance and release. Initially require human review of every merge. Later automation is limited to explicit approved low-risk classes with recorded boundaries; consequential decisions and release stay with authorised humans. Different models can strengthen cross-review but cannot replace runnable evidence or establish independence by themselves.

Mandatory physical checks remain: dry-out behaviour, software-stopped fail-safe venting/lights-off, offline logging/replay, outage recovery, every-channel commissioning including faults, integration and soak. The open process/safety classification must be resolved before final assurance sizing. AI-inference-only requirements and open control/interface decisions must be reviewed by their accountable humans.

Every accepted task carries source/image revision, relevant requirement/decision revisions, branch, target configuration, commands/procedures, results and reviewer disposition. Hub message receipt proves neither task completion nor approval. Task and reservation state must survive outside the hub mailbox. Reconcile worker/host loss and physical state before reassigning or repeating operations.

## Economics

Report human effort savings separately from calendar acceleration. Monetary benefit depends on agreed role rates, equipment quotes, model consumption and recurring operating costs. No currency saving is asserted without those inputs.

For daily Engineer, Principal and operator rates E, P and O, the conservative sized-scope break-even allowance for additional equipment/service costs is:

`(101.4 - forecast Engineer days) × E + (15.2 - forecast Principal days) × P - forecast operator days × O`

The effort-based formula assumes people can use unoccupied capacity elsewhere and costs follow actual assigned work. If the project reserves each role for the whole delivery window, cost that commitment as `elapsed working days × assigned role FTE × daily rate` instead. Report both utilised effort and this reserved-capacity envelope before claiming a cash saving. The baseline's unagreed focus/loading assumptions also need commercial confirmation; reduced touch time is not automatically an equal reduction in invoice or salary cost.

| Target charging basis | Engineer days | Principal days | Operator days |
|---|---:|---:|---:|
| Forecast utilised effort, including setup/coordination | 28.7 | 12.7 | 4.4 |
| Whole-window reserved capacity | 44.1 | 19.3 | 13.8 |

The reserved-capacity envelope uses 55.2 working days at the stated 0.80/0.35/0.25 role allocations, calculated before rounding. It is an alternative charging basis, not additional effort to add to the utilised estimate.

Forecast human days already include setup and recurring coordination; do not subtract those costs again. Deduct additional equipment, model/service usage and other incremental operating costs from that allowance to calculate net cost saving. Existing equipment reuse is not new capital expenditure; also do not assume existing compute/provider capacity has no opportunity cost. Unchanged external costs cancel only when the scope and procurement basis genuinely match. No Test-engineer monetary saving is included without its baseline.

## Evidence behind the proposal

The [distilled research and capability map](20261116_fleet-research-and-capabilities.md) and [source inventory](20261116_agent-orchestration-sources.md) connect the design to published practice: Anthropic's parallel orchestration, Shopify's executable verification and shared context, Stripe's human merge review, Uber's attribution and event-driven workflow examples. These are mostly first-party accounts and concern different environments.

They support the operating mechanisms; they do not establish this project's numerical forecast. Anthropic's 90.2% internal research-evaluation result is not used as a coding-speed multiplier. Unresolved podcast figures are not used as business-case evidence. The original temporary report capture is now absent; source ticket IDs, estimates and dependencies were recovered from the prior visible extraction record. The [normalised input](20261117_traditional-ticket-inputs.json) records that provenance and the fields not recovered.

## Decisions and first execution wave

| Decision | Accountable role | Evidence that closes it |
|---|---|---|
| Working scenario, human availability and initial capacity | Project lead with PM and engineering management | Agreed allocations, model/provider budget and main-machine capacity |
| Hardware/station supply and operating permissions | Hardware/Systems owners and physical-operation authority | Inventory, delivery dates, applicable test capability and approved operating envelope |
| Requirements, interfaces and process obligations | Product/Systems and software assurance authority | Versioned decisions resolving open assumptions and acceptance criteria |
| Scope completion | PM with interface owners and release authority | Sized phone UI, ERP link and release verification; confirmed exclusions and external dependencies |
| Commercial case | PM/commercial owner | Role rates, equipment quotes, model/operations budget and agreed comparison basis |

Start with setup, scheduler/interface contracts and the host simulation foundation. Release ready driver/storage work in parallel, then controls, recipes, lifecycle and interfaces according to the recovered graph. Bring target owners online as stations become ready. Integrate accepted changes continuously rather than waiting for all workers to finish.

The first useful wave should include independent software deliverables, review and integration, plus a target cycle when hardware is ready. Record actual human touch time, agent execution, review/integration queues, rework, defects and target occupancy against the model's phases. Re-estimate the remaining graph from those observations. The wave delivers product work; it is not a separate research gate before starting development.

## Deliverables and recalculation

- [Ticket-level estimate and schedule](20261117_fleet-estimate-and-schedule.md), [machine-readable results](20261117_fleet-model-results.json) and [phase schedule CSV](20261117_fleet-task-schedule.csv).
- [Presentation source](20261117_fleet-pitch-content.md), [editable PowerPoint](20261117_fleet-pitch.pptx) and [PDF presentation](20261117_fleet-pitch.pdf).
- [Source ticket inputs](20261117_traditional-ticket-inputs.json), [scenario assumptions](20261117_fleet-scenario-assumptions.json) and [new work-package allowances](20261117_fleet-work-package-estimates.json).

Recalculate the model with `uv run planning/fleets/20261117_fleet-model.py`. Rebuild the deck with `uv run planning/fleets/20261117_build-fleet-pitch.py --skill-dir /path/to/pi-pptx/skills`, using the PI template assets supplied by that skill. Re-export the updated deck to PDF using PowerPoint or LibreOffice. Changes to requirements, scope, resource dates or estimate assumptions require a new model run and refreshed pitch figures.

## Verification record

The model ran successfully with internal checks over three primary scenarios, 19 sensitivity cases and the 25% allowance stress case. Checks cover source-ticket coverage, precedence, review order, resource non-overlap, per-slot commissioning, continuous same-target reservations, physical durations, effort accounting and completion of every sized package. Independent source review closed the identified scheduling/accounting findings.

The 12-slide PowerPoint was generated from the current model results and opened/exported by LibreOffice 24.2. All 12 rendered PDF pages were visually inspected. The PPTX XML parses, current scenario/sensitivity figures are present, local document links resolve and deployment-detail checks pass. Calibri is specified in the deck; this host substitutes Noto Sans for the preview. Native Microsoft PowerPoint rendering was not checked.

No trolley firmware, hardware station or live fleet was built, commissioned or tested during this planning work. The verification above checks the planning model and presentation, not the proposed productivity, physical test outcomes or delivery forecast.
