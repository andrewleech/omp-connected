# Handover: Smart Trolley agent fleet research, estimate and pitch

Written: 2026-11-17
Source revision: `f722327`.
Status: research, forecast and stakeholder material completed. Delivery resources, operating permissions and the project schedule still require human agreement.

## Resume here

Start with the [proposal report](20261117_fleet-proposal-report.md) for the recommendation, forecast, decision owners and comparison limits. Use the [PDF pitch](20261117_fleet-pitch.pdf) for stakeholder discussion. Use the [scenario assumptions](20261117_fleet-scenario-assumptions.json), [work-package estimates](20261117_fleet-work-package-estimates.json) and [detailed schedule](20261117_fleet-estimate-and-schedule.md) when changing the plan.

The next delivery step is to agree the working scenario, assign human authorities and confirm the main computer and hardware resources. Then commission the fleet and deliver the first bounded work packages, recording actual effort and accepted results to update the forecast. Further source research is needed for unresolved claims, but it need not hold unrelated product work.

The main package is in `planning/fleets/`. Three supporting research notes remain outside this folder and are currently untracked. The original temporary podcast transcript and project-report capture are no longer present. Their retained evidence and the portability limits are indexed below.

## Purpose and user direction

The activity began by extracting practices from the podcast transcript “Rethinking Agents, Plus Show Updates”. The requested topics were agent orchestration, independent cross-review, different levels of human review, event signals, and shared context or memory described as “content maxing”. The next request was to locate the external sources behind those sections and distinguish supported findings from transcript claims.

The intended application is an executive, PM and software RGM pitch for a highly accelerated Smart Trolley software plan. The traditional approach was described as one or two engineers, each using a personal coding agent. The proposed fleet uses a project-specific omp-connected environment across developer machines and dedicated hardware-in-the-loop (HIL) instances with direct, controlled ownership of hardware.

The user confirmed **101.4 Engineer days** as the comparison baseline and asked for a dramatic reduction through a well-operated fleet. Principal effort, calendar time and operator work remain separate quantities. A further setup ticket was added for a main hub/development computer, with other computers where distributed hardware access or capacity requires them. Resource requirements belong on the consuming tickets; shared setup is counted once.

All reports, planning prose, slides and speaker notes received an explicit `/writing-style` pass. The rewrite retained the estimates, evidence limits and approval boundaries. It changed no numerical input, result or phase-schedule file.

## Current forecast and its boundary

| Case | Engineer days | Principal days | Additional operator days | Elapsed working weeks |
|---|---:|---:|---:|---:|
| Traditional estimate | 101.4 | 15.2 | Not recorded | 21.5, draft source schedule |
| Cautious fleet | 38.2 | 16.6 | 4.4 | 17.4 |
| Target fleet | 28.7 | 12.7 | 4.4 | 11.0 |
| Stretch fleet | 25.4 | 12.2 | 4.4 | 9.4 |

Fleet Engineer and Principal totals include product work, one-off setup and ongoing coordination. The target releases about 72.7 Engineer days, or 72% of the baseline allocation. Its elapsed forecast is about 49% below the source's draft 21.5-week schedule. These are judgement estimates awaiting project evidence. The source schedule has different, unagreed staffing and loading assumptions.

The finish covers **all 30 sized tickets plus fleet setup**, before the unsized ERP link, phone UI and release verification. It sets no full product release date. AX-mini software, ERP-side software, PC recipe-authoring/fleet-view software and air-generation plant remain outside the original estimate.

The source's displayed ticket values sum to **101.5 Engineer days**, against the **101.4-day** schedule total. The model retains this discrepancy. The older **117 person-day** headline combines rounded role figures and must not replace the engineering baseline. The source staffing model includes Test engineer 50%, but a test-role effort total was not recovered, so no saving is claimed for that role.

### Main findings from the calculated cases

- Retaining the original 15.2 Principal days for ticket review moves the target forecast to **14.0 weeks**. Human review is a material assumption.
- Increasing the new human/execution allowances by 25% gives **12.8 weeks**. Halving operator capacity gives **13.7 weeks**; increasing it to 0.5 FTE gives **10.2 weeks**.
- Increasing the soak allowance from five to ten working days adds one week. Moving all physical-readiness dates 25 working days later gives **14.4 weeks**.
- Increasing execution slots from three to six or ten does not shorten the target schedule in this model. The third basic board in the stretch case is commissioned but unused. Extra agents and equipment need a contention case before purchase.

