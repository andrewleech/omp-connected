# Smart Trolley fleet delivery proposal

## Metadata
- author: Andrew Leech
- date: 17 November 2026

---
<!-- slide: 1, template: 1 -->
# title
Smart Trolley fleet [yellow]delivery[/yellow]
# subtitle
Executive proposal
# date
17 November 2026
# author
Andrew Leech
# client
Exec / PM / software RGM
## notes
Proposal only. No fleet has been commissioned and no delivery acceleration has been measured.
---
<!-- slide: 2, template: 15 -->
# title
Target forecast: testable [blue]hypothesis[/blue]
# key_message
Target scenario
55.2 working days
11.0 weeks
# body
- Parallel bounded implementation and cross-review
- Dedicated target owners and explicit operator effort
- Setup, human review and coordination included
- Calibrate with the first delivery wave
## notes
Target: 55.2 working days, 11.0 weeks. Engineer effort reduction 72.7 days; Principal effort reduction 2.5 days. Elapsed comparison 48.7% below the draft source schedule. Setup E7.5/P2.4 is included once. These are judgement estimates, not measured performance or automatic cash/staffing savings. Human approval of every merge and a common initial decision allowance remain in the model. Three unsized tickets remain outside this pre-release-verification endpoint.
---
<!-- slide: 3, template: 4 -->
# title
Scenario [blue]comparison[/blue]
# body
Editable scenario table is added by the generator.
## notes
All-in role totals are utilized effort forecasts: product effort plus one-off setup and recurring coordination. These comparisons are not automatic cash or staffing savings; operator effort is separate and has no recovered baseline for an operator saving. Traditional source schedule reports 101.4 Engineer days and 15.2 Principal days at 21.5 weeks; its headline rounds Engineer days to 101.5 and combined effort to 117 person-days. The baseline has different and unagreed staffing/focus, so this is a scenario comparison, not equal-resource empirical speedup. ERP, phone UI and release verification are unsized and excluded. Source: planning/fleets/20261116_smart-trolley-traditional-baseline.md Model summaries: cautious: scheduler: {'source_id': 'tk-scheduler', 'host_accepted_day': 20.471304347826088, 'target_complete_day': None, 'complete_day': 20.471304347826088}; host-simulation: {'source_id': 'tk-host-sim', 'host_accepted_day': 25.891630434782613, 'target_complete_day': None, 'complete_day': 25.891630434782613}; sensor-drivers: {'source_id': 'tk-drv-sensors', 'host_accepted_day': 27.06163043478261, 'target_complete_day': 30.92913043478261, 'complete_day': 30.92913043478261}; actuator-drivers: {'source_id': 'tk-drv-actuators', 'host_accepted_day': 29.141630434782613, 'target_complete_day': 31.189130434782612, 'complete_day': 31.189130434782612}; storage: {'source_id': 'tk-storage', 'host_accepted_day': 23.29163043478261, 'target_complete_day': 24.721630434782615, 'complete_day': 24.721630434782615}; misc-io: {'source_id': 'tk-drv-misc', 'host_accepted_day': 27.97163043478261, 'target_complete_day': 40.809130434782624, 'complete_day': 40.809130434782624}; bringup: {'source_id': 'tk-bringup', 'host_accepted_day': 22.583804347826092, 'target_complete_day': 24.559130434782613, 'complete_day': 24.559130434782613}; ota: {'source_id': 'tk-ota', 'host_accepted_day': 62.551630434782616, 'target_complete_day': 63.49413043478261, 'complete_day': 63.49413043478261}; pressure: {'source_id': 'tk-pressure-loop', 'host_accepted_day': 42.78880434782609, 'target_complete_day': 45.37380434782609, 'complete_day': 45.37380434782609}; vpd: {'source_id': 'tk-vpd', 'host_accepted_day': 33.52913043478261, 'target_complete_day': 36.32413043478261, 'complete_day': 36.32413043478261}; irrigation: {'source_id': 'tk-irrigation', 'host_accepted_day': 48.09902173913044, 'target_complete_day': 49.75652173913045, 'complete_day': 49.75652173913045}; low-media: {'source_id': 'tk-low-media', 'host_accepted_day': 58.50750000000001, 'target_complete_day': 59.79750000000001, 'complete_day': 59.79750000000001}; zone-config: {'source_id': 'tk-zone-config', 'host_accepted_day': 63.987282608695665, 'target_complete_day': 64.44978260869566, 'complete_day': 64.44978260869566}; swap: {'source_id': 'tk-swap-mode', 'host_accepted_day': 63.13945652173914, 'target_complete_day': 64.14978260869566, 'complete_day': 64.14978260869566}; recipes: {'source_id': 'tk-recipe-engine', 'host_accepted_day': 35.54413043478261, 'target_complete_day': 36.84413043478261, 'complete_day': 36.84413043478261}; lighting: {'source_id': 'tk-lighting', 'host_accepted_day': 49.009021739130446, 'target_complete_day': 51.056521739130446, 'complete_day': 51.056521739130446}; recipe-store: {'source_id': 'tk-recipe-store', 'host_accepted_day': 38.72913043478262, 'target_complete_day': None, 'complete_day': 38.72913043478262}; disconnect: {'source_id': 'tk-disconnect', 'host_accepted_day': 37.624130434782614, 'target_complete_day': 39.44413043478262, 'complete_day': 39.44413043478262}; resume: {'source_id': 'tk-resume', 'host_accepted_day': 43.96445652173913, 'target_complete_day': 49.33402173913045, 'complete_day': 49.33402173913045}; identity: {'source_id': 'tk-identity', 'host_accepted_day': 39.964130434782625, 'target_complete_day': 40.61413043478262, 'complete_day': 40.61413043478262}; alarms: {'source_id': 'tk-alarms', 'host_accepted_day': 50.21152173913045, 'target_complete_day': 51.284021739130445, 'complete_day': 51.284021739130445}; events: {'source_id': 'tk-events', 'host_accepted_day': 30.60413043478261, 'target_complete_day': 39.05413043478262, 'complete_day': 39.05413043478262}; api: {'source_id': 'tk-rest-api', 'host_accepted_day': 46.21402173913044, 'target_complete_day': 47.254021739130444, 'complete_day': 47.254021739130444}; pairing: {'source_id': 'tk-pairing', 'host_accepted_day': 56.68184782608696, 'target_complete_day': 57.537717391304355, 'complete_day': 57.537717391304355}; self-test: {'source_id': 'tk-selftest', 'host_accepted_day': 54.138369565217396, 'target_complete_day': 58.83250000000001, 'complete_day': 58.83250000000001}; provisioning: {'source_id': 'tk-provisioning', 'host_accepted_day': 65.45402173913044, 'target_complete_day': 68.87978260869565, 'complete_day': 68.87978260869565}; integration: {'source_id': 'tk-integration', 'host_accepted_day': 61.44097826086957, 'target_complete_day': 68.03478260869565, 'complete_day': 68.03478260869565}; system-test: {'source_id': 'tk-system-test', 'host_accepted_day': 74.44108695652174, 'target_complete_day': 82.52608695652174, 'complete_day': 82.52608695652174}; dry-out: {'source_id': 'tk-dryout', 'host_accepted_day': 52.57271739130435, 'target_complete_day': 57.21271739130435, 'complete_day': 57.21271739130435}; release-records: {'source_id': 'tk-release-notes', 'host_accepted_day': 86.94956521739131, 'target_complete_day': None, 'complete_day': 86.94956521739131}; target: scheduler: {'source_id': 'tk-scheduler', 'host_accepted_day': 11.945887445887443, 'target_complete_day': None, 'complete_day': 11.945887445887443}; host-simulation: {'source_id': 'tk-host-sim', 'host_accepted_day': 14.984523809523807, 'target_complete_day': None, 'complete_day': 14.984523809523807}; sensor-drivers: {'source_id': 'tk-drv-sensors', 'host_accepted_day': 15.627380952380951, 'target_complete_day': 18.573809523809523, 'complete_day': 18.573809523809523}; actuator-drivers: {'source_id': 'tk-drv-actuators', 'host_accepted_day': 16.770238095238096, 'target_complete_day': 18.716666666666665, 'complete_day': 18.716666666666665}; storage: {'source_id': 'tk-storage', 'host_accepted_day': 13.611147186147184, 'target_complete_day': 23.270238095238096, 'complete_day': 23.270238095238096}; misc-io: {'source_id': 'tk-drv-misc', 'host_accepted_day': 16.127380952380953, 'target_complete_day': 23.18095238095238, 'complete_day': 23.18095238095238}; bringup: {'source_id': 'tk-bringup', 'host_accepted_day': 13.106601731601728, 'target_complete_day': 17.66309523809524, 'complete_day': 17.66309523809524}; ota: {'source_id': 'tk-ota', 'host_accepted_day': 33.33095238095238, 'target_complete_day': 34.34166666666667, 'complete_day': 34.34166666666667}; pressure: {'source_id': 'tk-pressure-loop', 'host_accepted_day': 26.348160173160178, 'target_complete_day': 30.623809523809527, 'complete_day': 30.623809523809527}; vpd: {'source_id': 'tk-vpd', 'host_accepted_day': 20.002380952380953, 'target_complete_day': 22.03809523809524, 'complete_day': 22.03809523809524}; irrigation: {'source_id': 'tk-irrigation', 'host_accepted_day': 27.116017316017324, 'target_complete_day': 33.56309523809524, 'complete_day': 33.56309523809524}; low-media: {'source_id': 'tk-low-media', 'host_accepted_day': 31.13387445887447, 'target_complete_day': 35.377380952380975, 'complete_day': 35.377380952380975}; zone-config: {'source_id': 'tk-zone-config', 'host_accepted_day': 35.555952380952405, 'target_complete_day': 37.791666666666664, 'complete_day': 37.791666666666664}; swap: {'source_id': 'tk-swap-mode', 'host_accepted_day': 35.16309523809526, 'target_complete_day': 36.84166666666666, 'complete_day': 36.84166666666666}; recipes: {'source_id': 'tk-recipe-engine', 'host_accepted_day': 21.5202380952381, 'target_complete_day': 22.323809523809526, 'complete_day': 22.323809523809526}; lighting: {'source_id': 'tk-lighting', 'host_accepted_day': 28.491017316017324, 'target_complete_day': 35.69880952380955, 'complete_day': 35.69880952380955}; recipe-store: {'source_id': 'tk-recipe-store', 'host_accepted_day': 18.21666666666667, 'target_complete_day': None, 'complete_day': 18.21666666666667}; disconnect: {'source_id': 'tk-disconnect', 'host_accepted_day': 22.752380952380953, 'target_complete_day': 24.26666666666667, 'complete_day': 24.26666666666667}; resume: {'source_id': 'tk-resume', 'host_accepted_day': 27.880627705627713, 'target_complete_day': 34.180952380952384, 'complete_day': 34.180952380952384}; identity: {'source_id': 'tk-identity', 'host_accepted_day': 20.288095238095238, 'target_complete_day': 23.073809523809523, 'complete_day': 23.073809523809523}; alarms: {'source_id': 'tk-alarms', 'host_accepted_day': 29.137121212121222, 'target_complete_day': 36.343290043290054, 'complete_day': 36.343290043290054}; events: {'source_id': 'tk-events', 'host_accepted_day': 17.448809523809526, 'target_complete_day': 18.395238095238096, 'complete_day': 18.395238095238096}; api: {'source_id': 'tk-rest-api', 'host_accepted_day': 24.7702380952381, 'target_complete_day': 26.65173160173161, 'complete_day': 26.65173160173161}; pairing: {'source_id': 'tk-pairing', 'host_accepted_day': 32.48095238095238, 'target_complete_day': 33.00952380952381, 'complete_day': 33.00952380952381}; self-test: {'source_id': 'tk-selftest', 'host_accepted_day': 30.15335497835499, 'target_complete_day': 31.98095238095238, 'complete_day': 31.98095238095238}; provisioning: {'source_id': 'tk-provisioning', 'host_accepted_day': 36.218290043290054, 'target_complete_day': 38.04523809523809, 'complete_day': 38.04523809523809}; integration: {'source_id': 'tk-integration', 'host_accepted_day': 34.98452380952383, 'target_complete_day': 41.113095238095234, 'complete_day': 41.113095238095234}; system-test: {'source_id': 'tk-system-test', 'host_accepted_day': 44.79556277056277, 'target_complete_day': 52.61699134199134, 'complete_day': 52.61699134199134}; dry-out: {'source_id': 'tk-dryout', 'host_accepted_day': 23.698809523809523, 'target_complete_day': 28.70530303030304, 'complete_day': 28.70530303030304}; release-records: {'source_id': 'tk-release-notes', 'host_accepted_day': 55.15205627705628, 'target_complete_day': None, 'complete_day': 55.15205627705628}; stretch: scheduler: {'source_id': 'tk-scheduler', 'host_accepted_day': 7.448191214470284, 'target_complete_day': None, 'complete_day': 7.448191214470284}; host-simulation: {'source_id': 'tk-host-sim', 'host_accepted_day': 9.67845284237726, 'target_complete_day': None, 'complete_day': 9.67845284237726}; sensor-drivers: {'source_id': 'tk-drv-sensors', 'host_accepted_day': 10.103452842377258, 'target_complete_day': 12.923591731266146, 'complete_day': 12.923591731266146}; actuator-drivers: {'source_id': 'tk-drv-actuators', 'host_accepted_day': 12.489563953488368, 'target_complete_day': 14.70831395348837, 'complete_day': 14.70831395348837}; storage: {'source_id': 'tk-storage', 'host_accepted_day': 8.673833979328164, 'target_complete_day': 15.444425064599482, 'complete_day': 15.444425064599482}; misc-io: {'source_id': 'tk-drv-misc', 'host_accepted_day': 11.378452842377257, 'target_complete_day': 15.374980620155037, 'complete_day': 15.374980620155037}; bringup: {'source_id': 'tk-bringup', 'host_accepted_day': 8.050274547803618, 'target_complete_day': 11.781230620155036, 'complete_day': 11.781230620155036}; ota: {'source_id': 'tk-ota', 'host_accepted_day': 24.199980620155035, 'target_complete_day': 25.804583333333337, 'complete_day': 25.804583333333337}; pressure: {'source_id': 'tk-pressure-loop', 'host_accepted_day': 18.7947319121447, 'target_complete_day': 23.848591731266147, 'complete_day': 23.848591731266147}; vpd: {'source_id': 'tk-vpd', 'host_accepted_day': 14.243036175710591, 'target_complete_day': 15.765258397932813, 'complete_day': 15.765258397932813}; irrigation: {'source_id': 'tk-irrigation', 'host_accepted_day': 19.374350775193797, 'target_complete_day': 26.47011950904393, 'complete_day': 26.47011950904393}; low-media: {'source_id': 'tk-low-media', 'host_accepted_day': 22.49027454780362, 'target_complete_day': 29.15589470284238, 'complete_day': 29.15589470284238}; zone-config: {'source_id': 'tk-zone-config', 'host_accepted_day': 25.922638888888894, 'target_complete_day': 31.208672480620155, 'complete_day': 31.208672480620155}; swap: {'source_id': 'tk-swap-mode', 'host_accepted_day': 25.540694444444448, 'target_complete_day': 30.90867248062015, 'complete_day': 30.90867248062015}; recipes: {'source_id': 'tk-recipe-engine', 'host_accepted_day': 15.086091731266148, 'target_complete_day': 16.388869509043925, 'complete_day': 16.388869509043925}; lighting: {'source_id': 'tk-lighting', 'host_accepted_day': 20.477225452196382, 'target_complete_day': 29.750339147286823, 'complete_day': 29.750339147286823}; recipe-store: {'source_id': 'tk-recipe-store', 'host_accepted_day': 12.064563953488369, 'target_complete_day': None, 'complete_day': 12.064563953488369}; disconnect: {'source_id': 'tk-disconnect', 'host_accepted_day': 16.048591731266146, 'target_complete_day': 18.00933139534884, 'complete_day': 18.00933139534884}; resume: {'source_id': 'tk-resume', 'host_accepted_day': 20.051369509043926, 'target_complete_day': 27.528452842377263, 'complete_day': 27.528452842377263}; identity: {'source_id': 'tk-identity', 'host_accepted_day': 13.112480620155035, 'target_complete_day': 15.291647286821703, 'complete_day': 15.291647286821703}; alarms: {'source_id': 'tk-alarms', 'host_accepted_day': 20.976870155038757, 'target_complete_day': 30.386450258397932, 'complete_day': 30.386450258397932}; events: {'source_id': 'tk-events', 'host_accepted_day': 12.30067506459948, 'target_complete_day': 13.393036175710591, 'complete_day': 13.393036175710591}; api: {'source_id': 'tk-rest-api', 'host_accepted_day': 17.60655361757106, 'target_complete_day': 19.815258397932816, 'complete_day': 19.815258397932816}; pairing: {'source_id': 'tk-pairing', 'host_accepted_day': 23.48956395348837, 'target_complete_day': 23.987480620155036, 'complete_day': 23.987480620155036}; self-test: {'source_id': 'tk-selftest', 'host_accepted_day': 21.745377906976742, 'target_complete_day': 25.679583333333337, 'complete_day': 25.679583333333337}; provisioning: {'source_id': 'tk-provisioning', 'host_accepted_day': 27.289228036175714, 'target_complete_day': 28.700339147286826, 'complete_day': 28.700339147286826}; integration: {'source_id': 'tk-integration', 'host_accepted_day': 25.42263888888889, 'target_complete_day': 34.45867248062015, 'complete_day': 34.45867248062015}; system-test: {'source_id': 'tk-system-test', 'host_accepted_day': 37.21152131782945, 'target_complete_day': 44.96152131782945, 'complete_day': 44.96152131782945}; dry-out: {'source_id': 'tk-dryout', 'host_accepted_day': 16.734460594315244, 'target_complete_day': 21.91204457364341, 'complete_day': 21.91204457364341}; release-records: {'source_id': 'tk-release-notes', 'host_accepted_day': 46.865810723514194, 'target_complete_day': None, 'complete_day': 46.865810723514194}
---
<!-- slide: 4, template: 4 -->
# title
Target [blue]milestones[/blue]
# body
Editable milestone table is added by the generator.
## notes
Milestones are evidence gates at relative working days from the modeled start, not calendar commitments. The final endpoint means 30 sized packages plus setup, before release verification. The table maps model milestone names to readable labels and retains relative workday offsets. No calendar dates are inferred. Hardware readiness, procurement and external decisions can shift actual availability. Preserve mandatory physical test durations. Model names: Main setup complete, Required stations commissioned, First host acceptance, First target complete, Dry-out incl. observation, Integration target, System test incl. soak, 30 sized packages + setup.
---
<!-- slide: 5, template: 5 -->
# title
Roles and [blue]accountability[/blue]
# body_1
**Delivery and assurance**
- Deliverable workers own isolated bounded outputs and evidence
- Independent reviewers are separate from producers
- Stable hardware owners retain target authority and reservations
# body
**Coordinator**
- Maintains durable task/dependency state
- Assigns ready work and resolves resource conflicts
- Does not approve requirements or release
## notes

