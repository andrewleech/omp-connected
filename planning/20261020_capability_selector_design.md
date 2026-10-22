# Design: classifier-based capability selector

Date: 2026-10-20
Source: fork integration branch `ompc-fleet` at 5383c058fd (upstream `v18.10.4` plus fork feature branches; the tree already carries 18.12.x changelog entries). Anchors were read there, not at a release tag, and need a re-check against `upstream/main` before a PR.
Status: proposal for discussion; no code written. Replaces `20261019_model_profiles_design.md` as the planned way to shrink the initial context. That document stays as a record of measurements.

All paths are relative to `packages/` unless stated. "Jev" is TypeSafe's hosted System One decision model. "jeff" is a self-hosted, wire-compatible reimplementation (`logan-markewich/jeff`).

## Summary

- A session sends the list of everything it could use (skills, MCP routes, task agents, tool schemas) on every request. Most prompts need none of them, or one or two.
- Proposal: when `selector.enabled` is on, omp removes those lists from the system prompt and keeps them in an in-memory registry. A small classifier (a Jev-style judge) matches each incoming user prompt against the registry. Matches are made available to the model through one hidden notice placed ahead of the prompt. The model also gets one always-present pull tool, `capability`, to ask the same classifier mid-turn.
- omp already contains most of the machinery. The native System One judge, the answer cache, the usage ledger, the fallback chain over the `judge` role, a text-bridge for ordinary chat models, a precedent judge-backed tool (`find`), and a mechanism for telling the model about newly mounted `xd://` tools without touching the system prompt all exist. The new code is the registry, the prompt stripping, the question builder, the injection hook, the pull tool, a `selector` model role and the settings.
- jeff needs no new transport. It speaks the same `POST /v1/systemone` wire as Jev, and omp's native judge already honours `TYPESAFE_BASE_URL`. What is missing is a way to point only the selector role at it, so the role needs its own base URL (see "Backends").
- This does not replace the model profiles in full. The measured Haiku result on one configuration was 25.6k tokens to 10.0k with the v1 profile knobs, and 7.9k of the 15.6k saved came from dropping context files and 4.7k from personality. A selector over tools, skills, MCP routes and agents reaches only the tool side. Section "What it saves, and what it does not" has the numbers. Context files and personality need a separate decision (see "Optional: context sections as capabilities").
- Hosted Jev sends the user prompt, and the registry descriptions, to a third party on every turn. This is opt-in, never `auto`. jeff or a local lexical matcher keeps everything on the machine.
- Independent integrations of the same idea report weak recall (the closest, `jev-skillful`, self-reports recall@K of 0.60 on a holdout and 0.82 on its dev set against a 0.90 target). The pull tool and a log-only shadow mode are part of the design for that reason, and the rollout gates default-on on a measured hit rate from real session history.

## Motivation

### Fixed load per session

Measured on one configuration (Haiku 4.5, estimator tokens, about 3.5 characters per token; full method in the profiles document):

- Skills list: about 6.9k characters (about 2.0k tokens).
- MCP route catalog: about 6.6k characters (about 1.9k tokens).
- Task agent list: about 1.2k tokens in a main session and 1.1k in a subagent (trimmed from 12 agents to 3).
- Tool schemas for the built-in tools: about 1.75k tokens to trim 12 tools to 7 in a main session, about 1.2k in a subagent.
- Skillful notice and base prompt are separate and not addressed here.

The profiles measurements did not isolate the skills list and the MCP catalog as separate knobs, because v1 profiles could not reach them. The character counts above are from the prompt dump; the token figures are the same counts at 3.5 characters per token. [INFERENCE] for the token conversion.

### Why per-model profiles are the wrong tool for this part

A profile removes a fixed set of things for a model, always. The user maintains the list, and a removed tool is gone for the whole session. A selector removes the same bytes from the prompt but lets any of them back in on demand, for any model, with nothing to maintain per model. For the tools, skills, MCP and agents part of the load the selector is the better fit. For context files and personality it is not, because those are not capabilities a prompt "selects" (see below).

### Why a classifier and not the model

A model can search a catalog if it is told one exists (that is the `skill_search` pattern in the Pi extension). The failure mode in that design is that the model must remember to call the tool, and models do not reliably do it for tools they have never seen. Push injection by a classifier that sees every user prompt removes that dependence. The pull tool stays as the fallback for the cases the classifier misses.

## Prior art

