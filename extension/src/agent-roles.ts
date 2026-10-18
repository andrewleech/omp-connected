// Read-only view of how OMP agent definitions pick their models, for the
// dashboard's Roles tab. Selection and role expansion are delegated to OMP's
// own resolver so the answer matches what a spawned subagent would get.
//
// The modules are imported through named wildcard exports (`./task/*`,
// `./config/*`), which a compiled omp binary bundles; the root catch-all
// export is not available there (see collab-registry.ts).

export interface AgentModelRef {
	provider: string;
	id: string;
	name: string;
}

/** Where an agent's effective model selector comes from. */
export type AgentModelOrigin = "override" | "frontmatter" | "session";

export interface AgentRoleInfo {
	name: string;
	description: string;
	/** Where the definition was found, e.g. "bundled", "user", "project". */
	source: string;
	filePath: string | null;
	disabled: boolean;
	/** The agent file's own `model` candidates, as written. */
	frontmatterModel: string[];
	/** `task.agentModelOverrides` entry, as written. */
	overrideModel: string | null;
	origin: AgentModelOrigin;
	/** Role alias the effective selector expanded from (`@smol` gives `smol`). */
	role: string | null;
	/** Effective selector candidates after role expansion, in order. */
	patterns: string[];
	resolvedModel: AgentModelRef | null;
	/** Thinking level an explicit selector suffix or the agent definition asks for. */
	thinking: string | null;
}

export interface AgentRolesInfo {
	agents: AgentRoleInfo[];
}

interface OmpAgent {
	name: string;
	description: string;
	source: string;
	filePath?: string;
	model?: string[];
	thinkingLevel?: string;
}

interface OmpModel {
	provider: string;
	id: string;
	name: string;
}

/** The slice of OMP internals this view reads, injected for tests. */
export interface AgentRolesDeps {
	cwd: string;
	activeModelPattern?: string;
	discoverAgents(cwd: string): Promise<OmpAgent[]>;
	disabledAgents(): string[];
	modelOverrides(): Record<string, string | string[]>;
	resolveSelection(options: {
		settingsOverride?: string;
		agentModel?: string[];
		activeModelPattern?: string;
	}): { patterns: string[]; role: string | undefined };
	/** Patterns the given agent/override value expands to on its own. */
	expand(value: string | string[] | undefined): string[];
	resolveModel(patterns: string[]): { model?: OmpModel; thinkingLevel?: string; explicitThinkingLevel: boolean };
}

function joinOverride(value: string | string[] | undefined): string | null {
	const text = (Array.isArray(value) ? value.join(",") : (value ?? "")).trim();
	return text.length > 0 ? text : null;
}

export async function buildAgentRoles(deps: AgentRolesDeps): Promise<AgentRolesInfo> {
	const agents = await deps.discoverAgents(deps.cwd);
	const disabled = new Set(deps.disabledAgents());
	const overrides = deps.modelOverrides();
	return {
		agents: agents.map((agent) => {
			const overrideModel = joinOverride(overrides[agent.name]);
			const selection = deps.resolveSelection({
				settingsOverride: overrideModel ?? undefined,
				agentModel: agent.model,
				activeModelPattern: deps.activeModelPattern,
			});
			const own = deps.expand(agent.model);
			const origin: AgentModelOrigin =
				overrideModel && deps.expand(overrideModel).length > 0
					? "override"
					: own.length > 0 && JSON.stringify(own) === JSON.stringify(selection.patterns)
						? "frontmatter"
						: "session";
			const resolved = deps.resolveModel(selection.patterns);
			const model = resolved.model;
			return {
				name: agent.name,
				description: agent.description,
				source: agent.source,
				filePath: agent.filePath ?? null,
				disabled: disabled.has(agent.name),
				frontmatterModel: agent.model ?? [],
				overrideModel,
				origin,
				role: selection.role ?? null,
				patterns: selection.patterns,
				resolvedModel: model ? { provider: model.provider, id: model.id, name: model.name } : null,
				thinking:
					(resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined) ?? agent.thinkingLevel ?? null,
			};
		}),
	};
}

/** Minimal shape of `ctx` this view needs. */
export interface AgentRolesContext {
	cwd: string;
	model?: { provider: string; id: string };
	modelRegistry: unknown;
}

/** Loads OMP's resolver modules and answers for one session context. */
export async function loadAgentRoles(ctx: AgentRolesContext): Promise<AgentRolesInfo> {
	const [discovery, settingsModule, taskSettings, resolver] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/task/discovery") as Promise<{
			discoverAgents(cwd: string): Promise<{ agents: OmpAgent[] }>;
		}>,
		import("@oh-my-pi/pi-coding-agent/config/settings") as Promise<{ Settings: { instance: unknown } }>,
		import("@oh-my-pi/pi-coding-agent/task/settings") as Promise<{
			cfgTaskDisabledAgents: { get(settings: unknown): string[] };
			cfgTaskAgentModelOverrides: { get(settings: unknown): Record<string, string | string[]> };
		}>,
		import("@oh-my-pi/pi-coding-agent/config/model-resolver") as Promise<{
			resolveAgentModelSelection(options: {
				settingsOverride?: string;
				agentModel?: string[];
				activeModelPattern?: string;
				settings: unknown;
			}): { patterns: string[]; role: string | undefined };
			resolveConfiguredModelPatterns(value: string | string[] | undefined, settings: unknown): string[];
			resolveModelOverride(
				patterns: string[],
				registry: unknown,
				settings: unknown,
			): { model?: OmpModel; thinkingLevel?: string; explicitThinkingLevel: boolean };
		}>,
	]);
	const settings = settingsModule.Settings.instance;
	return buildAgentRoles({
		cwd: ctx.cwd,
		activeModelPattern: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		discoverAgents: async (cwd) => (await discovery.discoverAgents(cwd)).agents,
		disabledAgents: () => taskSettings.cfgTaskDisabledAgents.get(settings),
		modelOverrides: () => taskSettings.cfgTaskAgentModelOverrides.get(settings),
		resolveSelection: (options) => resolver.resolveAgentModelSelection({ ...options, settings }),
		expand: (value) => resolver.resolveConfiguredModelPatterns(value, settings),
		resolveModel: (patterns) => resolver.resolveModelOverride(patterns, ctx.modelRegistry, settings),
	});
}
