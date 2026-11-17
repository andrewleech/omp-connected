# Smart Trolley traditional software baseline

Written: 2026-11-16
Repository revision at preparation: `083b26e`.

## Baseline and source limits

Use **101.4 Engineer days** as the comparison baseline, with the draft schedule's **15.2 Principal engineer days** kept separate. The source is the local MHTML capture **smart-trolley-sw**, saved 16 November 2026 at 03:36:28 GMT. Its main report, **Smart Trolley software estimate: brief**, is a **draft** dated **2026-11-06**, owned by Andrew Leech, PI software lead, Cavendish (client NXT Bioscience). It remains subject to review and refinement, rather than an approved plan or delivery commitment.

The report supplies work packages, draft effort, one team/schedule model, estimated AI speed-up labels and hardware needs. It supplies no observed project delivery, measured sequential personal-agent baseline or fleet result. Fleet scenarios derived from it are interpretations, not source facts.

**Included:** firmware on the SmartIO controller, network API and interface control document (ICD), phone interface and commissioning. **Excluded:** AX-mini software (separate estimate), ERP-side software, PC recipe-authoring/fleet-view software and air-generation plant. Mechanical owns mechanical design. Hardware selections, plant/site conditions and controller tuning involve Systems or the client. Tickets also cover manufacturing provisioning, integration, test and release documentation.

## Planned outcome and feature scope

The trolley controls the environment of plant-tissue-culture bioreactors. The design-input source classifies it as laboratory equipment, not a medical device. The proposed software covers:

- SmartIO firmware runtime, scheduling, drivers, storage, RTC/power-loss handling and firmware update/revert.
- Per-zone VPD calculation/control, pressure control, air exchange and irrigation, dry-out/low-media detection, zone configuration and container-swap mode.
- Weekly, versioned recipes with per-zone clocks, hold/shift/jump, a basic timed mode, lighting schedule and intensity control.
- Safe disconnect, state recovery/resume after movement or outage, trolley/bay/bioreactor identity, event logging, alarms, and offline queue/replay.
- Local REST API/ICD, pairing/security, outbound ERP connection, phone UI, commissioning self-test, and production provisioning.

The design input describes six shelves of ten bioreactors as nominal capacity, subject to mechanical design rather than a fixed software requirement. One VPD zone is standard. Optional per-shelf zones add hardware. Several driver and configuration tickets assume support for up to six zones.

## Estimate and schedule as stated

All 30 sized tickets are **DRAFT / needs-review**, with story points (SP) converted to Engineer days. “Before hardware” and “With hardware” are report classifications, not elapsed durations. Three unsized tickets are excluded from all totals and fees.

| Work package | Ticket estimate(s), Engineer days | What this covers |
|---|---:|---|
| Platform, drivers and storage | scheduler 1.4; host simulation 4.3; sensor drivers/validity 4.3; actuators 2.9; storage 1.4; miscellaneous I/O 2.1 | Host-runnable control framework, simulation harness, sensors, actuators, retained state and peripheral drivers. |
| Board bring-up and update | board bring-up 1.4; OTA/revert 2.9 | SmartIO PCBA startup, bootloader integration and update path. |
| Zone climate control | pressure loop 7.1; VPD controller 5.7; irrigation/air exchange 4.3; low-media detector 4.3; zone configuration 1.4; swap mode 1.4 | Per-zone control, safeguards, configuration and special operating mode. |
| Recipes and lighting | recipe engine 5.7; lighting 2.9; recipe store/import/export 2.9 | Stage/clock behaviour, recipe storage and light schedule/intensity commands. |
| Lifecycle and identity | disconnect/safe state 4.3; resume 2.9; identity/registration 2.9 | Disconnect, outage recovery, identities and registration. |
| Events and interfaces | alarms 2.1; event log/offline queue 3.6; REST API/ICD 4.3; pairing/security 2.9; ERP link **unsized**; phone UI **unsized** | Faults, records, API, pairing and external connections. |
| Commissioning and production | self-test 2.9; provisioning/end-of-line 2.1 | Hardware-channel tests and production programming/checks. |
| Integration, verification and release | prototype integration 4.3; system test/soak 7.1; dry-out confirmation 4.3; release/design records 1.4; release verification **unsized** | Prototype integration, mandatory system tests, dry-out experiment, records and release process. |