---
<!-- slide: 6, template: 5 -->
# title
Use ompc; add project [blue]workflow[/blue]
# body_1
**Project workflow adds**
- Versioned task contracts, dependencies and recovery records
- Owned branches/worktrees and controlled integration
- Independent review dispositions and revision-linked evidence
- Stable target inventory, owners and enforced reservations
# body
**ompc provides**
- Agent/host discovery, messages, teams and session controls
- Host session launch where supported
- Session prompt queues and event visibility
## notes
Existing ompc features are not a native project scheduler or durable task ledger. Mailboxes, events and session queues are not durable across all failures. Session launch leases do not reserve or lock physical hardware. Source: planning/fleets/20261116_fleet-research-and-capabilities.md.
---
<!-- slide: 7, template: 4 -->
# title
Assurance stays [blue]human-led[/blue]
# body
- **Read-only:** agents investigate; humans decide requirements and scope
- **Supervised:** isolated implementation and independent review; human approves every merge
- **Bounded automation:** only explicitly approved repeatable jobs and limits
- **Consequential decisions:** human approval for safety, physical exceptions, acceptance and release

Start with human review of every merge. Expand only named low-risk classes after evidence and approval.
## notes
Proposed controls, not permissions currently granted. Independent agent review supports but does not replace human judgement. Human authority is required for requirements/interface choices, safety interpretations, physical-operation exceptions, consequential evidence acceptance and release. Sources: project execution and assurance plan; Stripe human merge review: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents; Shopify executable verification: https://shopify.engineering/building-an-agentic-harness-that-outlasts-the-model
---
<!-- slide: 8, template: 5 -->
# title
Hardware is a [blue]constraint[/blue]
# body_1
**Preserve physical work**
- Prototype dry-out confirmation and safe disconnect
- Offline logging/replay and outage recovery
- Every-channel commissioning, including forced faults
- Integration, soak and release verification