The [proposal report](20261117_fleet-proposal-report.md) owns the stakeholder interpretation and economics. The [results JSON](20261117_fleet-model-results.json) owns the calculated values.

## Complete index of this folder

There are 19 activity artefacts alongside this handover. “Authored” means edit the file directly. “Generated” means change its inputs or generator and rebuild it.

### Research and capability evidence

| File | Contents and use | Maintenance |
|---|---|---|
| [20261116_agent-orchestration-evidence.md](20261116_agent-orchestration-evidence.md) | Timestamped transcript notes on orchestration, cross-review, human accountability, signals and context/memory. Preserves the questions that started the investigation. | Authored evidence record. Transcript claims retain their original uncertainty. |
| [20261116_agent-orchestration-sources.md](20261116_agent-orchestration-sources.md) | External-source matrix, URLs, the claims each source supports, confidence limits and unresolved examples. Main bibliography for the activity. | Authored source inventory. Recheck the full source before upgrading an unresolved claim. |
| [20261116_fleet-research-and-capabilities.md](20261116_fleet-research-and-capabilities.md) | Distilled operating decisions, source-backed ompc capability map, external-tool boundaries, proposed additions and links to implementation evidence. | Authored synthesis. Revalidate implementation claims against the current code before deployment or further platform work. |

### Traditional project baseline

| File | Contents and use | Maintenance |
|---|---|---|
| [20261116_smart-trolley-traditional-baseline.md](20261116_smart-trolley-traditional-baseline.md) | Source scope, work-package estimates, dependencies, hardware needs, mandatory checks, open decisions, estimate discrepancies and source locators. Includes the recovery revalidation. | Authored baseline record. Keep source facts separate from new planning assumptions. |
| [20261117_traditional-ticket-inputs.json](20261117_traditional-ticket-inputs.json) | All 33 recovered ticket-card records with exact source IDs, titles, displayed estimates, hardware classes and dependencies. Also records totals, mandatory checks and recovery limits. | Normalised source input. Preserve provenance and the three unsized records. |

### Proposal, setup and operating controls

| File | Contents and use | Maintenance |
|---|---|---|
| [20261116_smart-trolley-fleet-pitch.md](20261116_smart-trolley-fleet-pitch.md) | Initial pitch framing, audience decisions, candidate delivery lanes and links to the quantified package. | Authored framing brief. Use the newer report for the calculated business case. |
| [20261117_fleet-proposal-report.md](20261117_fleet-proposal-report.md) | Main stakeholder report: recommendation, scenario comparison, target milestones, sensitivities, resource plan, economics, decision owners and verification record. | Authored report. Its figures require manual synchronisation after a model change. |
| [20261117_fleet-setup-ticket.md](20261117_fleet-setup-ticket.md) | Additional setup scope, resource fields for existing tickets, dependencies, acceptance evidence and provisional setup allowances. | Proposed ticket, not entered into the source project tracker. Confirm its owner, resources and estimates before scheduling. |
| [20261117_fleet-execution-and-assurance.md](20261117_fleet-execution-and-assurance.md) | Coordinator, worker, reviewer and hardware-owner roles; integration ownership; human approval modes; task/evidence contracts; context freshness; signals; HIL controls and loss recovery. | Authored operating proposal. Role assignments and automation classes still need human approval. |

### Forecast inputs, calculation and outputs