The report's **Schedule** uses Principal engineer 40%, Engineer 100% and Test engineer 50%, with finish at **week 21.5** and team load **50%**. Role totals are **Engineer 101.4 days** and **Principal engineer 15.2 days**, including principal review. The headline gives **117 Engineer days total**, with rounded role figures of **Engineer 101.5** and **Principal engineer 15.5 days**, and **about 21.5 weeks elapsed**. The hardware split is **76.4 days before hardware** and **25.0 days with hardware**. Hardware dates are unset, so hardware work is scheduled when dependencies permit.

Person-days measure effort. The 21.5 weeks is modelled elapsed time under the stated team loading. The report does not explain all schedule arithmetic: displayed role totals sum to 116.6 person-days, while the rounded headline figures sum to 117.0. The hardware split sums to 101.4 Engineer days and appears to exclude Principal engineer review. Keep these figures distinct rather than reconciling them without source evidence.

### Estimate assumptions and status

- Engineer review of ticket points is outstanding. The report lists **30 DRAFT** estimates and **3 awaiting sizing**.
- Commercial role rates, the focus factor/review share/team basis and a project-wide AI-assistance assumption are outstanding. Template values **0.7 focus factor**, **0.15 review share** and the three-role team are not agreed.
- The report provides no measured productivity or comparative schedule basis for ticket AI-speed-up labels (high/medium/low). It states **AI cost not estimated**.
- The headline excludes the unsized ERP link, phone UI and release verification, so it does not bound the remaining scope.
- `project.yaml` has no project target dates. The readiness panel says schedule criteria were not built because there are no targets. Fees are suppressed because no rates file is present, not because fees are zero.

## Dependency structure and possible parallelism

**Report-stated dependencies:** the task cards define an ordered graph. Scheduler is the foundation, followed by host simulation. Storage, drivers and other work start against host mocks/simulation where stated. Control and lifecycle tickets depend on selected drivers, storage and/or the simulator. Irrigation follows VPD. Lighting follows recipe engine and actuator drivers. Resume follows disconnect and recipe engine. REST API follows recipe store, events and identity. Pairing and phone UI follow the API, and ERP link follows events. Self-test follows drivers, API and bring-up. Provisioning follows self-test and bring-up. Prototype integration follows pressure control, lighting, resume, alarms and bring-up. System test/soak follows integration. Release/design records follow system test. Release verification follows those records and requires the release candidate and a release process that has not been supplied.

**Fleet-comparison inference:** some software work appears separable after shared interfaces, configuration and the scheduler/simulation foundation are ready: sensor and actuator drivers, storage, recipe logic, event/alarm handling, and much of the UI/API and control logic against mocks. Several report items say “start now” against mocks or host simulation. Useful concurrency still depends on shared controller interfaces, requirement decisions, mock fidelity, integration, hardware availability and review capacity. Hardware bring-up, prototype testing and soak remain gated by hardware and elapsed plant behaviour. The ticket graph is not a critical-path analysis, and the report names no critical path.

## Hardware, interfaces and external dependencies

- **Controller/runtime:** SmartIO PCBA, MicroPython runtime, standard bootloader, Ethernet through the umbilical, RTC with backup battery, watchdog and brown-out reset. Existing PI MicroPython project template, Degraves partition management and standard SmartIO bootloader features are assumed available.
- **Sensors/actuation:** shelf solenoids, three-way exhaust valves, pumps, proportional pressure element, zone sensor blocks for pressure/temperature/humidity and optional VOC, sample loop, lighting drivers, UI button/LED, 1-Wire bay-ID EEPROM and power-loss input. Sensor selection and sensor-per-zone versus sensor-per-shelf remain open. PCBA/prototype checks must confirm channel maps, polarity, sensor settling, pressure-loop stability and fail-safe states.
- **External links:** local REST API for the phone. The phone uses room Wi-Fi/network, while the trolley uses Ethernet through the umbilical. ERP uses an outbound TLS/store-and-forward link. ERP protocol, authentication, schema and ICD ownership are missing. The architecture diagram omits some assumed paths, which remain open coordination points.
- **People and equipment:** Mechanical supplies trolley, coupling, filters, valves/surfaces and condensate design. Systems/client decide or provide pressure-control hardware choice, tuning/calibration and plant requirements. Prototype trolley/PCBA and production fixture are required for bring-up, HIL, self-test and provisioning. Room network/bridge, pumps/air generation plant, ERP endpoint and validated bioreactor/media traces are external dependencies.
- **Architecture choices:** selection between a proportional valve closed-loop against a zone sensor and an electronic regulator remains open, affecting firmware and hardware interfaces. The report recommends zones to remove event serialisation but specifies one zone as standard.