Fleet concurrency does not shorten required physical tests or soak.
# body
**Capacity assumptions**
- One main hub/development computer
- Optional distributed computers only where access/capacity needs them
- Local GPU not assumed; model location/provider remains open
- Slots/boards: 3/1, 6/2, 10/3 across scenarios; unconfirmed
- Operator: 4.4 days at 0.25 FTE; additional, not counted as savings
## notes
All primary scenarios use development-board readiness at workday 5, one prototype ready at workday 10 and one production fixture ready at workday 10. Scenario order is cautious/target/stretch: 3/6/10 agent slots and 1/2/3 basic development-board stations. One prototype and one fixture are shared across scenarios; stretch does not imply extra prototype trolleys. Setup effort covers the main environment and commissioning of boards, prototype and fixture once. Counts and dates remain unconfirmed. Operator effort is a separate forecast role with no recovered traditional baseline, so no operator saving is claimed. Session launch leases do not reserve hardware. Physical durations are not scenario-scaled. Source: planning/fleets/20261117_fleet-setup-ticket.md and planning/fleets/20261117_fleet-scenario-assumptions.json.
---
<!-- slide: 9, template: 5 -->
# title
Evidence informs the [blue]method[/blue]
# body_1
**Shopify and Stripe**
Shopify describes executable verification of proposed findings; Stripe describes human review before merge.