| File | Contents and use | Maintenance |
|---|---|---|
| [20261117_fleet-scenario-assumptions.json](20261117_fleet-scenario-assumptions.json) | Scenario capacity, new-work multipliers, typed hardware readiness, physical-duration allowances, human review policy, setup activities, coordination reserves and missing cost inputs. | Authoritative forecast assumptions. These are proposed values, not measured capacity. |
| [20261117_fleet-work-package-estimates.json](20261117_fleet-work-package-estimates.json) | Direct new-work allowances for each sized package: Engineer and Principal effort, agent execution/review, target time, station type and separate operator effort. | Authoritative ticket-level forecast estimates. Calibrate against accepted project work. |
| [20261117_fleet-model.py](20261117_fleet-model.py) | Reproducible phase/dependency scheduler, resource calendars, scenario and sensitivity calculations, invariants and generated report prose. | Calculation implementation. Preserve the source-ID mapping, resource constraints and accounting checks when editing. |
| [20261117_fleet-model-results.json](20261117_fleet-model-results.json) | Full primary-scenario totals, milestones, ticket summaries, phase records and resource metrics, plus compact sensitivity/stress results and provenance. | Generated. Detailed phase traces are retained for the three primary cases; sensitivity results omit duplicated traces. |
| [20261117_fleet-estimate-and-schedule.md](20261117_fleet-estimate-and-schedule.md) | Human-readable scenario inputs/results, effort breakdown, per-ticket comparison, setup, milestones, phase schedule, resource limits and sensitivities. | Generated by `build_report()` in the model script. |
| [20261117_fleet-task-schedule.csv](20261117_fleet-task-schedule.csv) | Primary-case phase records: `scenario,ticket,phase,start,finish,resource`. Times are working-day offsets. | Generated. Use JSON for blocking predecessors and reservation detail absent from this CSV. |

### Presentation

| File | Contents and use | Maintenance |
|---|---|---|
| [20261117_build-fleet-pitch.py](20261117_build-fleet-pitch.py) | Slide copy, speaker notes, model-value selection, native comparison/milestone/sensitivity tables and PI-template build steps. | Authoritative presentation source. Edit copy in `content_for()` and table labels in the build code. |
| [20261117_fleet-pitch-content.md](20261117_fleet-pitch-content.md) | Generated slide directives, text and speaker notes for the template pipeline. | Generated. Native table data is added by the Python generator, so this file alone is not the full presentation build. |
| [20261117_fleet-pitch.pptx](20261117_fleet-pitch.pptx) | Editable 12-slide stakeholder pitch with notes and native tables. | Generated from current results and PI assets. Direct edits will be overwritten by the next build. |
| [20261117_fleet-pitch.pdf](20261117_fleet-pitch.pdf) | Rendered 12-page presentation for review and sharing. | Exported from the PowerPoint. Refresh after every deck change. |

This document, [20261117_fleet-activity-handover.md](20261117_fleet-activity-handover.md), is the activity index and resumption guide. It records the state at the source revision above rather than serving as another forecast input.

## Evidence outside this folder

### Supporting research notes

These three files were found in the working checkout. None is tracked by git at this handover's source revision. Carry them separately if transferring the checkout, or retain the consolidated source inventory here as the portable starting point. They contain source notes, not complete archived copies of the articles.

| Relative repository path | Evidence collected | Limits and relationship to this package |
|---|---|---|
| [context/research/agent-context-and-ai-teammate/primary-sources.md](../../context/research/agent-context-and-ai-teammate/primary-sources.md) | OpenAI AI-native company workflows, the HBR AI-employee-framing study and Anthropic's marketing workflow. | Supports the context and scrutiny discussion. The exact HBR experimental conditions and 16% result remain unverified in retrieved text. |
| [context/research/agent-orchestration-2026/enterprise-agent-sources.md](../../context/research/agent-orchestration-2026/enterprise-agent-sources.md) | OpenAI enterprise signals, Runlayer Agents, Every's shared-agent account and Ramp Inspect. | Mainly first-party reports or product claims. Token usage and trigger support do not establish productivity or this project's savings. |
| [context/research/agent-orchestration-2026/anthropic-multi-agent-research.md](../../context/research/agent-orchestration-2026/anthropic-multi-agent-research.md) | Anthropic's orchestrator/worker research system and reported 90.2% internal-evaluation improvement. | Research-system evidence, not an independent evaluation or a coding-speed multiplier. |

### Implementation evidence

The capability assessment used the repository's [README](../../README.md), [hub architecture](../../hub/ARCHITECTURE.md), [extension architecture](../../extension/ARCHITECTURE.md) and the implementing code. The [capability map](20261116_fleet-research-and-capabilities.md#source-pointers-and-reliability-limits) records the detailed pointers, including:

- [Agent registry](../../hub/src/server/agent-registry.ts): identity, messages, mailboxes and bounded events.
- [Extension entry and tool registrations](../../extension/src/index.ts): exposed tools, capabilities and session integration.
- [Host sessions](../../extension/src/host-sessions.ts): connected-host launch/history prerequisites and session ownership safeguards.
- [Scheduled prompts](../../extension/src/scheduled-prompts.ts): session-owned delayed/idle prompt queues.
- [Session RPC routes](../../hub/src/server/session-rpc-routes.ts): session file access and control routes.

