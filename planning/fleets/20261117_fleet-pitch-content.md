# Smart Trolley fleet delivery proposal

## Metadata
- author: Andrew Leech
- date: 17 November 2026

---
<!-- slide: 1, template: 1 -->
# title
Smart Trolley fleet [yellow]delivery[/yellow]
# subtitle
Development proposal
# date
17 November 2026
# author
Andrew Leech
# client
Exec / PM / software RGM
## notes
I propose a project-specific agent fleet to reduce development effort and elapsed delivery time. The figures are forecasts awaiting calibration against project work; the fleet has not been commissioned.
---
<!-- slide: 2, template: 15 -->
# title
Target delivery [blue]forecast[/blue]
# key_message
Target scenario
55.2 working days
11.0 weeks
# body
- Parallel implementation with independent cross-review
- Hardware agents run approved build/program/test cycles
- Engineer decisions and human review retained
- Setup and ongoing coordination included
## notes
The target is 55.2 working days, or 11.0 weeks, for the sized scope and setup. Engineer effort falls by 72.7 days and Principal effort by 2.5 days. The elapsed forecast is 48.7% below the source's draft schedule. One-off setup includes 7.5 Engineer days and 2.4 Principal days. The plan retains human approval of every merge and an initial allowance for decisions.
---
<!-- slide: 3, template: 4 -->
# title
Compare the delivery [blue]options[/blue]
# body
Compare the sized scope, with fleet setup included.
## notes
The comparison covers the same 30 sized work packages, with fleet setup added. Engineer and Principal effort includes setup and ongoing coordination. Operator work adds 4.4 days; the source gives no operator effort baseline. The traditional estimate is 101.4 Engineer days and 15.2 Principal days. Its draft schedule is 21.5 weeks. The displayed ticket values sum to 101.5 Engineer days, and the rounded combined headline is 117 person-days. The source team and focus assumptions are unagreed, so elapsed comparisons remain provisional. ERP link, phone UI and release verification are unsized and excluded. Source: planning/fleets/20261116_smart-trolley-traditional-baseline.md
---
<!-- slide: 4, template: 4 -->
# title
Target delivery [blue]milestones[/blue]
# body
Acceptance gates use working days from the start of the plan.
## notes
Each gate requires accepted evidence. The final gate covers 30 sized work packages and setup. Hardware supply, procurement and unresolved decisions can move the dates. Physical test durations remain subject to approval by the test authority.
---
<!-- slide: 5, template: 5 -->
# title
Give each task an [blue]owner[/blue]
# body_1
**Delivery and review**
- Workers own one deliverable and its evidence
- A separate agent reviews each change
- A named agent controls each hardware station
# body
**Coordination**
- Keep task state and dependencies in shared records
- Assign ready work and manage resource conflicts
- Route scope and release decisions to human owners
## notes
The project lead assigns the coordinator, integration owner, reviewers and hardware owners. Each worker owns a bounded deliverable, its branch and its evidence. The reviewer is separate from the producer. A stable hardware owner controls access to each station.
---
<!-- slide: 6, template: 5 -->
# title
Use ompc for [blue]coordination[/blue]
# body_1
**Project workflow adds**
- Record tasks, dependencies and decisions durably
- Give workers separate worktrees and control integration
- Record reviews, approvals and test evidence
- Reserve identified hardware through its owner
# body
**ompc provides**
- Find agents and sessions across machines
- Send direct and team messages
- Start and control sessions on connected, capable hosts
- Queue prompts and inspect session events
## notes
Use ompc's existing session and messaging functions. Host launch requires a capable connected extension and local control access. Keep task, evidence and reservation records outside the hub: its mailbox and event history are in memory. Queued prompts belong to the session and are lost when that session shuts down or changes conversation. Physical access needs its own reservation controls; ompc's launch leases cover sessions. Source: planning/fleets/20261116_fleet-research-and-capabilities.md.
---
<!-- slide: 7, template: 4 -->
# title
Keep [blue]people[/blue] accountable
# body
- **Investigation:** agents gather evidence; humans decide requirements and scope
- **Implementation:** agents build and cross-review; a human approves every merge
- **Automation:** run only approved repeatable jobs within recorded limits
- **Consequential decisions:** humans approve safety changes, physical exceptions, acceptance and release
## notes
Any later exemption needs an approved low-risk change class, operating evidence and a way to withdraw that permission. Human authority covers requirements, interfaces, safety interpretations, physical-operation exceptions, consequential evidence acceptance and release. Agent checks provide evidence for those decisions. Sources: the execution and assurance plan; Stripe: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents; Shopify: https://shopify.engineering/building-an-agentic-harness-that-outlasts-the-model
---
<!-- slide: 8, template: 5 -->
# title
Plan around the [blue]hardware[/blue]
# body_1
**Required checks**
- Dry-out and fail-safe disconnect behaviour
- Offline logging/replay and outage recovery
- Every channel, including forced faults
- Integration, soak and release verification

