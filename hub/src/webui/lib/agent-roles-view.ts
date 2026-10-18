import { el } from "./dom";
import type { AgentRoleInfo } from "./session-api";

/** Agents whose effective model comes from each role, keyed by role id. */
export function agentsByRole(
  agents: AgentRoleInfo[],
): Map<string, AgentRoleInfo[]> {
  const map = new Map<string, AgentRoleInfo[]>();
  for (const agent of agents) {
    if (!agent.role) continue;
    const list = map.get(agent.role) ?? [];
    list.push(agent);
    map.set(agent.role, list);
  }
  return map;
}

const ORIGIN_LABEL: Record<AgentRoleInfo["origin"], string> = {
  override: "settings override",
  frontmatter: "agent file",
  session: "session model",
};

export function originLabel(origin: AgentRoleInfo["origin"]): string {
  return ORIGIN_LABEL[origin];
}

export interface AgentRowHandlers {
  /** Called when the role chip in an agent row is clicked. */
  onRole(roleId: string): void;
}

function step(className: string, text: string, title?: string): HTMLElement {
  const node = el("span", { className: `map-step ${className}`, text });
  if (title) node.title = title;
  return node;
}

/**
 * One agent as a left-to-right chain: where the model is chosen, the role it
 * expands through (if any), and the model and thinking level it ends up with.
 */
export function renderAgentRow(
  agent: AgentRoleInfo,
  handlers: AgentRowHandlers,
  highlighted: boolean,
): HTMLElement {
  const row = el("div", {
    className: `agent-row${highlighted ? " selected" : ""}${agent.disabled ? " disabled" : ""}`,
  });
  row.dataset.agentName = agent.name;

  const head = el("div", { className: "agent-head" });
  head.append(el("strong", { className: "agent-name", text: agent.name }));
  head.append(el("span", { className: "agent-source", text: agent.source }));
  if (agent.disabled)
    head.append(el("span", { className: "agent-flag", text: "disabled" }));
  row.append(head);
  if (agent.description) {
    const description = el("p", {
      className: "agent-description",
      text: agent.description,
    });
    description.title = agent.filePath ?? "";
    row.append(description);
  }

  const chain = el("div", { className: "agent-chain" });
  const selector =
    agent.origin === "override"
      ? (agent.overrideModel ?? "")
      : agent.origin === "frontmatter"
        ? agent.frontmatterModel.join(", ")
        : "";
  chain.append(
    step(
      `origin-${agent.origin}`,
      selector
        ? `${originLabel(agent.origin)}: ${selector}`
        : originLabel(agent.origin),
      agent.origin === "session"
        ? "No model of its own; uses the model of the session that spawns it"
        : undefined,
    ),
  );
  if (agent.role) {
    const chip = el("button", {
      type: "button",
      className: "map-step role-chip",
      text: `role ${agent.role}`,
    }) as HTMLButtonElement;
    chip.title = "Show this role";
    const roleId = agent.role;
    chip.addEventListener("click", () => handlers.onRole(roleId));
    chain.append(chip);
  } else if (agent.origin !== "session") {
    chain.append(step("pinned", "pinned model", "Named model, not a role"));
  }
  if (agent.patterns.length > 0)
    chain.append(
      step("patterns", agent.patterns.join(", "), "Candidates tried in order"),
    );
  chain.append(
    step(
      agent.resolvedModel ? "resolved" : "unresolved",
      agent.resolvedModel
        ? `${agent.resolvedModel.name} (${agent.resolvedModel.provider}/${agent.resolvedModel.id})`
        : "No model resolved",
    ),
  );
  if (agent.thinking)
    chain.append(step("thinking", `thinking ${agent.thinking}`));
  row.append(chain);
  return row;
}