These are source-inspection references. No fleet deployment was commissioned to establish production behaviour during this activity.

### Temporary and session-local evidence

| Item | Availability at handover | Retained evidence |
|---|---|---|
| `/tmp/transcript.html` | Absent. Original automatically generated podcast transcript. | Timestamped notes and external-source matrix in this folder. The full original HTML is not archived here. |
| Original `smart-trolley-sw` MHTML capture, initially under `/tmp` | Absent. Capture dated 2026-11-16; source estimate dated 2026-11-06. | Baseline Markdown and normalised ticket JSON. The original capture path and recovery limits are recorded in the JSON provenance. |
| `local://trolley-recovered-tickets.json` | Available in this runtime. Session-local recovery of the 33 ticket cards from the earlier visible extraction record. | The normalised ticket JSON is the portable repository equivalent. Do not make a future build depend on this internal URI. |
| Independent review messages and one-off verification output | Retained in the work session, not exported as standalone logs. | Review findings, corrections and exercised checks are summarised below and in the report. |
| Per-slide PNG previews and temporary LibreOffice profiles | Removed after inspection. | Final PowerPoint and PDF remain. All 12 final PDF pages were inspected. |
| Mounted pod tool descriptions | Available in the original tool environment; not an ompc implementation or project hardware result. | The capability map records their role and limits, including single-client REPL access and stale USB/IP export handling. |

No trolley firmware images, UART/logic-analyser captures, live HIL test results, machine procurement quotes or project-specific measured fleet-throughput data were produced. The linked primary articles remain external sources; the source matrix records where claims were only partly retrieved or matched.

## Source quality and unresolved research

The podcast transcript was automatically generated and supplied investigation leads. The external-source search located company reports and product documentation behind many examples. Most are first-party accounts. The evidence supports practices to try, while the numerical project forecast comes from the new estimates and resource model.

Keep the following distinctions when presenting or extending the work:

- Anthropic's 90.2% result concerns an internal research evaluation. It is neither a general accuracy score nor this project's acceleration factor.
- Uber's attribution chain records responsibility through delegated work. It does not establish human approval of every action.
- Shopify's verification example tests candidate findings. Candidate counts include false positives.
- Ramp's policy approvals are bounded by configured policy. They do not establish unrestricted autonomy.
- Token volume, available tools and number of agent runs are not measures of accepted delivery.

Open source leads include “Orp”, the exact Ramp memory-refresh pipeline, Uber's 30-plus-system context-graph claim, Hebbia's knowledge-hoarding claim, Runlayer's precise signal/review sequence, Snap's investment percentage, Ramp/Uber skill counts and the HBR study's exact labels and 16% result. The [source inventory](20261116_agent-orchestration-sources.md) is the list to maintain. Resolve these against primary text, audio or show notes before using them as pitch facts.

## What was completed

| Stage | Work and decision | Result to retain |
|---|---|---|
| Transcript extraction | Captured orchestration, cross-review, human review, signals and context/memory sections. | Timestamped evidence notes with transcript-error caveat. |
| External-source research | Located related articles, reports, product pages and a security talk. | Source matrix and supporting research notes, with unresolved claims kept open. |
| Project baseline | A sonic worker distilled the large traditional report. | Scope, estimates, graph, physical requirements and missing decisions separated from interpretation. |
| Baseline correction | Adopted the user's 101.4 Engineer-day comparison rather than the combined 117-day headline. | Principal effort and elapsed schedule kept separate. |
| Capability assessment | Inspected ompc documentation and implementing code. | Existing connection/control primitives distinguished from proposed workflow and external hardware tools. |
| Setup scope | Added main hub/development computer setup and optional distributed hardware-access computers. | One shared setup ticket plus resource requirements on consuming tickets. |
| Ticket recovery | Recovered all 33 card records after the temporary MHTML disappeared. | Portable JSON with exact IDs/dependencies and explicit missing-field limits. |
| Re-estimate and schedule | Added direct per-ticket allowances, finite resources, setup/coordination and sensitivities. | Reproducible model and three primary delivery cases. |
| Independent review | Corrected accounting, phase precedence, typed hardware resources and reservation/dispatch defects. | Current calculation constraints and verification described below. |
| Stakeholder package | Wrote the report, operating plan, setup ticket and 12-slide pitch. | Authored and generated files are separated in the index. |
| Writing-style rewrite | Rewrote report, supporting prose, slides and notes using `/writing-style`, followed by a separate deletion pass and independent review. | Numerical files stayed byte-for-byte unchanged; updated outputs were rebuilt and inspected. |

