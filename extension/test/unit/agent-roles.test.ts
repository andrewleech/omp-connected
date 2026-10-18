import { describe, expect, test } from "bun:test";
import { type AgentRolesDeps, buildAgentRoles } from "../../src/agent-roles.js";

const smol = { provider: "anthropic", id: "haiku", name: "Haiku" };
const sonnet = { provider: "anthropic", id: "sonnet", name: "Sonnet" };

/** A tiny stand-in for OMP's resolver: `@role[:level]` expands through `roles`. */
function deps(overrides: Partial<AgentRolesDeps> & { agents: Awaited<ReturnType<AgentRolesDeps["discoverAgents"]>> }) {
  const roles: Record<string, string> = { smol: "anthropic/haiku", task: "anthropic/sonnet" };
  const expand = (value: string | string[] | undefined): string[] => {
    const list = (Array.isArray(value) ? value : (value ?? "").split(","))
      .map((v) => v.trim())
      .filter(Boolean);
    return list.map((v) => (v.startsWith("@") ? `${roles[v.slice(1).split(":")[0]] ?? v}${v.includes(":") ? `:${v.split(":")[1]}` : ""}` : v));
  };
  const base: AgentRolesDeps = {
    cwd: "/work",
    activeModelPattern: "anthropic/sonnet",
    discoverAgents: async () => overrides.agents,
    disabledAgents: () => [],
    modelOverrides: () => ({}),
    expand,
    resolveSelection: ({ settingsOverride, agentModel, activeModelPattern }) => {
      const source = expand(settingsOverride).length > 0 ? settingsOverride : agentModel?.join(",");
      const patterns = expand(source);
      const role = source?.startsWith("@") ? source.slice(1).split(":")[0] : undefined;
      return patterns.length > 0 ? { patterns, role } : { patterns: expand(activeModelPattern), role: undefined };
    },
    resolveModel: (patterns) => {
      const [head = "", level] = patterns[0]?.split(":") ?? [];
      const model = [smol, sonnet].find((m) => `${m.provider}/${m.id}` === head);
      return { model, thinkingLevel: level, explicitThinkingLevel: level !== undefined };
    },
  };
  return { ...base, ...overrides };
}

const agent = (name: string, model?: string[], thinkingLevel?: string) => ({
  name,
  description: `${name} agent`,
  source: "bundled",
  model,
  thinkingLevel,
});

describe("buildAgentRoles", () => {
  test("maps a role alias in frontmatter to the role and its resolved model", async () => {
    const { agents } = await buildAgentRoles(deps({ agents: [agent("sonic", ["@smol"], "medium")] }));
    expect(agents[0]).toMatchObject({
      origin: "frontmatter",
      role: "smol",
      patterns: ["anthropic/haiku"],
      resolvedModel: smol,
      thinking: "medium",
    });
  });

  test("a literal model has no role", async () => {
    const { agents } = await buildAgentRoles(deps({ agents: [agent("pinned", ["anthropic/sonnet"])] }));
    expect(agents[0]).toMatchObject({ origin: "frontmatter", role: null, resolvedModel: sonnet });
  });

  test("an agent with no model inherits the session model", async () => {
    const { agents } = await buildAgentRoles(deps({ agents: [agent("plain")] }));
    expect(agents[0]).toMatchObject({ origin: "session", role: null, frontmatterModel: [], resolvedModel: sonnet });
  });

  test("a settings override wins over frontmatter and is reported verbatim", async () => {
    const { agents } = await buildAgentRoles(
      deps({ agents: [agent("sonic", ["@smol"])], modelOverrides: () => ({ sonic: ["@task", "anthropic/haiku"] }) }),
    );
    expect(agents[0]).toMatchObject({ origin: "override", overrideModel: "@task,anthropic/haiku", resolvedModel: sonnet });
  });

  test("an explicit thinking suffix beats the agent's thinkingLevel", async () => {
    const { agents } = await buildAgentRoles(deps({ agents: [agent("a", ["@smol:high"], "low")] }));
    expect(agents[0]?.thinking).toBe("high");
  });

  test("marks disabled agents and reports an unresolved model as null", async () => {
    const { agents } = await buildAgentRoles(
      deps({ agents: [agent("gone", ["nobody/none"])], disabledAgents: () => ["gone"] }),
    );
    expect(agents[0]).toMatchObject({ disabled: true, resolvedModel: null });
  });
});
