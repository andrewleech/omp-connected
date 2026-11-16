# Smart Trolley traditional software baseline

Written: 2026-11-16
Repository revision at preparation: `083b26e`.

## Source and limits

The local source is the MHTML capture titled **smart-trolley-sw**, saved 16 November 2026 at 03:36:28 GMT. Its main report is **Smart Trolley software estimate: brief**, status **draft**, dated **2026-11-06**, owner Andrew Leech, PI software lead, Cavendish (client NXT Bioscience). The report presents itself as a draft estimate for review and refinement, not an approved plan or delivery commitment.

This is a baseline from a project estimate, not a measured comparison of sequential personal-agent engineering with an omp-connected fleet. The report describes work packages, draft effort, one team/schedule model, some estimates of AI speed-up, and hardware needs. It does not report an observed project delivery, measured sequential-agent baseline, or fleet result. Treat any conversion into a fleet scenario as interpretation, not a source fact.

**Included per the report:** firmware on the SmartIO controller, network API and interface control document (ICD), phone interface, and commissioning. **Excluded:** AX-mini software (separate estimate), ERP-side software, PC recipe-authoring/fleet-view software, and air-generation plant. Mechanical design is assigned to Mechanical; hardware selections, plant/site conditions and controller tuning involve Systems or the client. Some ticket content also includes manufacturing provisioning, integration, test and release documentation.

## Planned outcome and feature scope

The product is a trolley for environmental control of plant-tissue-culture bioreactors. The design-input source says it is laboratory equipment, not a medical device. The proposed software outcome includes:

- SmartIO firmware runtime, scheduling, drivers, storage, RTC/power-loss handling and firmware update/revert.
- Per-zone VPD calculation/control, pressure control, air exchange and irrigation, dry-out/low-media detection, zone configuration and container-swap mode.
- Weekly, versioned recipes with per-zone clocks, hold/shift/jump, a basic timed mode, lighting schedule and intensity control.
- Safe disconnect, state recovery/resume after movement or outage, trolley/bay/bioreactor identity, event logging, alarms, and offline queue/replay.
- Local REST API/ICD, pairing/security, outbound ERP connection, phone UI, commissioning self-test, and production provisioning.

The design input nominally describes six shelves of ten bioreactors, but explicitly treats capacity as a mechanical-design outcome rather than a fixed software requirement. The standard trolley uses one VPD zone; additional per-shelf zones are optional architecture and add hardware. The work breakdown also assumes support for up to six zones in several drivers and configuration tasks.

## Estimate and schedule as stated

All 30 sized ticket estimates are marked **DRAFT / needs-review**. They use story points (SP) converted to Engineer days. “Before hardware” and “With hardware” are report classifications, not elapsed durations. The ticket list below records the values displayed in the report, including its precision. The 3 unsized tickets are omitted from all totals and fees.

| Work package | Ticket estimate(s), Engineer days | What this covers |
|---|---:|---|
| Platform, drivers and storage | scheduler 1.4; host simulation 4.3; sensor drivers/validity 4.3; actuators 2.9; storage 1.4; miscellaneous I/O 2.1 | Host-runnable control framework, simulation harness, sensors, actuators, retained state and peripheral drivers. |
| Board bring-up and update | board bring-up 1.4; OTA/revert 2.9 | SmartIO PCBA startup, bootloader integration and update path. |
| Zone climate control | pressure loop 7.1; VPD controller 5.7; irrigation/air exchange 4.3; low-media detector 4.3; zone configuration 1.4; swap mode 1.4 | Per-zone control, safeguards, configuration and special operating mode. |
| Recipes and lighting | recipe engine 5.7; lighting 2.9; recipe store/import/export 2.9 | Stage/clock behavior, recipe storage and light schedule/intensity commands. |
| Lifecycle and identity | disconnect/safe state 4.3; resume 2.9; identity/registration 2.9 | Disconnect, outage recovery, identities and registration. |
| Events and interfaces | alarms 2.1; event log/offline queue 3.6; REST API/ICD 4.3; pairing/security 2.9; ERP link **unsized**; phone UI **unsized** | Faults, records, API, pairing and external connections. |
| Commissioning and production | self-test 2.9; provisioning/end-of-line 2.1 | Hardware-channel tests and production programming/checks. |
| Integration, verification and release | prototype integration 4.3; system test/soak 7.1; dry-out confirmation 4.3; release/design records 1.4; release verification **unsized** | Prototype integration, mandatory system tests, dry-out experiment, records and release process. |