|Project|What it does|Relevant finding|
|---|---|---|
|`pi-jev-skill-picker` (Pi extension)|Strips the skill catalogue from the prompt; `skill_search(task)` asks Jev one 0-2 Score question per skill and loads the winners|137 skills: catalogue about 19k tokens (87% of the system prompt); stripping cut request size 84.6-87.9%. One search costs about 38.6k Jev input tokens (about 282 per skill, about $0.0016). Pull only: the model must call the tool|
|`jev-skillful` (hook, already supports omp)|Per-prompt hook; BM25 shortlist (skill 6, MCP 4, agent 3, command+rule 2, max 15), then one Choice over candidate ids plus `none` and one Noul per candidate; injects at most one primary and two runner-ups|About 1,360 input tokens and 0.7-0.9 s per request, independent of candidate count. Self-reported recall@K 0.60 holdout, 0.82 dev; BM25 vocabulary mismatch is the bottleneck; non-English 0.43. A separate "is any capability needed" Noul was dropped after measurement; abstention works better as a `none` option inside the Choice|
|`jev-agent-hooks`|Two-stage Choice (roster, then top 3 with the first 700 characters of the skill body); one-line injection|At the cookbook's fit threshold 0.3 it suggested a skill on 15 of 16 turns where the agent used none; 0.7 cut that to 3. Short generic phrasing misfires. Adds the last assistant text (1,500 characters) to the state so "ok, go ahead" carries meaning|
|`tool-prune`|Choice over tool names plus a Noul, with an offline vector fallback|On its own BFCL runs BM25 is competitive offline (88% top-1, 95% top-5 at 0.025 ms) against Jev (100% top-1 at 189 ms). Author-reported|
|TypeSafe skill-suggestion cookbook|182 skills in one Choice, injected after the cache breakpoint|Wrong-skill loads 16.8% without suggestion, 7.3% with, 2.5% oracle. First call 0.16-0.31 s|

All figures above are author-reported by the projects, not reproduced here.

`jev-skillful` already runs on omp as an external hook (it reads the omp skills, agents, rules and `mcp.json` directories). It cannot remove anything from the system prompt, cannot mount tools, and is a separate install with its own credentials. Those three gaps are what a core feature adds. Installing it is the cheapest way to measure hit rate before building anything (see phase 0).

## What omp already provides

### The judge layer (`ai/src/judgment`, `coding-agent/src/judgment`)

- `ai/src/judgment/types.ts`: the `Judge` interface. A `JudgmentRequest` is a state (string, object or array) plus named questions (`choice`, `noul`, `score`, `box`). The shape mirrors TypeSafe System One. Answers carry probabilities and a concentration-based `confidence`.
- `ai/src/judgment/native.ts`: the native backend forwards the request verbatim to a wire. Wires: `typesafe` (`ai/src/judgment/systemone.ts`), OpenRouter Decisions, OpenAI Decisions, Workers AI Clef. The base URL is `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`), the model `TYPESAFE_DEFAULT_MODEL` (default `jev-latest`), the key `TYPESAFE_API_KEY` through the auth registry.
- `ai/src/judgment/text.ts` and `chat.ts`: the text bridge renders the same questions into keyword prompts for an ordinary chat model, so a judge role pointed at any chat or tiny model still works.
- `coding-agent/src/judgment/index.ts`: `resolveJudge(deps)` returns a `ChainJudge` that walks the live `judge` role chain (primary plus fallbacks), with candidate caching (`CANDIDATE_TTL_MS`), credential and failure handling, abort and timeout semantics. `kindOf` classifies a candidate as `native`, `local` or `online`. `hasNativeJudge` reports whether the primary is native. `JudgeDeps` takes `purpose` (labels ledger entries and telemetry), `onUsage` (`journalJudgmentUsage` bills the session ledger), `telemetry` and `cache`.
- `coding-agent/src/judgment/cache.ts`: a SQLite answer cache keyed by state id, model and per-question key (name, type, instruction, criteria). It is shared through `sharedJudgmentCache()`. A stable registry text gives cache hits for repeated questions.
- Consumers already using it: auto-thinking, auto-prewalk (`auto-prewalk/classifier.ts:120-145` is the closest shape: typed route question, `hasNativeJudge` gate, convert answer to decision), unexpected-stop, `find` (`tools/jfind`), and typed `judge()` in eval.
- `tools/jfind/index.ts`: `find.enabled` is `auto | on | off`. `auto` follows `hasNativeJudge`. The tool builds its own `resolveJudge` with `purpose: "find"`, a 20 s timeout, ledger and shared cache. The selector copies this shape.

### Model roles

- `tui/src/overlays/model-browser.ts:70-100`: `ModelRole`, `MODEL_ROLE_IDS`, `CHAT_MODEL_ROLE_IDS`, `KIND_ROLE_IDS`. `judge` is a kind role.
- `coding-agent/src/config/model-roles.ts:42-93`: eligibility predicate and `MODEL_ROLES` metadata. Judge accepts catalog kinds `judge`, `tiny` and `chat`.
- `coding-agent/src/config/model-resolver.ts:1190-1238` and `:1574-1610`: alias expansion, built-in role default chaining, `resolveRoleChain()` (primary selector plus fallback chain, deduplicated). A role with default candidates needs an entry in the role priority defaults here, not only an ID.
- `tui/src/overlays/model-hub.ts`: the `/model` hub renders roles from `knownRoleIds` and `getRoleInfo()`, so a registered role appears without a dedicated row. `config/model-settings.ts:80-122` stores `modelRoles` as a generic record; no per-role schema key is needed.
- `extensibility/extensions/model-role-api.ts`: extension-facing role lookup; validates known roles.
- CLI: there is no per-role flag convention beyond generic `--model <role alias>`; a dedicated flag is optional.

