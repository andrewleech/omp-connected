// The OMP fleet dashboard shell. Ported from claude-net's predecessor
// (src/hub/omp-dashboard.js) with two structural changes:
//
// 1. Routes point at this server's own surface (`/api/hosts/...` for the
//    collab broker, `/api/roster/...` — a proxy to claude-net — for the
//    agent-message pane) instead of claude-net's `/api/...`.
// 2. The dashboard socket only ever receives `host.connected` /
//    `host.disconnected` (see dashboard-events.ts) — never a generic
//    heartbeat — so there is no broadcast-storm to defend against here.
//    Session state (what's running on a host) is polled on a fixed
//    interval instead of being pushed, since this server only ever learns
//    it by RPC-polling a host itself.

import { collabFrameUrl } from "./lib/collab-link";
import {
  type CollabSession,
  INSPECTOR_PANES,
  type InspectorPane,
  canRequestAccess,
  groupSessions,
  readWorkspace,
  resolveRememberedSession,
  sessionKey,
  workspaceSignature,
  writeWorkspace,
} from "./lib/workspace";

const SESSION_POLL_MS = 15_000;

interface AgentSummary {
  fullName: string;
  status: "online" | "offline";
}
interface TeamSummary {
  name: string;
}
interface HostSummary {
  hostId: string;
}

function el(
  name: string,
  options: {
    className?: string;
    text?: string;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    title?: string;
  } = {},
): HTMLElement {
  const node = document.createElement(name);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) (node as HTMLButtonElement).type = options.type;
  if (options.disabled !== undefined)
    (node as HTMLButtonElement).disabled = options.disabled;
  if (options.title) node.title = options.title;
  return node;
}

function displayName(session: CollabSession): string {
  return session.sessionName || session.sessionId || session.instanceId;
}