## Forecast model: maintenance notes

### Source facts versus new assumptions

`20261117_traditional-ticket-inputs.json` preserves the recovered source. Its `tickets`, `estimate`, `provenance`, verification and count sections describe the traditional plan. Detailed per-card acceptance text, AI-speedup labels and exact work-package heading text were not recovered. The full source report and approved acceptance criteria should be obtained before dispatching work that needs those details.

`20261117_fleet-work-package-estimates.json` supplies the new judgement allowances. `rows` follows the declared `columns`; the station and operator maps assign physical resource needs. These are estimates of a changed workflow, not original effort divided by worker count.

`20261117_fleet-scenario-assumptions.json` supplies capacity, readiness and policy. The model asserts the current 101.4 Engineer-day and 15.2 Principal-day baselines. Changing that comparison basis requires an explicit model revision as well as agreement on the new source.

### Scenario resources

| Input | Cautious | Target | Stretch |
|---|---:|---:|---:|
| Agent execution slots | 3 | 6 | 10 |
| Basic development-board stations | 1 | 2 | 3 |
| Engineer allocation, FTE | 0.60 | 0.80 | 1.00 |
| Principal allocation, FTE | 0.25 | 0.35 | 0.45 |
| Operator allocation, FTE | 0.25 | 0.25 | 0.25 |
| New software execution allowance multiplier | 1.40 | 1.00 | 0.80 |
| New human allowance multiplier | 1.30 | 1.00 | 0.85 |

All cases share one prototype/plant station and one production fixture. Basic boards are assumed ready on working day 5, the prototype and fixture on day 10, and the main computer at the start. Readiness is unconfirmed. Change hardware timing through the typed `physical_resources` dates; those drive the scheduler, rather than changing only the case-level `hardware_ready_workday` value.

Agent slots are execution capacity shared by implementation, independent agent review and setup jobs. `target_slots` means basic board stations, not interchangeable prototype trolleys. A station requires usable hardware, attached peripherals and authorised access, regardless of computer count.

Human pools assume independently available capacity. If one person covers multiple roles, fit the allocations to that person's actual availability and prevent conflicting assignments before accepting the forecast.

### Accounting and scheduling rules

- Reserve 0.10 Engineer FTE and 0.02 Principal FTE within each scenario for coordination. Subtract them from task capacity, then include reserve × elapsed working days in effort. The target task calendars therefore use 0.70 Engineer and 0.33 Principal FTE.
- Principal ticket allowances include human approval of every merge and engineering decisions. The model applies the 1.5 review factor and keeps the base review allowance in stretch. Independent agent review is a separate execution phase.
- Keep active physical tests, operator effort and fixed observations at their base durations across primary cases. The soak sensitivity explicitly increases five working days to ten. The dry-out allowance is two working days. These are provisional physical-duration allowances.
- Count the 4.4 operator days separately. At 0.25 FTE they occupy more calendar time, but that is not more operator effort. No operator saving can be calculated from the recovered source.
- Count shared setup activities once. The `main_environment` aggregate checks the activity sum; it is not another charge. Count each board/prototype/fixture commissioning separately. The target setup total is 7.5 Engineer and 2.4 Principal days.
- Gate host work on the enabling setup activities, target work on its commissioned station and access controls, and forecast analysis on initial product work. Do not make every task wait for every station.
- Implementation precedes independent agent review, which precedes Principal review and host acceptance. Source dependencies release downstream host work at host acceptance, except a predecessor classified “With hardware” must reach target acceptance.
- Hold the same physical slot continuously from manual preparation through execution and observation. Reserve the operator only for manual preparation. Integration also waits for the required functional target checks, including alarms, events, self-test and early dry-out evidence.
- Dispatch at the earliest feasible start. For equal starts, prioritise station commissioning, then the longest remaining dependency chain and stable task ID. This produces a feasible list schedule, without establishing optimality.

The time basis is an eight-hour capacity day and five-day working week. Overnight and weekend productivity gains are not assumed. Relative workday offsets need a real start date, calendar and approved physical-test durations before conversion into calendar commitments.