### Injection mechanisms

- `before_agent_start` (`extensibility/extensions/types.ts:1074-1099`, runner `extensibility/extensions/runner.ts:2168-2248`, call site `session/agent-session.ts:8060-8155` in `#prepareAgentStart`). It runs once per submitted user prompt or dequeued user-containing batch. The result may return a custom `message` and a replacement `systemPrompt` for that turn. Returned messages persist as `role: "custom"`; `display: false` hides them in the TUI. It does not run for steering messages during an active run, per tool-loop step, or for subagent task prompts.
- `before_subagent_spawn` (`extensibility/extensions/runner.ts:2248-`): a separate hook for spawn-time model, note and block decisions.
- Hidden-notice precedents: `/skillful` queues a hidden `skillful-notice` with `{ deliverAs: "nextTurn" }` (`session/agent-session.ts:10700-10724`); session tools emit hidden roster and prelude notices as custom messages (`session/session-tools.ts:1544-1632`).
- The `xd://` mount notice is the closest precedent for what the selector injects. `session/session-tools.ts:1408-1470` (`#notifyXdevMountDelta`) records mid-session mounts as a coalesced delta that rides with the next prompt rather than as a steered message, because a steered notice at a stop boundary forces an extra assistant turn. The notice template (`prompts/system/xdev-mount-notice.md`) lists the device summary (marked untrusted metadata) and tells the model to `read xd://<tool>` for docs and schema, then write a JSON args object to execute. `resetAnnouncedMounts()` and `#ensureAnnouncedMountsSeeded()` rebuild the announced set from persisted notices on resume. System prompt and provider cache prefix stay byte-stable for non-MCP mount churn.
- `xd://` devices are not ordinary top-level tools. The prompt carries their catalog and docs, and the model calls them through `write` with an `xd://` URL, so they add no schema to the provider request's tool array (`agent/src/agent-loop.ts:1028-1051`, `:1960-1964`, `:2078-2082`; `:2888-2892` for host fallback dispatch). [INFERENCE] about cache benefit; schema bytes are absent from the request, but a cache hit rate was not measured.

### System prompt composition

- `coding-agent/src/system-prompt.ts:514-593,613-618`: builder options. Skills load only when `skillsSettings.enabled !== false` and render only when a tool with `skill://` read access exists; skills with `hide: true` are excluded from the list (`:797-802,887-939`). Tool inventory and the `xd://` catalog render at `:887-915,958-1001`; the template is `prompts/system/system-prompt.md` (skills and rules `1-23`, internal URL descriptions `28-53`, tool inventory and `xd://` catalog `55-78`).
- `session/session-tools.ts:176-`, `:874-878`, `:1019-`, `:1074-`: mounted MCP route collection, selected MCP tools, the active tool set and the `xd://` partition. `:1235-1239` rebuilds the system prompt after a tool-set change. `xdevCatalogNames` records which device names the current base prompt renders in its catalog.
- Agent and task descriptions come from the prompt context and registries (`session/session-tools.ts:587-590,1624-1632`).

### Compaction

`session/session-maintenance.ts:470-475,827-830,960-964,1349-1351,1957-1965,2466-2525`: the latest compaction entry hides its prefix from the wire context. Hidden custom messages enter the same history and are summarized like any other message. A notice is not durable across compaction.

## Design

### Registry

One in-memory `CapabilityRegistry` per process, built at session start from existing sources and rebuilt when the tool set changes (for example an MCP server connecting, which already triggers a prompt rebuild at `session/session-tools.ts:1235`). It is not persisted; a restart rebuilds it from disk and live MCP state. This matches the requirement that the list resets on each power cycle.

Each entry:

|Field|Meaning|
|---|---|
|`id`|Stable key, `<kind>:<name>`|
|`kind`|`skill`, `mcp` (a route or server), `agent`, `tool`, later `context`|
|`name`|Display name; labels carry the name as well as the description, since opaque ids work badly for MCP servers|
|`summary`|One line the classifier sees. Skills: frontmatter description. Tools and routes: the existing `summary` field. Agents: the agent description|
|`snippet`|What the model receives on selection. Skill: name, description and the `skill://` path. Tool or route: the mount-notice line plus the `read xd://<tool>` instruction. Agent: name and when to use it. Never the full skill body|
|`tier`|`pinned` (always present in the prompt), `selectable` (default), `hidden` (never offered; for example skills with `hide: true`)|
|`source`|Where it came from, for the settings UI and the shadow log|