function createDashboard(root: HTMLElement): void {
  const state = {
    ...readWorkspace(localStorage),
    agents: [] as AgentSummary[],
    teams: [] as TeamSummary[],
    hosts: [] as HostSummary[],
    sessions: [] as CollabSession[],
    selectedSession: null as CollabSession | null,
    selectedAccess: null as "view" | "control" | null,
  };
  let lastWorkspaceSignature: string | null | undefined;

  function persist(): void {
    writeWorkspace(localStorage, {
      version: 1,
      groups: state.groups,
      selected: state.selected,
      inspector: state.inspector,
    });
  }

  function showStatus(message: string, kind = ""): void {
    const status = root.querySelector("[data-status]");
    if (!status) return;
    status.textContent = message;
    status.className = `status ${kind}`;
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `Request failed (${response.status})`,
      );
    return body as T;
  }

  async function loadSessions(): Promise<void> {
    const entries = await Promise.all(
      state.hosts.map(async (host) => {
        try {
          const result = await json<{ sessions: CollabSession[] }>(
            `/api/hosts/${encodeURIComponent(host.hostId)}/collab`,
          );
          return result.sessions.map((session) => ({
            ...session,
            host_id: host.hostId,
          }));
        } catch (error) {
          showStatus(`${host.hostId}: ${(error as Error).message}`, "warning");
          return [];
        }
      }),
    );
    state.sessions = entries.flat();
    state.selectedSession = resolveRememberedSession(
      state.sessions,
      state.selected,
    );
    if (!state.selectedSession && state.sessions.length > 0)
      selectSession(state.sessions[0] as CollabSession);
  }

  async function refresh(): Promise<void> {
    showStatus("Refreshing fleet…");
    state.hosts = await json<HostSummary[]>("/api/hosts");
    try {
      state.agents = await json<AgentSummary[]>("/api/roster/agents");
      state.teams = await json<TeamSummary[]>("/api/roster/teams");
    } catch {
      // Roster proxy is optional (CLAUDE_NET_HUB may be unconfigured on
      // this instance) — the collab dashboard still works without it.
    }
    await loadSessions();
    render();
    showStatus(
      `${state.sessions.length} Collab session${state.sessions.length === 1 ? "" : "s"} available`,
      "ok",
    );
  }

  async function pollSessions(): Promise<void> {
    await loadSessions();
    render();
  }

  function selectSession(session: CollabSession): void {
    const frame = root.querySelector<HTMLIFrameElement>("[data-collab-frame]");
    if (frame) frame.src = "about:blank";
    state.selected = sessionKey(session);
    state.selectedSession = session;
    state.selectedAccess = null;
    persist();
    render();
  }

  function setGroup(session: CollabSession, groupId: string | null): void {
    const key = sessionKey(session);
    for (const group of state.groups)
      group.sessions = group.sessions.filter((entry) => entry !== key);
    if (groupId)
      state.groups.find((group) => group.id === groupId)?.sessions.push(key);
    persist();
    render();
  }

  async function openCollab(access: "view" | "control"): Promise<void> {
    const session = state.selectedSession;
    if (!session || !canRequestAccess(session, access)) return;
    showStatus(`Requesting ${access} access…`);
    try {
      const result = await json<{ access: string; url: string }>(
        `/api/hosts/${encodeURIComponent(session.host_id)}/collab/${encodeURIComponent(session.instanceId)}/link`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation: session.generation, access }),
        },
      );
      if (result.access !== access || typeof result.url !== "string")
        throw new Error("Broker returned an unexpected Collab capability");
      const collabUrl = collabFrameUrl(result.url, location.origin);
      const frame = root.querySelector<HTMLIFrameElement>(
        "[data-collab-frame]",
      );
      if (frame) frame.src = collabUrl;
      state.selectedAccess = access;
      render();
      showStatus(
        `${access === "control" ? "Control" : "View"} room opened`,
        "ok",
      );
    } catch (error) {
      const message = (error as Error).message;
      showStatus(
        /generation|stale|not found/i.test(message)
          ? "Session changed on its host. Refresh sessions and retry."
          : message,
        "warning",
      );
    }
  }

  async function sendAgentMessage(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form);
    const target = String(data.get("target") ?? "");
    const content = String(data.get("content") ?? "");
    if (!target || !content) return;
    const [kind, name] = target.split(/:(.+)/);
    try {
      if (kind === "team")
        await json("/api/roster/send_team", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ team: name, content }),
        });
      else
        await json("/api/roster/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: name, content }),
        });
      form.reset();
      showStatus("Agent message sent", "ok");
    } catch (error) {
      showStatus((error as Error).message, "warning");
    }
  }

  function renderRail(container: Element): void {
    container.replaceChildren();
    const addGroup = el("button", {
      className: "quiet",
      text: "+ New project group",
      type: "button",
    });
    (addGroup as HTMLButtonElement).onclick = () => {
      const name = prompt("Group name?");
      if (!name) return;
      state.groups.push({ id: crypto.randomUUID(), name, sessions: [] });
      persist();
      render();
    };
    container.append(addGroup);
    for (const group of groupSessions(state.sessions, state.groups)) {
      const section = el("div", { className: "session-group" });
      section.append(el("h2", { text: group.name }));
      if (group.sessions.length === 0)
        section.append(el("p", { className: "empty", text: "No sessions" }));
      for (const session of group.sessions) {
        const card = el("div", {
          className: `session-card${sessionKey(session) === state.selected ? " selected" : ""}`,
        });
        const open = el("button", { type: "button" });
        open.append(el("span", { text: displayName(session) }));
        open.append(el("span", { text: session.host_id }));
        open.append(
          el("span", {
            className: `badge ${session.access}`,
            text: session.access,
          }),
        );
        (open as HTMLButtonElement).onclick = () => selectSession(session);
        const moveTo = el("select") as HTMLSelectElement;
        moveTo.append(new Option("Ungrouped", ""));
        for (const g of state.groups)
          moveTo.append(
            new Option(g.name, g.id, false, g.id === group.id && group.custom),
          );
        moveTo.onchange = () => setGroup(session, moveTo.value || null);
        card.append(open, moveTo);
        section.append(card);
      }
      container.append(section);
    }
  }

  function renderWorkspace(container: Element): void {
    const session = state.selectedSession;
    const signature = workspaceSignature(session, state.selectedAccess);
    if (signature === lastWorkspaceSignature) return;
    lastWorkspaceSignature = signature;
    const frame = container.querySelector("[data-collab-frame]");
    container.replaceChildren();
    if (!session) {
      container.append(
        el("div", {
          className: "empty workspace-empty",
          text: "No live OMP Collab rooms found. Start one on a registered host, then refresh.",
        }),
      );
      return;
    }
    const header = el("header", { className: "workspace-header" });
    header.append(
      el("div", { text: `${displayName(session)} · ${session.host_id}` }),
    );
    const actions = el("div", { className: "actions" });
    const view = el("button", { text: "Open view", type: "button" });
    (view as HTMLButtonElement).onclick = () => void openCollab("view");
    actions.append(view);
    const control = el("button", {
      text: "Open control",
      type: "button",
      disabled: !canRequestAccess(session, "control"),
    });
    control.title = (control as HTMLButtonElement).disabled
      ? "This room exposes view-only access."
      : "Opens the real OMP Collab control room.";
    (control as HTMLButtonElement).onclick = () => void openCollab("control");
    actions.append(control);
    header.append(actions);
    const hint = el("p", {
      className: "channel-hint",
      text:
        state.selectedAccess === "control"
          ? "Prompt session in the Collab composer below. Agent messages remain a separate roster-routed channel."
          : "Open control to prompt this session. Agent messages are sent through the roster, never as session prompts.",
    });
    container.append(
      header,
      hint,
      frame ?? el("iframe", { className: "collab-frame" }),
    );
    const collabFrame = (container.querySelector("[data-collab-frame]") ??
      container.lastElementChild) as HTMLIFrameElement;
    collabFrame.dataset.collabFrame = "";
    collabFrame.title = "OMP Collab session";
    collabFrame.referrerPolicy = "no-referrer";
  }

  function renderInspector(container: Element): void {
    container.replaceChildren();
    const tabs = el("div", { className: "tabs" });
    for (const pane of INSPECTOR_PANES) {
      const tab = el("button", {
        text:
          pane === "files"
            ? "Files & tools"
            : pane.charAt(0).toUpperCase() + pane.slice(1),
        type: "button",
        className: pane === state.inspector ? "active" : "",
      });
      (tab as HTMLButtonElement).onclick = () => {
        state.inspector = pane as InspectorPane;
        persist();
        render();
      };
      tabs.append(tab);
    }
    container.append(tabs);
    const body = el("div", { className: "inspector-body" });
    if (state.inspector === "messages") {
      body.append(el("h2", { text: "Message agent" }));
      body.append(
        el("p", {
          text: "Routed through claude-net's roster. This is not a session prompt and arrives with structural agent provenance.",
        }),
      );
      const form = el("form") as HTMLFormElement;
      const target = el("select") as HTMLSelectElement;
      target.name = "target";
      target.append(new Option("Select agent or team", ""));
      for (const agent of state.agents.filter(
        (agent) => agent.status === "online",
      ))
        target.append(new Option(agent.fullName, `agent:${agent.fullName}`));
      for (const team of state.teams)
        target.append(new Option(`Team: ${team.name}`, `team:${team.name}`));
      const content = el("textarea") as HTMLTextAreaElement;
      content.name = "content";
      content.placeholder = "Message content";
      const send = el("button", { text: "Send agent message", type: "submit" });
      form.append(target, content, send);
      form.onsubmit = (event) => {
        event.preventDefault();
        void sendAgentMessage(form);
      };
      body.append(form);
    } else if (state.inspector === "controls") {
      body.append(el("h2", { text: "Controls" }));
      body.append(
        el("p", {
          text: "Prompt and abort are provided by an opened control room. Other OMP controls remain available in the host TUI until their Collab control-frame transport is verified.",
        }),
      );
    } else if (state.inspector === "participants") {
      body.append(el("h2", { text: "Participants" }));
      body.append(
        el("p", {
          text: state.selectedSession
            ? `${state.selectedSession.participants ?? 0} connected to the selected room.`
            : "Select a room.",
        }),
      );
    } else {
      body.append(el("h2", { text: "Files & tools" }));
      body.append(
        el("p", {
          text: "Unavailable until the Collab protocol exposes a verified inspection transport.",
        }),
      );
    }
    container.append(body);
  }

  function render(): void {
    const rail = root.querySelector("[data-session-rail]");
    const workspace = root.querySelector("[data-workspace]");
    const inspector = root.querySelector("[data-inspector]");
    if (rail) renderRail(rail);
    if (workspace) renderWorkspace(workspace);
    if (inspector) renderInspector(inspector);
  }

  root.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).matches("[data-refresh]"))
      void refresh().catch((error) => showStatus(error.message, "warning"));
  });

  const socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/dashboard`,
  );
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(String(event.data)) as { event?: string };
      if (data.event === "host.connected" || data.event === "host.disconnected")
        void refresh().catch(() => {});
    } catch {
      // ignore malformed frames
    }
  };
  socket.onclose = () =>
    showStatus(
      "Hub event stream disconnected; use Refresh to retry.",
      "warning",
    );
  setInterval(() => void pollSessions().catch(() => {}), SESSION_POLL_MS);
  void refresh().catch((error) => showStatus(error.message, "warning"));
}

const root = document.querySelector<HTMLElement>("[data-omp-dashboard]");
if (root) createDashboard(root);