The report's **Schedule** says the default team is Principal engineer 40%, Engineer 100%, Test engineer 50%; finish at **week 21.5**, team load **50%**. Its role totals are **Engineer 101.4 days** and **Principal engineer 15.2 days**, including principal review. The headline estimate instead states **117 Engineer days total**, rounded by role to **Engineer 101.5** and **Principal engineer 15.5 days**, and **about 21.5 weeks elapsed**. It splits the effort into **76.4 days before hardware** and **25.0 days with hardware**. Hardware timing is not set; the plan schedules hardware work when dependencies permit. AI cost is not estimated.

These figures are not interchangeable: person-days measure effort, while 21.5 weeks is the modeled elapsed schedule under the stated team loading. The report does not explain the arithmetic behind every schedule value. Its displayed role totals sum to 116.6 person-days before rounding; the headline rounded figures sum to 117.0. The displayed category split sums to 101.4 Engineer days, apparently not including the Principal engineer review total, and should not be read as the 117-day total. Do not silently reconcile these differences.

### Estimate assumptions and status

- Draft ticket points have not had engineer review; the report calls out **30 DRAFT** estimates and **3 awaiting sizing**.
- Engineer review of ticket points, commercial role rates, the focus factor/review share/team basis, and a project-wide AI-assistance assumption remain outstanding. Template values **0.7 focus factor**, **0.15 review share**, and a three-role team are explicitly not agreed.
- The report assigns individual ticket AI-speed-up labels (high/medium/low), but says **AI cost not estimated** and does not define these labels as measured productivity or a comparative schedule. They are not evidence of achievable speed-up.
- The headline total excludes the unsized ERP link, phone UI and release verification. Unknown additions are therefore not bounded by this total.
- No project target dates are set in `project.yaml`; the readiness panel says schedule criteria were not built because there are no targets. No rates file is present, so fees are suppressed, not zero.

## Dependency structure and possible parallelism

**Report-stated dependencies:** the task cards encode an ordered graph. Scheduler is the foundation; host simulation depends on scheduler. Storage, drivers and other work start against host mocks/simulation where stated. Control and lifecycle tickets depend on selected drivers, storage and/or the simulator; irrigation follows VPD; lighting follows recipe engine and actuator drivers; resume follows disconnect and recipe engine. REST API follows recipe store, events and identity; pairing and phone UI follow the API; ERP link follows events. Self-test follows drivers, API and bring-up; provisioning follows self-test and bring-up. Prototype integration follows pressure control, lighting, resume, alarms and bring-up. System test/soak follows integration. Release/design records follow system test; release verification follows those records and requires the release candidate and an as-yet-unsupplied release process.

**Inference for a fleet comparison:** after shared interfaces, configuration and the scheduler/simulation foundation are ready, some software work appears separable: sensor and actuator drivers; storage; recipe logic; event/alarm handling; much of the UI/API and control logic against mocks. The report itself says multiple items “start now” against mocks or host simulation. This does not establish that all work can proceed concurrently: shared controller interfaces, requirement decisions, mock fidelity, code integration, hardware availability and review capacity constrain useful concurrency. Hardware bring-up, prototype testing and soak tests remain gated by physical hardware and elapsed plant behavior. The ticket graph is not a critical-path analysis, and the report gives no explicitly named critical path.

## Hardware, interfaces and external dependencies

- **Controller/runtime:** SmartIO PCBA, MicroPython runtime, standard bootloader, Ethernet through the umbilical, RTC with backup battery, watchdog and brown-out reset. Existing PI MicroPython project template, Degraves partition management and standard SmartIO bootloader features are assumed available.
- **Sensors/actuation:** shelf solenoids, three-way exhaust valves, pumps, proportional pressure element, zone sensor blocks for pressure/temperature/humidity and optional VOC, sample loop, lighting drivers, UI button/LED, 1-Wire bay-ID EEPROM and power-loss input. Sensor selection and sensor-per-zone versus sensor-per-shelf remain unresolved. Hardware channel maps, polarity, sensor settling, pressure-loop stability and fail-safe states need PCBA/prototype confirmation.
- **External links:** local REST API for phone; phone connects over room Wi-Fi/network, while trolley uses Ethernet via umbilical. Outbound TLS/store-and-forward link to ERP. ERP protocol, authentication, schema and ICD ownership are missing. The architecture diagram does not show all assumed paths; the report lists these as open coordination points.
- **People and equipment:** Mechanical supplies trolley, coupling, filters, valves/surfaces and condensate design. Systems/client decide or provide pressure-control hardware choice, tuning/calibration and plant requirements. Prototype trolley/PCBA and production fixture are required for bring-up, HIL, self-test and provisioning. Room network/bridge, pumps/air generation plant, ERP endpoint and validated bioreactor/media traces are external dependencies.
- **Architecture choices:** proportional valve closed-loop against zone sensor versus electronic regulator is open; selection affects firmware and hardware interface. The report recommends zones to remove event serialization but describes one zone as the standard product configuration.