## Verification, HIL, release and acceptance

The estimate includes a host simulation harness with mocked drivers and a simple bioreactor humidity/temperature/pressure model. Several logic tasks are host-testable. Sensor behaviour is also checked against recorded data. Performance, lifecycle and commissioning checks require PCBA or prototype confirmation. No completed test results are supplied.

The verification register has **28 requirements, each with a verification activity**, including these mandatory checks:

- Confirm on prototype hardware that VPD continues rising after dry-out and the controller reports dry bioreactor.
- With power removed or controller halted, shelf solenoids vent and lights turn off; safe-to-disconnect indication waits until venting completes.
- Run and log for an extended offline period without phone or ERP, then replay events in order.
- Restore time, stage and irrigation history after disconnect/outage, with operator choice to resume or start a new run per zone.
- Exercise every valve, pump, sensor and light channel in commissioning self-test, including forced faults.

System test covers disconnect, power cycling, extended offline operation, sensor fault, recipe updates and a soak run. Soak duration is unspecified elapsed time. Integration and system test require prototype hardware. Release verification remains unsized because the release process has not been supplied. Design records/release notes are estimated. Requirements, evidence acceptance authority, release gates, test durations and criteria beyond the listed tests remain partly undefined.

## Traceability, safety and human review

The readiness panel reports **295/295 asks reach a response**, **all 28 requirements have verification activities**, and **all 30 estimated tickets remain drafts**. It flags **12 of 40 evidenced entries rest on AI inference alone** for action. Eight open stakeholder questions block pricing, with ten more open. Some requirements and assumptions are PI interpretations rather than client statements. The evidence register distinguishes client-stated, client-answer, source-document, observed, provider-policy and needs-review evidence. These records support a software RGM human-review gate but do not constitute approval.

The estimate assumes laboratory equipment at extra-low voltage, no medical-device software safety class/process, and hardware EMC tests to Australian RCM plus US/European levels. This is an **inferred, unconfirmed assumption**. A regulated software process would add documentation and verification work to every ticket. Safe-state and fail-safe requirements are present, but a completed hazard analysis and software safety classification are not. Human review is required for draft points, AI-inference-only claims, open requirements/assumptions and final verification evidence. The source does not define “RGM”.

## Fleet comparison risks and unknowns

1. **Incomplete scope and pricing:** phone UI, ERP link and release verification are unsized. ERP/PC software and AX-mini are excluded. Open answers can change ticket sizes, ownership and interfaces.
2. **Draft estimate basis:** estimates are unreviewed, rates and team basis are missing, and AI-assistance assumptions are unset. The team model and 21.5-week duration are illustrative inputs, not a commitment.
3. **Hardware availability:** PCBA/prototype dates are unset. Prototype integration, dry-out confirmation, commissioning, system test and release depend on hardware. Additional agents cannot remove prototype and soak elapsed time.
4. **Open design and requirements:** pressure element, sensor placement, phone form/ownership, ERP protocol, recipe semantics, irrigation limits, user/permission model and several architecture links remain open. Sensor validity and high-humidity behaviour, dry-out mechanism, low-media thresholds and pressure-loop stability need evidence.
5. **External-team capacity:** Mechanical, Systems, client/NXT, ERP, electrical/hardware and test/release stakeholders supply decisions, hardware and traces. Their response timing is not estimated.
6. **Safety and traceability review:** AI-inference evidence and unresolved assumptions require named human owners for design choices, safety interpretation, test evidence and release acceptance. The source does not quantify review capacity.
7. **Unmeasured concurrency:** dependency cards identify candidate independent work, but give no measured contention, integration cost, merge/rework rate, agent setup cost or shared-HIL capacity. Summed parallel work cannot support a schedule-reduction claim.

## Source locator table

The locators use visible headings/labels in the saved MHTML report. Short quotations retain exact report text.