Retain approved physical test durations.
# body
**Resources**
- One main hub/development computer
- Other computers where hardware access or capacity requires them
- Cautious/target/stretch: 3/6/10 execution slots and 1/2/3 boards
- Operator: 4.4 days at 0.25 FTE
## notes
The counts are planning assumptions. All three scenarios use boards ready at workday 5, one prototype ready at day 10 and one production fixture ready at day 10. Each station needs its own board, probe, peripherals and approved access. Extra sessions cannot share a target destructively. Setup is counted once. Local GPU inference is not assumed; check the chosen machine and provider capacity before committing. Active physical test and observation durations are the same in every primary scenario. Sources: planning/fleets/20261117_fleet-setup-ticket.md and planning/fleets/20261117_fleet-scenario-assumptions.json.
---
<!-- slide: 9, template: 5 -->
# title
Use the published [blue]lessons[/blue]
# body_1
**Shopify and Stripe**
- Test proposed findings and reproduce uncertain results
- Keep human review before merge
- Track accepted work, rework, defects and cost
# body
**Anthropic**
- A lead agent delegates parallel research
- Split work at useful task and context boundaries
- Size the worker pool to independent work
## notes
These are mainly first-party accounts. Anthropic's 90.2% result was an improvement on its internal research evaluation, not a coding-speed multiplier. Shopify describes tests that check proposed findings. Stripe retains human merge review. Use those practices and measure this project's results. Anthropic: https://www.anthropic.com/engineering/multi-agent-research-system; Shopify: https://shopify.engineering/building-an-agentic-harness-that-outlasts-the-model; Stripe: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents; Uber's attribution chain: https://www.uber.com/au/en/blog/solving-the-agent-identity-crisis/.
---
<!-- slide: 10, template: 5 -->
# title
Count [blue]effort[/blue] and cost separately
# body_1
**Cost basis**
- Charge actual effort where capacity can be reused
- Price the full allocation if people are reserved
- Keep unsized work outside the savings comparison
- Confirm external hardware and decision dates
# body
**Engineer capacity**
- Count setup and coordination once
- Use released time on other work
- Price operator effort separately
- Confirm rates, model spend and equipment quotes
## notes
Price actual effort where people can use their remaining time elsewhere. If the project reserves them for the full window, price elapsed workdays times assigned FTE times the daily rate for each role. Add operator work, equipment and model/service costs. Confirm the source staffing, focus and charging basis before claiming a cash saving. The comparison excludes the unsized ERP link, phone UI and release verification. Original exclusions remain: AX-mini software, ERP-side software, PC recipe-authoring/fleet-view software and air-generation plant.
---
<!-- slide: 11, template: 4 -->
# title
What moves the [blue]timeline[/blue]
# body
Review effort, operator availability and physical duration drive the forecast.
## notes
Each row changes one target assumption. These are sensitivity cases, not confidence percentiles. Extra worker slots alone do not shorten the modelled target schedule. Confirm machine capacity, provider quotas, physical readiness and stakeholder decisions before agreeing dates.
---
<!-- slide: 12, template: 15 -->
# title
Approve the first [blue]wave[/blue]
# key_message
Agree the resources and owners.
Start the first delivery wave.
# body
- Assign decision, review and acceptance owners
- Confirm machines, stations and budget
- Start host work while station setup proceeds
- Update the forecast from delivery results
## notes
Agree the working scenario and resource allocations. Assign the coordinator, integration owner, independent reviewers, hardware owners and human decision authorities. Confirm the main computer, target inventory and initial budget. Start bounded host work while stations are commissioned, then include a real target cycle. Record effort, elapsed time, rework, defects, waiting, target occupancy and cost. Update the remaining forecast from those results. The decision covers resources and the first wave. It sets no release date and claims no measured acceleration.