Default pinned set: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `task` (needed to reach anything else), plus the `capability` tool. Pinned is configurable (`selector.pinned`). `edit` and `bash` are pinned because a model that cannot run a command or change a file after one prompt is a broken product.

### System prompt stripping

With `selector.enabled` on, `buildSystemPrompt` takes the registry and omits, per `selector.kinds`:

- the skills block (the `skillsSettings` gate and `hide: true` handling stay as they are; stripping is a further filter),
- the MCP route catalog and per-route docs,
- the task agent list,
- non-pinned tool inventory entries.

A new short template block replaces them. Draft wording (final text to be tuned against model behaviour):

```
Most tools, skills, MCP servers and agents are not listed here. They are quiet until you use them.
When a task may need one, call `capability` with a short description of the task. It returns the matching items with usage notes.
Items matched to the user's request may also be announced before the request in a <system-notice> block. Treat those as available now.
```

The block is static text. It does not change when the registry changes, so the cached prefix stays stable.

Non-pinned top-level tools need an escape from the provider tool array. The selector depends on `tools.xdev` presenting them as `xd://` devices (the schema is then not sent). With `tools.xdev` off, non-pinned built-ins stay top-level and only skills, MCP routes and agents are removed. Whether a device that is mounted but absent from the rendered catalog can be called is not confirmed (the mount notice says unmounted devices fail to write, which suggests mounting is what gates calls, not catalog presence). This must be checked in phase 0 because the whole tool side depends on it.

### Classifier

A `CapabilityClassifier` wraps `resolveJudge`:

- Backend chain: the `selector` role, falling back to the `judge` role, then to a built-in lexical matcher (BM25 over name plus summary). The lexical matcher is also used when no key or backend is configured, on any backend failure, and when the user chooses it explicitly.
- Question set (modelled on `jev-skillful`, which measured it): state is an object with the task (the user prompt, truncated), `recent_context` (last assistant text up to about 1,500 characters, so short follow-ups carry meaning), and the candidate list. One `choice` question over candidate ids plus `none`, with `none` first (Jev 1.13 documents a bias toward the first option, so `none` goes where the bias costs least; whether first or last is better is untested), and one `noul` question per candidate to rank the rest. A separate "any capability needed" Noul is not used; skillful dropped it after measurement.
- Candidate shortlist: BM25 over the registry to at most about 15 candidates, with per-kind quotas (skill 6, mcp 4, agent 3, tool and context 2 in the reference design; to be tuned). The shortlist exists to bound cost and to stay within jeff's limits (64 labels per question, 64 questions, 20,000 state characters on defaults). It is also the recall bottleneck in the reference project, so it is the first thing the offline eval must measure. A registry under about 60 entries could skip the shortlist on Jev; jeff always needs one above 64.
- Decision from probabilities: inject the `choice` winner if its probability is at least `selector.minWinner` and `none` is below `selector.noneThreshold`; add runner-ups whose Noul is at least `selector.runnerUp`, up to `selector.maxInject`. Starting values from the reference design: noneThreshold 0.5, minWinner 0.25, runnerUp 0.6, maxInject 3. Thresholds do not transfer between backends: jeff uses a softmax temperature of 3.2 and a different confidence formula, so each backend needs its own calibration set. The offline eval produces it.
- Why not one Score per candidate: the Pi picker does this (about 282 tokens per skill). It costs 3 to 4 times more per call than a Choice, and on jeff Choice and Score questions share one encoder pass and "can affect each other" unless `JEFF_ISOLATE=all` is set. Noul is isolated by default on jeff. Choice plus Noul avoids the coupling.
- Cost and latency: about 1,360 input tokens per request and 0.7-0.9 s hosted (reference measurements), roughly 100-150 ms from a local GPU for jeff (its own benchmarks). Input is billed at $42 per billion tokens on hosted Jev; output is free. These are all author- or vendor-reported.
- The judge cache already keys answers by state plus question. Repeated prompts and a stable registry hit it without extra work.
- Failure handling is by value, not exception: a decision is `injected`, `skipped` (with a reason) or `degraded`. The path never throws into the prompt flow and never blocks beyond `selector.timeoutMs` (default 2,000 ms from the reference; `find` uses 20 s but is a user-waited tool call). On timeout or error the turn proceeds with no injection and the pull tool remains.

### Prompt gating (what is classified)

Classify only real user prompts that reach `before_agent_start`. Skip, without a network call:

- slash commands and `$`-style explicit mentions (the user already chose),
- prompts shorter than `selector.minPromptChars` (default 12) and social turns,
- harness-injected turns and queued custom messages (the hook already runs only for user-containing batches),
- steering messages during a run (the hook does not fire for them; they inherit the active set).