## Verification, HIL, release and acceptance

The estimate includes a host simulation harness with mocked drivers and a simple bioreactor humidity/temperature/pressure model. Several logic tasks are described as host-testable; sensor behavior is also checked against recorded data. The report states that a set of performance, lifecycle and commissioning checks require PCBA or prototype confirmation. It does not present completed test results.

The verification register includes **28 requirements, each with a verification activity**, and lists these explicit mandatory checks:

- Confirm on prototype hardware that VPD continues rising after dry-out and the controller reports dry bioreactor.
- With power removed or controller halted, shelf solenoids vent and lights turn off; safe-to-disconnect indication waits until venting completes.
- Run and log for an extended offline period without phone or ERP, then replay events in order.
- Restore time, stage and irrigation history after disconnect/outage, with operator choice to resume or start a new run per zone.
- Exercise every valve, pump, sensor and light channel in commissioning self-test, including forced faults.

System test covers disconnect, power cycling, extended offline operation, sensor fault, recipe updates and a soak run; soak duration is elapsed time and unspecified. Integration and system test require prototype hardware. Release verification is not sized because the release process has not been supplied. Design records/release notes are estimated, but the requirements, evidence acceptance authority, release gates, test durations and criteria beyond the listed tests are not fully defined.

## Traceability, safety and human review

The readiness panel reports **295/295 asks reach a response**, **all 28 requirements have verification activities**, and **all 30 estimated tickets remain drafts**. It also says **12 of 40 evidenced entries rest on AI inference alone**, as an action item, and eight open stakeholder questions block pricing, with ten more open. The report labels some requirements and assumptions as PI interpretations rather than client statements; the evidence register distinguishes client-stated, client-answer, source-document, observed, provider-policy and needs-review evidence. This trace structure is useful for a software RGM human-review gate, but does not itself constitute approval.

The estimate assumes laboratory equipment at extra-low voltage, no medical-device software safety class/process, and hardware EMC tests to Australian RCM plus US/European levels; this is explicitly an **inferred, unconfirmed assumption**. The report says a regulated software process would add documentation and verification work to every ticket. It contains requirements about safe states and fail-safe behavior, but does not provide a completed hazard analysis or establish a software safety classification. Human review is specifically required for draft points, AI-inference-only claims, open requirements/assumptions and final verification evidence. Do not expand “RGM”: the source does not define it.

## Key uncertainty and risks for a fleet pitch

1. **Scope and pricing incomplete:** phone UI, ERP link and release verification are unsized; ERP/PC software and AX-mini are excluded. Open answers can change ticket sizes, ownership and interfaces.
2. **Draft estimate basis:** estimates are unreviewed, rates and team basis are missing, and AI assistance assumptions have not been set. The report's team model and 21.5-week duration are illustrative draft inputs, not a commitment.
3. **Hardware gating:** PCBA/prototype availability has no date; prototype integration, dry-out confirmation, commissioning, system test and release are hardware-dependent. Prototype and soak elapsed time cannot be parallelized away solely by more agents.
4. **Unsettled design/requirements:** pressure element, sensor placement, phone form/ownership, ERP protocol, recipe semantics, irrigation limits, user/permission model and several architecture links remain open. Sensor validity and high-humidity behavior, dry-out mechanism, low-media thresholds and pressure-loop stability need evidence.
5. **External-team capacity:** Mechanical, Systems, client/NXT, ERP, electrical/hardware and test/release stakeholders provide required decisions, hardware and traces. Their response timing is not estimated.
6. **Safety/traceability review:** current evidence includes AI inference and unresolved assumptions. A fleet needs named human owners for design choices, safety interpretation, test evidence and release acceptance; the source does not quantify that review capacity.
7. **Concurrency evidence missing:** task dependency cards show candidate independent work, but no measured contention, integration cost, merge/rework rate, agent setup cost or shared-HIL capacity. Do not claim a schedule reduction from summed parallel work.