### Economics

Forecast effort assumes unoccupied capacity can be used elsewhere. Whole-window reservation is a separate charging basis. For the target, utilised Engineer/Principal/operator effort is 28.7/12.7/4.4 days; the reserved-capacity envelope is 44.1/19.3/13.8 days at the stated allocations.

The report gives the break-even formula and comparison limits. Role rates, machine quotes and model/service costs are unconfirmed. Forecast role totals already include setup and coordination; subtracting those again would double-count them. No currency saving or staff reduction has been established.

## Existing capability versus proposed operation

ompc already supplies multi-host session visibility, messaging, teams, capable-host session launch/control, model/role configuration and session-owned scheduled prompts. The project workflow must supply or verify durable task state, dependency assignment, producer/reviewer separation, human dispositions, revision-linked evidence and hardware reservation.

The native omp subagent runtime and mounted pod tools are separate capabilities. Neither tool availability nor session launch leases establishes project-level hardware exclusivity or permission for physical actions. The setup proposal uses dedicated hardware owners, controlled access and serialised operation. Generic platform changes, if needed, require their own estimate.

The [execution and assurance plan](20261117_fleet-execution-and-assurance.md) owns the detailed controls. Start with human approval of every merge. Later low-risk automation needs recorded approval and operating evidence. Requirements, safety interpretations, physical exceptions, consequential acceptance and release retain human authorities. The coordinator has no authority to approve those decisions.

## Verification and review evidence

The completed model checks exercised three primary scenarios, 19 sensitivity cases and the 25% allowance stress case. They cover all 33 source records, the 30 sized-ticket mapping, dependency and review order, resource non-overlap, per-slot commissioning, continuous same-target reservations, physical-duration rules, effort totals and completion of all sized work/setup.

Independent calculation review identified issues that were corrected before the current results were accepted:

- Missing operator labour/capacity and incompatible hardware types were made explicit. Primary cases now share the same prototype/fixture supply assumptions, with hardware-delay sensitivities separate.
- Human merge review, one-off governance/security/durable records/access work and recurring coordination were included in accounting.
- Reviews were ordered after production. Physical preparation and observation were joined into one same-slot reservation while retaining only the manual prefix on the operator calendar.
- Integration was gated on the functional target evidence, including alarm/event/self-test checks and early dry-out confirmation.
- Per-slot commissioning and its dispatch priority were corrected so extra boards could be used when useful. Downstream-priority calculation was memoised.
- Monetary comparison was corrected for additional operator effort and to avoid subtracting setup/coordination twice. Sensitivity output was reduced to summaries without changing forecast values.

The writing-style review checked factual preservation as well as prose. Corrections kept the Engineer baseline separate from Principal effort, tied setup allowances to the target case, restored the coordinator's approval restriction and distinguished primary physical durations from the extended-soak sensitivity. All identified review findings were closed.

During the style pass, calculation code outside the report-writing function was compared structurally. Numerical input files, model results and the CSV stayed byte-for-byte unchanged. The regenerated PowerPoint retained the scenario figures. Local document links, source URLs where a tracked prior version existed, deployment-detail checks and PPTX XML parsing were checked.

The final 12-page PDF was exported with LibreOffice 24.2 and all pages were visually inspected. The deck specifies Calibri; the rendering host substituted Noto Sans. Native Microsoft PowerPoint rendering was not checked. These checks establish the state of the planning artefacts, not project throughput, product behaviour or physical safety.

## Rebuild and update procedure

### Prerequisites

- `uv` and Python 3.11 or later for the model. The model uses the standard library.
- The presentation generator's PEP 723 dependency, `python-pptx>=0.6.23`, resolved by `uv`.
- The external `pi-pptx` skill assets: `assets/PI_Template.pptx`, its build scripts and slide registry. They are not copied into this repository. Pass the skill directory as an argument rather than hard-coding a workstation path.
- LibreOffice for the PDF export used here, or Microsoft PowerPoint. Poppler's `pdftoppm` was used for temporary slide previews.

Run from the repository root:

```sh
uv run planning/fleets/20261117_fleet-model.py
uv run planning/fleets/20261117_build-fleet-pitch.py --skill-dir /path/to/pi-pptx/skills
libreoffice -env:UserInstallation=file:///tmp/fleet-pitch-profile --headless --convert-to pdf --outdir planning/fleets planning/fleets/20261117_fleet-pitch.pptx
```

