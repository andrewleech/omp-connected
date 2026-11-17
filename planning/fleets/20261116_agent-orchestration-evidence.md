# Agent orchestration, review and context evidence

Date: 2026-11-16
HEAD: 083b26e

## Source

Source: `/tmp/transcript.html`, titled “Rethinking Agents, Plus Show Updates”. The transcript was generated automatically and may be inaccurate. These notes record its claims as investigation leads, not independently verified evidence. Timestamps refer to the transcript.

## Orchestration and fleet shape

- **8:32–9:19:** An orchestrator determines the work, then launches a workload-sized set of sub-agents. Each worker receives a separate task, its own context and an output format. Workers need not know about one another. The transcript contrasts a simple fact check with a difficult task that may use ten or more workers.
- **9:04–9:19:** The Orp example separates routing from execution. Its orchestrator selects agents, models and context slices; workers perform the task. Ramp's “inspect” coding agent is cited as a team-shared agent.
- **9:19:** The stated context strategy is to keep summaries and key context with the orchestrator, then give each worker a narrow instruction and clean context.
- **17:19–18:21:** The speaker describes a shift from fixed, persistent named agents to dynamically sized fleets, fresh task context, changeable models/workers and shared organisational context. The transcript says role-based decomposition (planner/coder/tester/reviewer) can create costly handoffs and coordination. Treat this as a design risk to test, not a rule against specialist agents.
- **18:21–19:55:** The speaker compares the approach to an on-demand consulting engagement: a goal or signal, an engagement lead who staffs the work, deliverables with evidence, human sign-off and ownership, then workers disappear while work records remain.

## Cross-review and evidence

- **9:36–10:25:** Verification is a separate stage. The transcript cites Shopify security findings as claims requiring proof, including an exploit test; a different model checks the finding. It also cites a RunLayer workflow where an implementation agent supplies before/after screenshots or a walkthrough, followed by adversarial review from another agent and post-ship QA that attempts to break the feature.
- **10:25:** The speaker's summary is to check the work and use a different agent from the producer as the checker.
- **15:25–15:42:** Warp is cited as using scoring agents to grade completed runs and another agent to propose system improvements as pull requests for human review.

## Human review and accountability levels

The transcript describes risk-scaled review and an identifiable human owner; it does not prescribe one universal approval policy.

- **13:18–13:59:** Decide in advance which work requires human review, and retain the person accountable for the result. Uber is cited as carrying responsibility through agent-to-agent calls. Stripe is cited as requiring a human reviewer for every merge.
- **13:59–14:16:** RunLayer is cited as allowing small, low-risk changes to merge automatically, with humans available when asked. Ramp's finance agents are cited as approving low-risk expenses or recommending a decision with reasoning, with each customer choosing where autonomy stops.
- **14:16:** Snap is cited as spending more than half of its agent investment on guardrails.
- **19:39–19:55:** In the consulting analogy, the internal customer signs off and owns the result; agents do not become the accountable party.
- **20:22–20:56:** The transcript recounts a study in which managers scrutinised work less when it was labelled as coming from an AI teammate. The speaker cautions against overgeneralising from one early study. This supports explicit review expectations and avoiding person-like framing that weakens scrutiny; it does not establish a universal effect.

## Signals

- **7:21–8:14:** Work can start from business or operational events rather than a person converting the event into a prompt. Examples include customer messages, invoices, renewals, alerts, failed builds, Slack mentions and product pins. Uber is cited as having agent sessions initiated by other agents for code review, CI repair and on-call triage.
For each candidate signal, record its source, resulting task, expected evidence, autonomy boundary and responsible human. This makes the decision to trigger work automatically explicit.

## Context and memory

- **3:44–5:48:** “Content maxing” is described as giving agents access through MCP or CLI to broad organisational sources, including meetings, Slack, email, Drive and other tools. The transcript also cites shared decision records that preserve decisions, rationale and inputs.
- **5:15–5:48:** Ramp is cited as ingesting Slack, Notion, Linear and Calendar into persistent memory; Uber as building a context graph across more than 30 systems; Shopify as keeping code, skills, conventions, runbooks and agent instructions together.
- **5:30–6:08:** Broad context needs active maintenance. The transcript says stale or neglected context degraded an analyst agent and notes that people may hoard knowledge for job security.
- **9:19:** The orchestration design offers a complementary approach to context limits: keep shared summaries centrally and give workers only the context needed for their task.

## Questions to investigate

- Which tasks in this project suit a dynamic fleet rather than fixed role-based agents?
- What concrete risk levels and human approval gates fit the workflows? How will responsibility carry across agent handoffs?
- What proof is acceptable for each task type, and how independent must the reviewer be?
- Which signals are reliable and safe to trigger work, and which actions must stop for human approval?
- Which context sources can agents access, how are permissions enforced, and who maintains decision records and memory freshness?
- How can shared context stay useful without giving workers unnecessary or stale material?
