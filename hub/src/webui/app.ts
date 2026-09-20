// The OMP fleet dashboard shell.
//
// The dashboard socket only ever receives `agent.registered` /
// `agent.disconnected` (see dashboard-events.ts) — never a generic
// heartbeat — so there is no broadcast-storm to defend against here.
// Collab session state (what's running on a host) is polled on a fixed
// interval instead of being pushed, since this server only ever learns
// it by RPC-polling a host itself.

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
  sessionLabel,
  workspaceSignature,
  writeWorkspace,
} from "./lib/workspace";

const SESSION_POLL_MS = 15_000;

interface HostSummary {
  hostId: string;
}

// Minimal local mirror of omp-hub's server-side AgentSummary wire type —
// matches the existing convention of HostSummary above rather than
// importing across the webui/server module boundary.
interface AgentSummary {
  id: string;
  hostId: string;
  instanceId: string;
  label: string;
  cwd: string;
  pid: number;
  connectedAt: string;
  teams: string[];
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

interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

let activeContextMenu: HTMLElement | null = null;

function closeContextMenu(): void {
  activeContextMenu?.remove();
  activeContextMenu = null;
}

function openContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeContextMenu();
  const menu = el("ul", { className: "ctx-menu" });
  for (const item of items) {
    const li = el("li");
    const button = el("button", {
      type: "button",
      text: item.label,
      disabled: item.disabled,
    }) as HTMLButtonElement;
    button.onclick = () => {
      closeContextMenu();
      item.onSelect();
    };
    li.append(button);
    menu.append(li);
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  activeContextMenu = menu;
}

// Outside-dismissal uses `pointerdown` (capture phase) rather than `click`:
// the `contextmenu` event that opens a menu never itself produces a `click`,
// but the touch gesture ending a long-press does, which would otherwise
// close a just-opened menu before the user can tap an item.
document.addEventListener(
  "pointerdown",
  (event) => {
    if (activeContextMenu?.contains(event.target as Node)) return;
    closeContextMenu();
  },
  true,
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeContextMenu();
});
window.addEventListener("resize", closeContextMenu);
window.addEventListener("scroll", closeContextMenu, true);

/**
 * Fallback long-press trigger for touch devices whose browser does not
 * dispatch a native `contextmenu` event on press-and-hold (older iOS
 * Safari). Cancels on release or once the finger moves past a small
 * threshold, so it never fires mid-scroll.
 */
function attachLongPress(
  target: HTMLElement,
  onTrigger: (x: number, y: number) => void,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    start = null;
  };
  target.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    start = { x: event.clientX, y: event.clientY };
    const { clientX, clientY } = event;
    timer = setTimeout(() => {
      onTrigger(clientX, clientY);
      cancel();
    }, 550);
  });
  target.addEventListener("pointermove", (event) => {
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10)
      cancel();
  });
  target.addEventListener("pointerup", cancel);
  target.addEventListener("pointercancel", cancel);
}