The model writes the results JSON, detailed estimate Markdown and schedule CSV. The presentation generator reads the results JSON and writes the slide-content Markdown and PowerPoint. PDF export is a separate step.

To change the plan:

1. Record the agreed change, owner, source and reason. Keep the original source baseline and immutable Written dates. Add dated revalidation where the basis changes.
2. Change source inputs only when correcting or replacing an authoritative source. Put new fleet assumptions and work-package allowances in their respective JSON files.
3. Run the model and inspect totals, milestones, resource waits, exclusions and sensitivities. Internal checks should complete without an assertion failure.
4. Update manually authored figures and conclusions in the proposal report, setup ticket, framing brief and this handover where affected. They are not generated by the model.
5. Edit presentation copy/notes or table labels in the presentation generator, then rebuild the deck and export the PDF. Direct edits to generated Markdown or PowerPoint tables will be overwritten.
6. Check figures, links, scope and approval statements. Inspect all rendered pages and use `/writing-style` for stakeholder prose, including speaker notes. Check for deployment details before committing or publishing.

The template builder can warn that the three table slides have little body text before native tables are inserted. The final PowerPoint contains those tables. Judge the generated surface rather than treating the intermediate text-volume warning as missing content. Keep a temporary export profile and preview directory separate from user files, then remove them after inspection.

## Open decisions and next work

| Decision or work | Accountable role | What closes it |
|---|---|---|
| Working scenario and named capacity | Project lead, PM and engineering management | Actual Engineer, Principal and operator availability, approved model/service budget and initial machine capacity. |
| Source and acceptance recovery | Project lead and requirements owners | Original report/design inputs, full acceptance text and approval of inference-only requirements. Keep the recovery limits until then. |
| Unsized scope | PM, interface owners and release authority | ERP link, phone UI and release verification sized, with dependencies and release criteria. |
| Hardware readiness and type | Hardware/Systems owners | Board, prototype/plant and fixture inventory, suppliers, delivery dates, usable test capability and stable identities. |
| Physical permissions and test durations | Physical-operation and test authorities | Approved operating envelope, safe states, reset/program/actuation permissions, fault procedures, soak/offline/dry-out durations and evidence acceptance. |
| Control and interface choices | Product/Systems and software authorities | Pressure element, sensor topology, recipe/irrigation parameters, API/phone/ERP ownership and protocol decisions. |
| Process obligations | Software assurance authority | Confirmed safety/process classification and the assurance work needed for this product. Retain mandatory physical tests. |
| Setup and required platform gaps | Setup owner and technical lead | Main host and initial stations commissioned, task/evidence records and access controls demonstrated, any additional generic platform work separately estimated. |
| Commercial comparison | PM/commercial owner | Agreed rates, equipment quotes, model/operations budget and utilised-versus-reserved charging basis. |
| Forecast calibration | Coordinator and engineering lead | A delivery wave containing independent host work, review/integration and a target cycle when ready, with measured touch time, rework, queues, costs and accepted evidence. |
| Unresolved podcast claims | Research owner before reuse | Primary passages, study text, audio or show notes supporting the exact claim. Omit unsupported figures from the pitch meanwhile. |

The immediate product sequence is setup and shared scheduler/interface/simulation contracts, then ready drivers/storage, controls, recipes, lifecycle and interfaces in dependency order. Commission target owners as their resources become ready. Integrate accepted changes continuously. Update the remaining estimate from the first wave rather than creating a separate research programme before product work.

## Relevant commit history

| Commit | Activity |
|---|---|
| `14cb676` | Captured the traditional estimate and fleet pitch constraints. |
| `71fe4ae` | Set the comparison baseline to 101.4 Engineer days. |
| `4c4daa3` | Distilled research and mapped existing/proposed ompc capabilities. |
| `6bddf77` | Added setup scope and resource requirements. |
| `7dea582` | Added the ticket model, quantified report, operating controls and presentation. |
| `7439619` | Removed duplicated sensitivity traces while retaining forecast values and primary schedules. |
| `f722327` | Applied the writing-style rewrite, rebuilt the presentation and committed the transcript/source evidence notes. |

No push or deployment was performed as part of this activity. Remote publication status was not checked. This handover records the completed work at `f722327`; its own commit follows that revision.