| Fact used | Source locator / short quote |
|---|---|
| Capture identity/date and estimate status/date | MHTML headers: `Subject: smart-trolley-sw — discuss.hub`, `Date: Mon, 16 Nov 2026 03:36:28 GMT`; section **Smart Trolley software estimate: brief**: `Status: draft. Date: 2026-11-06.` |
| Scope and exclusions | **Smart Trolley software estimate: brief > Scope**: `The estimate covers the trolley firmware on the SmartIO controller, its network API and interface control document, the phone interface and commissioning. The AX-mini software has its own estimate. The ERP side, PC authoring software and the air generation plant are not included.` |
| Product and control behaviour | **NXT Bioreactor Trolley Design Inputs > 1. Purpose; 4.4 The irrigation trigger; 4.10 Zone pneumatic architecture**: `laboratory equipment ... not a medical device`; `The upper bound is not a ceiling`; `Zone-level pressure control is what removes event serialisation.` |
| Headline work outcome | **Summary > What we will deliver**; ticket cards under **Tasks** (e.g. `tk-vpd`, `tk-irrigation`, `tk-events`, `tk-integration`). |
| Team, schedule and role totals | **Tasks > Schedule**: `Principal engineer 40%, Engineer 100%, Test engineer 50%. Finish at week 21.5, team load 50%.` |
| Overall estimates, split and unsized count | **Summary > Headline estimate**: `117 engineer days ... about 21.5 weeks elapsed`; `Before hardware: 76.4 days. With hardware: 25.0 days`; `3 ticket(s) unsized and excluded from the totals.` |
| Example ticket estimate and explicit dependencies | **Tasks > [work-package heading] > task cards**. Cards show `SP / days`, status, hardware classification, speed-up label and `depends on`; for example `tk-pressure-loop` is `5 SP / 7.1 days` and depends on sensor/actuator drivers and host simulation. |
| Required verification | **Verification**: `test mandatory`, including `Dry-out behaviour confirmed on prototype hardware`, `Fail-safe state holds with the software stopped`, offline logging/replay and resume. |
| Readiness and evidence concerns | **Readiness**: `12 of 40 evidenced entries rest on AI inference alone`; `30 DRAFT estimates; 3 awaiting sizing`; **Warnings** and **Content only people can supply**. |
| Missing decisions and estimate inputs | **Assumptions > Questions > To stakeholders** and **Summary > Open questions (18)**; **Content only people can supply** lists engineer review, rates, team basis, AI assumption and Systems answers outstanding. |
| External hardware/interface assumptions | **Software System Architecture > Software-Hardware Interfaces / Software-Software Interfaces**; **Trolley systems architecture 713_1004_01 > Questions to raise with the EE / Systems team**; task cards `tk-bringup`, `tk-integration`, `tk-system-test`. |
| Regulatory and safety estimate basis | **Assumptions** entry `asm-regulatory`: `inferred condition on price`; **Requirements > 4 Safety** and **Verification**. |

## Inputs required for a fleet comparison

- Engineer-reviewed ticket estimates, SP-to-day conversion, uncertainty/range and confirmation of whether review is included. Reconcile role-total rounding and the hardware split.
- Decisions and estimates for phone UI, ERP link and release verification; clarify whether excluded PC/ERP/AX-mini scope is independently staffed and scheduled.
- Agreed project target date, actual hardware availability, prototype/fixture dates, test/soak durations, release process and acceptance authority.
- Confirmed role availability, focus factor, review share, team basis, commercial rates and project-wide AI-assistance assumptions.
- Resolved Systems/client decisions for pressure-control element, sensor topology, phone/API ownership, ERP protocol/authentication/schema, configuration capacity and open irrigation/recipe parameters.
- Named dependencies and response dates for Mechanical, Electrical, Systems, NXT, ERP, manufacturing and test/release teams; required hardware/bench access and concurrent HIL capacity.
- A measured sequential personal-agent baseline, including cycle times and human review/integration effort, and a comparable fleet trial. Both are missing. Set the experiment and evidence thresholds before claiming acceleration.
- Agreed human-review controls for AI-derived claims, requirement interpretation, safety decisions, firmware behaviour on faults, evidence records and release acceptance. Confirm applicable regulated software lifecycle and safety requirements.

## Revalidation, 2026-11-17

The original temporary MHTML capture is no longer present. All 33 ticket-card IDs, titles, estimates, hardware classes and dependency lists were recovered from the retained visible extraction record and captured in [normalised ticket inputs](20261117_traditional-ticket-inputs.json). Displayed sized-ticket days sum to 101.5, compared with the authoritative 101.4-day schedule baseline. The recovered values are unchanged. Source locator examples use the recovered `tk-` IDs. Detailed per-card acceptance text and speed-up labels were not recovered.