**Apply here**
Track accepted outcomes, human touch time, review/integration wait, rework, defects, target occupancy and cost. One wave calibrates assumptions; it does not prove a project-wide acceleration factor.
# body
**Anthropic**
Parallel research orchestration is a decomposition precedent, not delivery evidence.
- Reported 90.2% gain was on an internal research evaluation
- It is not a coding-speed or project schedule claim
- First-party report; different operating context
## notes
Sources are mostly first-party company accounts, not independent comparative trials. Anthropic: https://www.anthropic.com/engineering/multi-agent-research-system; Shopify: https://shopify.engineering/building-an-agentic-harness-that-outlasts-the-model; Stripe: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents; Uber attribution: https://www.uber.com/au/en/blog/solving-the-agent-identity-crisis/. Use examples as operating precedents only; they do not establish this project's throughput, quality, cost or acceleration.
---
<!-- slide: 10, template: 5 -->
# title
Economics: effort now, costs [blue]open[/blue]
# body_1
**Like-for-like limits**
- Original 30 sized tickets only; 3 unsized tickets excluded
- ERP link, phone UI and release verification remain unsized
- AX-mini, ERP-side, PC recipe/fleet-view and air-generation software excluded
- External decisions and hardware dates remain unknown

A reduced estimate is not a full release forecast.
# body
**Forecast basis**
- Role totals are utilized effort, not automatic cash savings
- Setup and coordination are included once
- Released capacity depends on actual allocation
- Operator effort is separate; no baseline saving is claimed
## notes
Rates, equipment quotes and model consumption costs are missing. The role days in the comparison are utilized effort forecasts, not cash savings or proof of reduced staffing. Variable-use cost basis: actual Engineer/Principal effort days × agreed role rates, plus operator_days × operator rate and equipment/model/operating costs. Booked full-window capacity envelope: makespan_workdays × assigned Engineer FTE × Engineer rate + makespan_workdays × assigned Principal FTE × Principal rate + makespan_workdays × 0.25 operator FTE × operator rate + equipment/model/operating costs. Baseline staffing/focus and charging basis are unagreed; do not claim savings until they are comparable.
---
<!-- slide: 11, template: 4 -->
# title
What moves the [blue]timeline[/blue]
# body
Editable sensitivity table is added by the generator.
## notes
Each row changes one target assumption; values are calculated forecasts, not confidence percentiles. Human review, operator availability, physical duration and rework matter more than extra worker slots in this model. More workers do not establish more output. Machine capacity, provider quotas, real hardware dates and stakeholder decisions still need confirmation. ERP link, phone UI and release verification remain unsized, so no full product release date is shown.
---
<!-- slide: 12, template: 15 -->
# title
Decision [blue]requested[/blue]
# key_message
Agree the scenario, capacity, hardware and named ownership. Start one measured delivery wave.
# body
- Confirm target assumptions and missing costs
- Name accountable decision and acceptance owners
- Start host work while station setup proceeds
- Reforecast using observed evidence
## notes
Requested decision: agree a scenario and available capacity; name the coordinator, integration owner, independent reviewers and stable target owners; confirm the main computer and distinct board, prototype and fixture resources needed for the first wave; start bounded host-testable work, one integration/review cycle and target work when stations are commissioned; record observed effort, elapsed time, rework, waits, target occupancy and cost; revise the forecast from evidence. Do not approve an unqualified release date or claim measured acceleration.