## Source locator table

Locators below refer to the saved MHTML report's visible headings/labels. Short quotations are exact report text for navigation and traceability.

| Fact used | Source locator / short quote |
|---|---|
| Capture identity/date and estimate status/date | MHTML headers: `Subject: smart-trolley-sw — discuss.hub`, `Date: Mon, 16 Nov 2026 03:36:28 GMT`; section **Smart Trolley software estimate: brief**: `Status: draft. Date: 2026-11-06.` |
| Scope and exclusions | **Smart Trolley software estimate: brief > Scope**: `The estimate covers the trolley firmware on the SmartIO controller, its network API and interface control document, the phone interface and commissioning. The AX-mini software has its own estimate. The ERP side, PC authoring software and the air generation plant are not included.` |
| Product and control behavior | **NXT Bioreactor Trolley Design Inputs > 1. Purpose; 4.4 The irrigation trigger; 4.10 Zone pneumatic architecture**: `laboratory equipment ... not a medical device`; `The upper bound is not a ceiling`; `Zone-level pressure control is what removes event serialisation.` |
| Headline work outcome | **Summary > What we will deliver**; ticket cards under **Tasks** (e.g. `task-vpd`, `task-irrigation`, `task-events`, `task-integration`). |
| Team, schedule and role totals | **Tasks > Schedule**: `Principal engineer 40%, Engineer 100%, Test engineer 50%. Finish at week 21.5, team load 50%.` |
| Overall estimates, split and unsized count | **Summary > Headline estimate**: `117 engineer days ... about 21.5 weeks elapsed`; `Before hardware: 76.4 days. With hardware: 25.0 days`; `3 ticket(s) unsized and excluded from the totals.` |
| Example ticket estimate and explicit dependencies | **Tasks > [work-package heading] > task cards**. Cards show `SP / days`, status, hardware classification, speed-up label and `depends on`; for example `task-pressure-loop` is `5 SP / 7.1 days` and depends on sensor/actuator drivers and host simulation. |
| Required verification | **Verification**: `test mandatory`, including `Dry-out behaviour confirmed on prototype hardware`, `Fail-safe state holds with the software stopped`, offline logging/replay and resume. |
| Readiness and evidence concerns | **Readiness**: `12 of 40 evidenced entries rest on AI inference alone`; `30 DRAFT estimates; 3 awaiting sizing`; **Warnings** and **Content only people can supply**. |
| Missing decisions and estimate inputs | **Assumptions > Questions > To stakeholders** and **Summary > Open questions (18)**; **Content only people can supply** lists engineer review, rates, team basis, AI assumption and Systems answers outstanding. |
| External hardware/interface assumptions | **Software System Architecture > Software-Hardware Interfaces / Software-Software Interfaces**; **Trolley systems architecture 713_1004_01 > Questions to raise with the EE / Systems team**; task cards `task-bringup`, `task-integration`, `task-system-test`. |
| Regulatory and safety estimate basis | **Assumptions** entry `asm-regulatory`: `inferred condition on price`; **Requirements > 4 Safety** and **Verification**. |

## Information still needed for a defensible fleet pitch

- Engineer-reviewed ticket estimates with definitions for SP-to-day conversion, uncertainty/range and whether review is already included. Reconcile the role-total rounding and category split.
- Decisions and estimates for phone UI, ERP link and release verification; clarify whether excluded PC/ERP/AX-mini scope is independently staffed and scheduled.
- Agreed project target date, actual hardware availability, prototype/fixture dates, test/soak durations, release process and acceptance authority.
- Confirmed role availability, focus factor, review share, team basis, commercial rates and project-wide AI-assistance assumptions.
- Resolved Systems/client decisions for pressure-control element, sensor topology, phone/API ownership, ERP protocol/authentication/schema, configuration capacity and open irrigation/recipe parameters.
- Named dependencies and response dates for Mechanical, Electrical, Systems, NXT, ERP, manufacturing and test/release teams; required hardware/bench access and concurrent HIL capacity.
- A measured baseline for the intended sequential personal-agent workflow, including actual cycle times and human review/integration effort, and a comparable fleet trial. The report supplies neither. Define the experiment and evidence thresholds before claiming an acceleration factor.
- Agreed human-review controls for AI-derived claims, requirement interpretation, safety decisions, firmware behavior on faults, evidence records and release acceptance. Confirm whether any regulated software lifecycle or safety requirements apply.
