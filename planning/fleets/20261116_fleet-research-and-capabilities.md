# Fleet planning: distilled research and capability map

Written: 2026-11-16
Repository baseline: `71fe4ae`.
Purpose: inform a project-specific omp-connected fleet that aims to reduce delivery time dramatically against the **101.4 Engineer-day** traditional software plan.

## Planning conclusion

Use ompc as the fleet connection and visibility layer, with a project coordinator assigning bounded work to software workers and dedicated hardware owners. Build concurrency around ready deliverables and shared interface contracts. Retain independent evidence-based review and explicit human authority over consequential decisions. Treat hardware availability, integration throughput and review capacity as scheduling resources.

This is a synthesis of earlier research and a source-level capability assessment, not a runtime verification of a deployed fleet. The [source inventory](20261116_agent-orchestration-sources.md) records the external links and confidence limits; the [transcript notes](20261116_agent-orchestration-evidence.md) preserve timestamps. The [project baseline](20261116_smart-trolley-traditional-baseline.md) and [pitch brief](20261116_smart-trolley-fleet-pitch.md) hold the project-specific scope and proposal.

## Research distilled into operating decisions

| Learning | Evidence and limit | Fleet decision |
|---|---|---|
| An orchestrator can staff parallel work dynamically | [Anthropic research system](https://www.anthropic.com/engineering/multi-agent-research-system): lead agent with parallel workers; internal research evaluation, not a coding-delivery benchmark | Assign ready work packages with a contract, context slice and output format. Scale workers to independent work rather than keeping every role permanently busy |
| Excessive role handoffs consume context and coordination | [Anthropic multi-agent guidance](https://claude.com/resources/articles/building-multi-agent-systems-when-and-how-to-use-them): context boundaries matter; thematic match rather than confirmed podcast source | Give one worker an end-to-end deliverable where practical. Add a separate checker without forcing every task through a fixed planner/coder/tester relay |
| Claims need executable proof | [Shopify verification harness](https://shopify.engineering/building-an-agentic-harness-that-outlasts-the-model): another model tests candidate security findings | Require behaviour evidence against acceptance criteria. Review the diff and evidence independently; reproduce uncertain results, especially on target |
| Human responsibility and human approval are different controls | [Uber attribution](https://www.uber.com/au/en/blog/solving-the-agent-identity-crisis/) and [Stripe Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents): attribution chain versus human merge review | Carry the accountable human, task and revision through handoffs; record approvals separately. Start with human merge review, then approve bounded automation classes explicitly |
| Shared context avoids repeated discovery | [Shopify River](https://shopify.engineering/under-the-river) and [Every's shared-agent account](https://every.to/source-code/why-we-replaced-personal-agents-with-one-for-the-whole-company): first-party accounts, not general comparative trials | Maintain shared requirements, interfaces, decisions and accepted findings. Keep worker execution contexts narrow and disposable |
| Signals can remove manual dispatch delays | [Runlayer Agents](https://www.runlayer.com/blog/runlayer-agents): event/webhook/schedule product capability claim | Trigger bounded tasks from readiness, test failures, review readiness and hardware availability; define permitted actions and escalation for each signal |
| Harness improvement can compound across runs | [Warp scoring](https://www.warp.dev/blog/using-llm-as-a-judge-scoring-to-measure-your-software-factory): scoring and proposed skill changes, not independent proof of benefit | Record recurring failure causes and propose reviewed improvements to procedures. Measure accepted outcomes and rework rather than trusting judge scores alone |

These are mostly first-party reports. Do not present Anthropic's 90.2% research-evaluation result as a development speedup, use token volume as productivity, or promote unresolved podcast numbers into pitch claims. Different reviewer models can share errors; diversity supplements runnable evidence and human accountability.

## Shared context and memory design

“Content maxing” is useful as access to relevant project knowledge, not an instruction to fill every context window. Give agents approved retrieval access to design inputs, requirements, source, interface contracts, recorded target behaviour and decisions. Keep sensitive material within approved services.

Separate authoritative records from working memory. Approved requirements and interface decisions need provenance, an owner and a revision. Agent observations need the source revision, target/configuration where applicable and evidence links. Mark interpretations as such. A changed interface invalidates dependent assumptions and may require rerunning evidence. Shared summaries help navigation but cannot silently override primary records.

For this project, prioritise the scheduler/simulation contract, driver interfaces, state recovery, recipe semantics, fault behaviour and API contract. These unblock parallel work. Resolve the report's AI-inference-only claims through the accountable humans rather than distributing them as established facts.

## Existing ompc capabilities versus fleet additions

The source inspection covered the README, both architecture documents and the implementing registry, extension and session RPC code at the repository baseline above. “Not established” means the inspected implementation does not supply the proposed workflow; it does not prohibit implementing it with agents and project records.

| Area | Existing capability | What the fleet plan must provide |
|---|---|---|
| Multi-machine visibility | Live agent/host discovery, grouped dashboard sessions, activity and session controls | Ready-work and blocked-work views tied to project tasks, not just live sessions |
| Coordination | Direct/team messages, team membership, agent identities, mailboxes and queryable events | Work contracts, assignment, dependencies, completion criteria and reconciliation |
| Worker launch | Start/resume sessions on hosts through an online capable extension and a local control-shared Collab session; local tmux launch/reattach | Capacity-aware dispatch and worker configuration. This does not provision an offline machine or launch arbitrarily over SSH |
| Model and agent configuration | Dashboard/session RPCs expose configured agent roles and read/edit model-role assignments on capable runtimes; model/thinking and compaction controls are also available | Choose producer/reviewer models and budgets deliberately. Role configuration does not itself assign work or enforce independent review |
| Prompt scheduling | Up to 20 delayed or next-idle prompts per session | Cross-session event-to-task rules and dependency scheduling. Session queues are in memory: they survive a hub restart while the session stays alive, but not session shutdown or conversation change |
| Context access | Per-session working-directory files and context-usage display | Shared project knowledge, provenance, freshness and access policy |
| Human interaction | Dashboard viewing/control and underlying tool approval categories | Producer/reviewer separation, review queue, explicit acceptance and human approval records |
| Hardware | Workers can use whatever authorised external tools their host/session supplies | Target compatibility, inventory, exclusive reservations and physical-action policy. Existing session ownership/launch leases do not lock hardware |
| Evidence and observability | File upload/download, bounded event history, session token/context and supported provider quota information | Durable revision-bound evidence, attribution through delegated work and delivery/cost metrics |
| Project separation | Shared dashboard session groups | Actual project access boundaries and policy enforcement. Grouping sessions is not security isolation |

### Source pointers and reliability limits

- Discovery, messaging and controls: [hub architecture](../../hub/ARCHITECTURE.md), sections around lines 19–181; [extension tool registrations](../../extension/src/index.ts), lines 438–568.
- Runtime capability exposure: [extension architecture](../../extension/ARCHITECTURE.md), lines 13–18, documents model/agent roles and capable-host launches; hub architecture lines 194–201 document identity-claim limits.
- Mailboxes, identities and events: [agent registry](../../hub/src/server/agent-registry.ts), lines 173–258, 429–663 and 827–834. Mailbox queues, message idempotency and the bounded event buffer are in memory. Reconnect retry is not durable delivery across a hub restart; disconnected agent entries expire after five minutes. A receive acknowledgement does not establish task completion.
- Host launch prerequisites and ownership: [host sessions](../../extension/src/host-sessions.ts), lines 83–130 and 168–267; [extension launch integration](../../extension/src/index.ts), lines 90–125.
- Session-owned prompt queues: [scheduled prompts](../../extension/src/scheduled-prompts.ts) and [extension handlers](../../extension/src/index.ts), lines 292–370.
- Files: [session RPC routes](../../hub/src/server/session-rpc-routes.ts), lines 620–758. File transfer alone does not establish artifact integrity, approval or provenance.

The hub architecture documents shared-token agent registration without independently verifying claimed host/session identity, and no dashboard-user authentication. Do not assume this provides the access or attribution controls needed for a separate confidential project. Define the deployment trust boundary and assess required access controls before connecting project sources and hardware. Session groups are documented persistent state; the live message/event records are not a durable audit trail.

### What can be used without a new orchestration platform

An existing coordinator session can use messages and teams to direct already connected workers, and use supported host launch to start more sessions. Versioned task records and existing repository/CI controls can carry dependencies, review dispositions and evidence. This is an agent-driven workflow assembled from available primitives, not a native ompc dependency scheduler.

The immediate additions should close specific gaps: recoverable task state, ownership of work and targets, bounded dispatch, and reviewable evidence. Add generic scheduling or memory services only when the project workflow needs them. Preserve useful existing launch, messaging and dashboard functionality instead of rebuilding it.

## Boundaries between products and project workflow

The local omp runtime's subagent facilities, model selection and tool permissions are distinct from omp-connected's cross-session connection layer. Mounted hardware tools are an external capability. Their presence in one session does not establish fleet-wide installation, project-board compatibility, exclusive target ownership or unattended-operation approval.

The mounted pod tool descriptions include target programming, reset/debug access, persistent REPL sessions and bench I/O/capture. Their contracts include a single-client REPL and stale USB/IP export handling after target re-enumeration. This reference does not claim those paths have been exercised on the trolley hardware. A project hardware worker needs the correct target/toolchain, stable device identity, authorised operating conditions and a reservation that other workers respect or cannot bypass.

## Practical application to the 101.4-day plan

Advance independent host-testable software packages while hardware owners establish target evidence. Reuse the proposed host simulator and mocks; do not wait for the full trolley to implement every control, recipe or lifecycle behaviour. Preserve predecessor contracts and converge on a tested integration revision.

A fleet can reduce engineer touch time as well as overlap work: workers implement and investigate, reviewers challenge evidence, and target owners run repeated build/flash/test cycles without an engineer manually relaying each step. This is the acceleration mechanism to quantify. It does not remove physical soak duration or unresolved client decisions.

Use the baseline's **76.4 pre-hardware** and **25.0 hardware-associated Engineer-day** categories to locate opportunities, not as two sequential calendar blocks. Model actual worker, target and human-review availability. Account separately for Principal engineer oversight, infrastructure/model costs, omitted scope and setup work.

## Proposed additions, ordered by delivery need

These are proposed requirements, not commitments to add every item to ompc itself. Prefer a project workflow over a new general-purpose service unless enforcement or recovery requires a platform feature.

| Need | Smallest useful provision | Why it matters |
|---|---|---|
| Work contracts and dependency state | Versioned task records with prerequisites, owner, revision, acceptance criteria and evidence links | Dispatches only ready work and keeps completed code distinct from accepted outcomes |
| Conflict-free implementation and integration | Owned branches/worktrees and a controlled integration queue | Prevents parallel workers overwriting shared files or overwhelming integration |
| Hardware ownership | Stable target inventory, named human authority, exclusive reservation and controlled programming/reset access | Prevents one worker invalidating another's target run; physical actions stay within approved limits |
| Independent review and approval | Producer/reviewer separation, explicit dispositions and human decision records | Keeps cross-review useful and approval attributable |
| Shared context with freshness | Versioned project knowledge, provenance and invalidation rules | Reduces repeated discovery without spreading stale assumptions |
| Event-driven dispatch | Approved signal-to-task rules tied to recorded state | Reduces idle gaps without unbounded scope creation |
| Recoverable work | Persist task state and reconcile worker/host loss before reassigning | A missing session must not silently lose work or duplicate a physical operation |
| Evidence and outcome metrics | Revision-bound build/test artifacts, review results, elapsed time, engineer touch time and cost | Supports both engineering acceptance and a defensible acceleration claim |

## What the plan should measure

Track ready-to-accepted elapsed time, engineer intervention, review and integration waiting, defect escapes, rework, hardware occupancy and cost. Link these to accepted work packages and revisions. Use a representative real execution wave to calibrate the aggressive schedule, including software concurrency and target integration. Do not require a separate research programme before starting useful work, and do not extrapolate one successful worker run into a project-wide multiplier.