function createDashboard(root: HTMLElement): void {
  const state = {
    ...readWorkspace(localStorage),
    hosts: [] as HostSummary[],
    sessions: [] as CollabSession[],
    selectedSession: null as CollabSession | null,
    selectedAccess: null as "view" | "control" | null,
    agents: [] as AgentSummary[],
    agentsLoaded: false,
    agentsError: null as string | null,
    composeTargetId: null as string | null,
  };
  let lastWorkspaceSignature: string | null | undefined;
  let agentsFetchInFlight = false;

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
    const resolved =
      resolveRememberedSession(state.sessions, state.selected) ??
      (state.sessions[0] as CollabSession | undefined) ??
      null;
    if (!resolved) {
      state.selectedSession = null;
      return;
    }
    if (
      state.selectedSession &&
      sessionKey(state.selectedSession) === sessionKey(resolved)
    ) {
      // Same room as before this refresh — only update its polled fields
      // (participants, etc.); selectSession() would blank and reload the
      // live iframe for no reason.
      state.selectedSession = resolved;
      return;
    }
    selectSession(resolved);
  }

  async function refresh(): Promise<void> {
    showStatus("Refreshing fleet…");
    state.hosts = await json<HostSummary[]>("/api/hosts");
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
    void openCollab("view");
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

  function sessionMenuItems(session: CollabSession): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      {
        label: "Copy session name",
        onSelect: () => {
          void navigator.clipboard.writeText(sessionLabel(session)).then(
            () => showStatus("Session name copied", "ok"),
            () => showStatus("Copy failed — clipboard unavailable", "warning"),
          );
        },
      },
    ];
    const current = state.groups.find((group) =>
      group.sessions.includes(sessionKey(session)),
    );
    if (current)
      items.push({
        label: `Remove from "${current.name}"`,
        onSelect: () => setGroup(session, null),
      });
    for (const group of state.groups) {
      if (group.id === current?.id) continue;
      items.push({
        label: `Move to "${group.name}"`,
        onSelect: () => setGroup(session, group.id),
      });
    }
    items.push({
      label: "New group…",
      onSelect: () => {
        const name = prompt("Group name?");
        if (!name) return;
        const group = { id: crypto.randomUUID(), name, sessions: [] };
        state.groups.push(group);
        setGroup(session, group.id);
      },
    });
    return items;
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
        const card = el("button", {
          className: `session-card${sessionKey(session) === state.selected ? " selected" : ""}`,
          type: "button",
          title: displayName(session),
        }) as HTMLButtonElement;
        card.append(
          el("span", {
            className: "session-label",
            text: sessionLabel(session),
          }),
        );
        card.append(
          el("span", {
            className: `badge ${session.access}`,
            text: session.access,
          }),
        );
        card.onclick = () => selectSession(session);
        card.oncontextmenu = (event) => {
          event.preventDefault();
          openContextMenu(
            event.clientX,
            event.clientY,
            sessionMenuItems(session),
          );
        };
        attachLongPress(card, (x, y) =>
          openContextMenu(x, y, sessionMenuItems(session)),
        );
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
    const title = el("div", { className: "workspace-title" });
    title.append(
      el("span", {
        className: "workspace-title-text",
        text: `${displayName(session)} · ${session.host_id}`,
      }),
    );
    title.append(
      el("span", {
        className: `badge ${state.selectedAccess ?? "connecting"}`,
        text:
          state.selectedAccess === "control"
            ? "control"
            : state.selectedAccess === "view"
              ? "view"
              : "connecting…",
      }),
    );
    header.append(title);
    const hint = el("p", {
      className: "channel-hint",
      text:
        state.selectedAccess === "control"
          ? "Prompt this session in the Collab composer below."
          : canRequestAccess(session, "control")
            ? "Viewing read-only. Send a message in the composer below to switch this room to control."
            : "This room is view-only on its host; session prompting isn't available here.",
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

  async function loadAgents(): Promise<void> {
    try {
      const result = await json<{ agents: AgentSummary[] }>("/api/agents");
      state.agents = result.agents;
      state.agentsError = null;
    } catch (error) {
      state.agentsError = (error as Error).message;
    } finally {
      state.agentsLoaded = true;
    }
  }

  async function sendAgentMessage(
    agentId: string,
    content: string,
    onSent: () => void,
  ): Promise<void> {
    showStatus(`Sending message to ${agentId}…`);
    try {
      await json(`/api/agents/${encodeURIComponent(agentId)}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, idempotencyKey: crypto.randomUUID() }),
      });
      showStatus("Message sent", "ok");
      onSent();
    } catch (error) {
      showStatus((error as Error).message, "warning");
    }
  }

  function renderComposeForm(target: AgentSummary): HTMLElement {
    const form = el("form", { className: "agent-compose" });
    form.append(el("h3", { text: `Message ${target.label}` }));
    const textarea = document.createElement("textarea");
    textarea.className = "agent-compose-input";
    textarea.placeholder = "Message content…";
    form.append(textarea);
    form.append(el("button", { type: "submit", text: "Send" }));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const content = textarea.value.trim();
      if (!content) return;
      void sendAgentMessage(target.id, content, () => {
        textarea.value = "";
      });
    });
    return form;
  }

  // Roster + compose UI backed natively by omp-hub's own AgentRegistry via
  // GET/POST /api/agents. Display label collisions (two agents sharing the
  // same basename(cwd)) are disambiguated by showing each candidate's
  // hostId, matching the resolve() ambiguity data the server itself
  // returns.
  function renderAgentsBody(body: HTMLElement): void {
    body.append(el("h2", { text: "Agents" }));
    if (!state.agentsLoaded && !agentsFetchInFlight) {
      agentsFetchInFlight = true;
      void loadAgents().then(() => {
        agentsFetchInFlight = false;
        render();
      });
    }
    if (state.agentsError) {
      body.append(el("p", { className: "empty", text: state.agentsError }));
      return;
    }
    if (!state.agentsLoaded) {
      body.append(el("p", { className: "empty", text: "Loading agents…" }));
      return;
    }
    if (state.agents.length === 0) {
      body.append(
        el("p", {
          className: "empty",
          text: "No agents registered. Set OMP_HUB_URL/OMP_HUB_HOST_TOKEN in an interactive OMP session to register one.",
        }),
      );
      return;
    }
    if (
      state.composeTargetId &&
      !state.agents.some((agent) => agent.id === state.composeTargetId)
    ) {
      state.composeTargetId = null;
    }

    const labelCounts = new Map<string, number>();
    for (const agent of state.agents) {
      labelCounts.set(agent.label, (labelCounts.get(agent.label) ?? 0) + 1);
    }

    const list = el("div", { className: "agent-roster" });
    for (const agent of state.agents) {
      const ambiguous = (labelCounts.get(agent.label) ?? 0) > 1;
      const row = el("button", {
        type: "button",
        className: `agent-row${agent.id === state.composeTargetId ? " selected" : ""}`,
        title: agent.id,
      }) as HTMLButtonElement;
      row.append(el("span", { className: "agent-label", text: agent.label }));
      if (ambiguous) {
        row.append(el("span", { className: "badge", text: agent.hostId }));
      }
      row.onclick = () => {
        state.composeTargetId = agent.id;
        render();
      };
      list.append(row);
    }
    body.append(list);

    const target = state.agents.find(
      (agent) => agent.id === state.composeTargetId,
    );
    if (!target) {
      body.append(
        el("p", {
          className: "empty",
          text: "Select an agent to compose a message.",
        }),
      );
      return;
    }
    body.append(renderComposeForm(target));
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
    if (state.inspector === "controls") {
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
    } else if (state.inspector === "agents") {
      renderAgentsBody(body);
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
      if (
        data.event === "agent.registered" ||
        data.event === "agent.disconnected"
      ) {
        // An agent connecting/disconnecting is also the only signal a
        // host's Collab visibility changed — host-level discovery is
        // served through the same /ws/agent connection now, so refresh
        // both the host/session list and the agent roster together.
        void Promise.all([refresh(), loadAgents()])
          .then(() => render())
          .catch(() => {});
      }
    } catch {
      // ignore malformed frames
    }
  };
  socket.onclose = () =>
    showStatus(
      "Hub event stream disconnected; use Refresh to retry.",
      "warning",
    );

  async function handlePromoteRequest(): Promise<void> {
    const session = state.selectedSession;
    if (!session || state.selectedAccess === "control") return;
    if (!canRequestAccess(session, "control")) {
      showStatus(
        "This room is view-only; session prompting isn't available.",
        "warning",
      );
      return;
    }
    await openCollab("control");
  }

  window.addEventListener("message", (event) => {
    const frame = root.querySelector<HTMLIFrameElement>("[data-collab-frame]");
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as { source?: string; type?: string } | null;
    if (data?.source !== "omp-collab-web" || data.type !== "promote-request")
      return;
    void handlePromoteRequest();
  });
  setInterval(() => void pollSessions().catch(() => {}), SESSION_POLL_MS);
  void refresh().catch((error) => showStatus(error.message, "warning"));
}

const root = document.querySelector<HTMLElement>("[data-omp-dashboard]");
if (root) createDashboard(root);