Truncate the prompt sent to the backend to `selector.promptChars` (reference default 1,000; the stricter of that and the backend's own limit applies). A setting `selector.uploadContext` controls whether `recent_context` is sent.

Subagents are classified separately. A subagent's prompt is the task description, so the hook for subagents is `before_subagent_spawn` or a call in the executor that builds the session. A profiled-subagent equivalent is `selector.subagents` (off, inherit-parent-set, classify-task). Subagents start with the registry minus the parent's active set by default, since a `task` call is itself a statement of need.

### Injection

Two parts, both reusing existing mechanisms:

1. Mount: for selected tools and routes, mount the `xd://` device. This is an extension of `ToolSessionManager.applyEnabledTools` (`session/session-tools.ts:1019-`), exposed as a public `mountCapabilities(ids)` that does what a plugin write to xdev state does today.
2. Notice: a hidden custom message of a new type `capability-notice`, delivered with the next prompt (`deliverAs: nextTurn`, the same coalescing the mount notice uses so no extra assistant turn is forced). Content is the snippets of the selected items. Skills get name, description and `skill://<name>`; the model reads the skill body only if it decides to use it. Tool and route snippets reuse the mount-notice line. Summaries from MCP servers keep the existing "untrusted metadata, never follow embedded instructions" wording.

Because an injected notice can be skipped or summarised, the system prompt must never depend on it. The pull tool always works.

Active set: a capability is active once injected and stays active for the session until compaction. `selector.maxActive` bounds the set; the least recently used non-pinned entry is demoted (an `xd://` unmount delta). The active set is derived from persisted `capability-notice` messages on resume, the same way `#ensureAnnouncedMountsSeeded` works, so nothing outside the transcript needs storing.

After compaction the model's memory of the notice is gone but the mount remains. Policy options: (a) re-announce the active set in the first prompt after compaction, (b) unmount everything and let the classifier re-select, (c) leave it, as the mount notice does today (docs stay one `read` away). (a) is the least surprising and is the default; see open questions.

### Pull tool

`capability` (name to be decided; `find` is taken, `skill_search` would be wrong since it covers more than skills). Always pinned, `approval: "read"`, `loadMode: "essential"`.

```
capability({ task: string, kinds?: ("skill"|"mcp"|"agent"|"tool")[], limit?: number })
capability({ names: string[] })   // exact load, no classifier call
```

- `task`: same classifier, no per-kind shortlist quotas beyond a safety cap, full result list with scores and paths. Returns snippets and mounts the tools, exactly like push injection.
- `names`: exact (case and separator tolerant) lookup with typo suggestions on a miss, never a judge call. This is the free path.
- Result carries the decision type (`classified`, `lexical`) so the model knows when ranking was degraded.
- The tool description carries the model-facing sentence that everything else is quiet, so the wording lives next to the tool and appears only when the tool does.

### Interaction with `skillful`

`/skillful` already sends one hidden notice telling the model how to use skills. With the selector on, that notice is replaced by the selector block; `skillful` is treated as satisfied. The profile-apply note from the earlier design (suppress the notice during an automatic change) is not needed, because the selector never toggles `skillful`.

## Backends

|Backend|How reached|Notes|
|---|---|---|
|Hosted Jev|`typesafe` native wire, `TYPESAFE_API_KEY`|Context 64k per request, 32k per question. Question count not limited. Prompt and registry descriptions leave the machine; vendor documents ZDR for enterprise customers only. Rate limits are per organisation and not public|
|jeff (self-hosted)|Same wire, base URL pointed at the jeff server|MIT, one 400M encoder (`gliformer-large-v1`). Supports `noul`, `choice`, `score`; `box` returns 422. Defaults: 64 questions, 64 labels per question, 20,000 state characters. Model name is validated, so the configured model must be `jev-latest`, `jev` or jeff's own name, not a pinned `jev-1.13.0`. About 5 weeks old, single author. Published results: JevBench v1.2.2 66.9 against Jev 75.3; standard tier 76% against 99%; calibration worse (hard-tier ECE 0.19-0.22 against 0.06-0.09). All author-reported|
|OpenRouter or OpenAI Decisions, Workers AI Clef|Existing native wires|Already in omp; no work beyond the role|
|Text bridge on a chat or tiny model|`ai/src/judgment/text.ts`|Works but unmeasured for this task. Likely weaker on Choice calibration; thresholds will not transfer|
|Lexical|Built in|Free, instant, offline; weak on vague prompts|

### Pointing the selector role at jeff

The judge layer reads `TYPESAFE_BASE_URL` once as an environment value. That makes jeff all-or-nothing: setting it would redirect every typesafe-provider judgment (auto-thinking, `find`, unexpected-stop) to jeff, whose published accuracy is lower. A `selector` role that can use a different base URL needs one of:

1. a per-model `baseUrl` on a `typesafe`-provider entry in `models.yml` (the catalog model manager already takes a `baseUrl` in config, `catalog/src/provider-models/special.ts:431-437`; whether a user-defined model entry reaches the native wire's base URL needs confirming in `ai/src/judgment/native.ts:155-181`), or
2. a `selector.baseUrl` setting passed into the `NativeJudge` constructor (which already takes a base URL and model).

Option 1 is preferable because it keeps endpoint configuration in the model catalog next to credentials. If it works as is, no code change is needed here; if not, it is a small, separately-PR-able change to the native judge.

### New role: `selector`

- Registered like `judge`: a kind role in `model-browser.ts`, eligibility predicate in `model-roles.ts` accepting `judge`, `tiny` and `chat` kinds, a default chain that falls back to the `judge` role in `model-resolver.ts`.
- Appears in `/model` without a dedicated row. The user can assign hosted Jev to `judge` and jeff to `selector`, or the reverse.
- If the role is unassigned it resolves to the judge role; if that is also unassigned or not native, the lexical matcher is used. In `auto` mode this resolution never selects a hosted backend the user did not choose.

## Settings and UI

Settings are declared beside their domain (`config/registry.ts`, imported from `config/all-settings.ts`), with `ui: { tab, group, label, description }`. Booleans render as switches, enums as choice lists, strings as text inputs, secrets masked, arrays as multiselect or JSON. A new settings module `selector/settings.ts` follows `hindsight/settings.ts` (URL and credential token) and `advisor/settings.ts` (booleans and enums). The group goes in an existing tab; a new tab would need changes to `tui/src/overlays/settings-defs.ts` (`SettingTab`, `SETTING_TABS`, `TAB_METADATA`, `TAB_LEADS`, `TAB_GROUPS`) and is not needed.

|Setting|Type|Default|Meaning|
|---|---|---|---|
|`selector.enabled`|enum `off`, `shadow`, `on`|`off`|`shadow` classifies and logs decisions without stripping the prompt or injecting. Not `auto`: hosted backends upload prompts, so enabling must be explicit|
|`selector.mode`|enum `push`, `pull`, `both`|`both`|`pull` removes the classifier from the prompt path entirely; only the tool uses it|
|`selector.kinds`|multiselect `skill`, `mcp`, `agent`, `tool`|all|Which kinds are stripped and selectable|
|`selector.pinned`|array|`read, write, edit, bash, grep, glob, task`|Tools always present|
|`selector.maxInject`|number|3|Items injected per prompt|
|`selector.maxActive`|number|12|Active set cap before demotion|
|`selector.minWinner`, `noneThreshold`, `runnerUp`|numbers|0.25, 0.5, 0.6|Decision thresholds, per backend preset|
|`selector.timeoutMs`|number|2000|Classifier budget per prompt|
|`selector.promptChars`|number|1000|Prompt truncation before upload|
|`selector.uploadContext`|boolean|on|Whether `recent_context` is sent|
|`selector.subagents`|enum `off`, `inherit`, `task`|`inherit`|Subagent behaviour|
|`selector.fallback`|enum `lexical`, `none`|`lexical`|Behaviour without a usable backend|

Credentials are not stored here. `TYPESAFE_API_KEY` and any jeff key go through the existing auth registry (jeff reads `Authorization: Bearer` against `JEFF_API_KEYS`, and auth is off when the list is empty). The base URL for jeff is part of the model entry (Option 1 above) or `selector.baseUrl`.

The `/model` hub gets the new `selector` role. The settings screen gets a "Selector" group with a one-line statement of where prompts go for the current backend (for example "Prompts are sent to api.typesafe.ai" or "local"). That line is computed from the resolved role candidate, so a user switching to hosted Jev sees the consequence. A read-only inspector row (Session tab in the dashboard, `/capabilities` in the TUI) lists the registry, the active set, and the last decision with its probabilities.

## What it saves, and what it does not

Inputs are the profiles measurements plus the prompt dump, same configuration, Haiku 4.5, estimator tokens. These sums are [INFERENCE]: the skills and MCP lists were not measured as separate knobs.

|Part|Main session|Subagent|Source|
|---|---|---|---|
|Tool schemas (12 tools to 7)|1.75k|1.2k|measured, `--tools` emulation|
|Task agent list (12 to 3)|1.2k|1.1k|measured|
|Skills list (6.9k chars)|about 2.0k|about 2.0k|converted from characters, [INFERENCE]|
|MCP route catalog (6.6k chars)|about 1.9k|about 1.9k|converted from characters, [INFERENCE]|
|Total reachable|about 6.9k|about 6.2k||
|Baseline|25.6k|14.2k|measured|
|Share of baseline|about 27%|about 44%||

Per prompt, a typical push adds 1-3 snippets of roughly 50-150 tokens each. Net saving on a session that never needs more than the pinned tools is the full figure above. The notice cost is small next to the list it replaces, and a session that touches a dozen capabilities loses the saving gradually.

For comparison, the profile knobs the selector does not cover were the bigger part at this configuration: personality off saved 4.7k tokens, dropping context files 7.9k in a main session (1.7k in a subagent, which only inherits the user-level file). With the profiles design dropped, those savings are no longer on offer in the plan. They depend entirely on the size of the user's own `CLAUDE.md` and `AGENTS.md`. A user with small context files would see only the table above.

A hit-rate loss reduces the saving to a cost: every miss either costs the model a `capability` call (an extra round trip) or leaves it improvising with `bash`.

### Optional: context sections as capabilities

Large context files are mostly irrelevant to any single prompt, the same property that makes the skills list wasteful. A `context` kind could split `AGENTS.md` and `CLAUDE.md` by heading into entries and inject the relevant sections per prompt. That would address the largest single saving at this configuration. It also changes behaviour that the user wrote as always-on instructions (commit rules, language rules, safety rules), and a missed injection would silently ignore an instruction. It needs a pinned subset (per-file or per-heading), a strict "always-on" marker, and a separate decision. It is left out of v1 on purpose and listed as a later phase.

## Risks

- Misses. The model never learns a tool exists. The reference project's own recall is 0.60-0.82. Mitigations: pull tool, shadow mode, lexical fallback, thresholds tuned on real history, a `none` option so abstention is not forced, and an inspector so misses are visible.
- False positives. Notices ahead of every prompt cost the tokens being saved. Mitigation: injection thresholds (the reference found a 0.3 fit threshold suggested a skill on 15 of 16 turns that used none; 0.7 cut that to 3), `maxInject`, shadow mode before enabling.
- Latency. A round trip before the first model token on every real user prompt: about 0.7-0.9 s hosted, roughly 100-150 ms from a local GPU, longer cold (jeff's first request on a scale-to-zero host took 32 s in its own benchmark). Mitigations: timeout and fail-open, cache, skip rules, and `mode: pull`. A local-GPU jeff on the same host is the low-latency path.
- Privacy. Hosted Jev receives the prompt (truncated), the recent assistant text if enabled, and the registry descriptions (skill and MCP descriptions can expose internal project names). Opt-in only, never `auto`, with a visible statement of the destination and a `uploadContext` switch. A local backend or lexical matcher avoids it.
- Prompt injection. The user prompt is untrusted state to the classifier; vendor docs note adversarial content in the state can move answers. Impact is limited because the classifier can only select among the user's own registered capabilities, and only user prompts (not tool outputs) are classified. MCP summaries keep the untrusted-metadata wording.
- Cache stability. The system prompt must not change when the registry changes. All dynamic content goes in notices and mount deltas. MCP route changes that rebuild route guidance through the applied-tool signature (`session/session-tools.ts:1408-1420`) are the one place the prompt can change; with the routes stripped, that signature should not change either. Verify in phase 0 with a byte comparison across an MCP connect.
- Tool presence at turn one. A model that has never seen a tool name may reach for `bash` instead. The static block and the pull tool description are the only defence, and the offline eval measures how often it matters.
- Classifier bias. Jev 1.13 leans toward the first option in a Choice, and swapping rubric wording behind a yes/no has changed 32.5% of answers in third-party testing (reported secondhand by a review, not reproduced). The question text and option order are therefore fixed and versioned, and the eval re-runs when they change.
- Registry hygiene. Near-duplicate skills split probability in a Choice (reported by `jev-agent-hooks`); duplicates with identical descriptions are collapsed before the cut. Skills with `hide: true` and disabled extensions stay out.
- Backend drift. `jev-latest` is an alias that moves (it points to 1.13.0 and `jev-preview` to 1.14.0 at the time of writing). Thresholds are calibrated per resolved model id, recorded in the shadow log.
- Subagents multiply cost. Each classified subagent adds a call. `selector.subagents: inherit` avoids it by default.

## Test plan

Permanent tests only for consumer-visible behaviour; throwaway scripts for the rest.

1. Registry: built from fixture skills, routes and agents; `hidden` and `hide: true` entries excluded; rebuilt on tool-set change; empty after a fresh process (no persistence).
2. System prompt: with `selector.enabled: on` and each `selector.kinds` combination, the stripped sections are absent and the static block is present; the prompt is byte-identical before and after registry changes; `off` renders exactly the current prompt.
3. Classifier decision function (pure): given fixed probability maps, injects the winner only above `minWinner` and below `noneThreshold`, honours `maxInject` and `runnerUp`; ties break deterministically.
4. Gating: slash commands, short prompts and harness turns make no judge call; steering during a run makes no call; a real prompt makes exactly one.
5. Fail-open: judge timeout, 429, 5xx, missing key and a parse error all yield `degraded` or `skipped`, the prompt proceeds unchanged, and lexical fallback runs when configured.
6. Injection: selected tools are mounted and a single `capability-notice` rides with the prompt; no extra assistant turn is forced; on resume the active set is rebuilt from the transcript; the notice is not re-sent when the item is already active.
7. Pull tool: `names` resolves exactly and suggests on typos with no judge call; `task` returns classified or lexical results and mounts tools; a call from a subagent uses the subagent's registry.
8. Role: `selector` appears in the role list, resolves through its chain to the `judge` role, accepts kinds `judge`, `tiny` and `chat`, and a configured base URL reaches the native wire.
9. Settings: each setting round-trips through the registry; the destination line reflects the resolved backend.
10. Shadow mode: decisions are logged, nothing is stripped or injected.

A fake System One server (a small HTTP handler returning canned probabilities) drives the classifier tests. The e2e suite for the dashboard needs no change for v1 beyond the inspector row.

## Offline evaluation

The decision to ship, and the thresholds, come from data on real sessions, not from the reference numbers.

- Source: omp's session files. For each past real user prompt, the label is the set of capabilities the agent actually used in the following turns: `skill://` reads, `xd://` writes, task agent names, tool calls.
- Replay: build the registry as it was configured, run each backend (hosted Jev, jeff, lexical) over the prompts with the same shortlist, record the decision and probabilities.
- Metrics: recall at K (a used capability appears in the injected set), injection rate on prompts where nothing non-pinned was used (noise), tokens added per prompt, tokens removed per session, latency distribution.
- Gate: no default-on and no `auto` until recall and noise are measured on at least one real corpus. The reference projects report recall@K between 0.60 and 0.82 and a fit threshold sweep that moved noise from 15 of 16 turns to 3, so the numbers need local confirmation.
- Output: a per-backend threshold preset and a short results table in the PR.

## Rollout

Phase 0, before any code in the fork:

- Install `jev-skillful` against the user's omp setup in shadow mode and record its decisions for a week of real prompts. This gives a hit-rate baseline with zero omp changes.
- Verify, in a throwaway script, that a mounted `xd://` device absent from the rendered catalog can be called, and that stripping the lists leaves the cached prefix byte-stable across an MCP connect.
- Confirm whether a `typesafe`-provider model entry with its own `baseUrl` reaches the native wire (Option 1 above), and run jeff locally against the existing judge consumers to confirm wire compatibility.
- Build the offline eval harness.

Phase 1, role and pull tool (one fork branch, one upstream PR):

- `selector` role plumbing, settings group, registry, lexical matcher, `capability` tool with `names` and `task`, system prompt stripping behind `selector.enabled`. No push injection yet; `mode: pull` only.
- Docs (`docs/models.md`, settings reference, a new `docs/selector.md`), per-package changelogs (`coding-agent`, `tui`, and `ai` if the native judge changes).

Phase 2, push injection:

- `before_agent_start` classification, `capability-notice`, mounts, active set, `shadow` mode, inspector. Subagent handling.

Phase 3, defaults and tuning:

- Per-backend threshold presets from the offline eval. Decide whether `shadow` becomes the default after install. No `auto`.

Phase 4, optional:

- Context sections as capabilities (see above), a second-stage re-rank on the top candidates with part of the skill body (as `jev-agent-hooks` does), and per-model presets of `selector.*` if the profile idea resurfaces.

Fork rules apply: one feature per branch from `upstream/main` in the fork, Phase 1 and Phase 2 as separate stacked branches so each can be an upstream PR, listed in the integration config, never committed to the integration branch directly.

## Open questions

1. Name. `capability` for the tool and `selector` for the role and settings group are working names. `find` is taken, `skill_search` is too narrow, `selector` may be read as the model selector. Alternatives: `router`, `toolbox`, `lookup`.
2. Does a mounted `xd://` device that is not in the rendered catalog work? If not, the tool side needs the notice to carry the schema-level docs, or the device list must stay in the prompt as names only.
3. Should the selector be allowed to pick a hosted backend in `auto`? The design says no. The `find` tool does follow `auto` to a hosted native judge, so there is precedent for the opposite; privacy of every prompt is a different class from privacy of a search query.
4. After compaction: re-announce, unmount, or leave (see Injection). Preference is re-announce.
5. Should agents be gated at all? Task agents are cheap in the list (1.2k tokens trimmed) but a `task` call with an unknown agent name fails. A middle option keeps names only in the prompt and moves descriptions to the registry.
6. Is a per-role `baseUrl` already reachable (Option 1), or does the native judge need a small change?
7. Does omp want the lexical fallback in core, or only the judge path with a "not available" state? The design includes lexical because a selector with no backend must still work.
8. Thresholds: ship per-backend presets in code, or as a documented table users copy?
9. Should the shadow log live in the session journal (visible in the dashboard, subject to retention) or a separate file?
10. Should the `selector` role also be offered to extensions through `model-role-api`?
11. Does `before_agent_start` allow the stripped system prompt to be built once and the notice to be the only per-turn change, or does an extension replacement of the prompt interact badly with the cache? The hook can replace the prompt for a turn; the design does not use that and relies on the notice.
12. Is it acceptable that jeff's published accuracy is lower than hosted Jev's for this task, given it runs locally? That depends on the offline eval.
13. Context sections (Phase 4): is there an upstream appetite for it, given that it changes the meaning of always-on instruction files?
