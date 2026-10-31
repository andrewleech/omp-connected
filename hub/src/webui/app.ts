// The OMP fleet dashboard shell.
//
// The dashboard socket only ever receives agent registration, activity and
// session group changes (see dashboard-events.ts) — never a generic
// heartbeat — so there is no broadcast-storm to defend against here.
// Collab session state (what's running on a host) is polled on a fixed
// interval instead of being pushed, since this server only ever learns
// it by RPC-polling a host itself.

import { AuthPane } from "./lib/auth-pane";
import {
  attachCollabFileLinks,
  customizeCollabFrame,
} from "./lib/collab-frame";
import { collabFrameUrl } from "./lib/collab-link";
import { CollabTailViewer } from "./lib/collab-tail";
import { copyText, el } from "./lib/dom";
import { type EdgeSwipeOptions, attachEdgeSwipe } from "./lib/edge-swipe";
import { FilesPane } from "./lib/files-pane";
import { ModelRolesPane } from "./lib/model-roles-pane";
import {
  SCHEDULE_FEATURE,
  attachScheduledSend,
  scheduleApi,
} from "./lib/scheduled-send";
import {
  EXIT_FEATURE,
  SESSION_FORK_FEATURE,
  sessionApiBase,
  supportsAuth,
} from "./lib/session-api";
import { SessionLauncher } from "./lib/session-launcher";
import { SessionPane } from "./lib/session-pane";
import { buildShareUrl } from "./lib/share-link";
import {
  type CollabSession,
  INSPECTOR_PANES,
  type InspectorPane,
  type WorkspaceGroup,
  canRequestAccess,
  defaultRequestedAccess,
  dropLegacyGroups,
  groupMemberKey,
  groupSessions,
  keepKnownOmpcLabels,
  legacyGroupsForImport,
  readLegacyGroups,
  readWorkspace,
  resolveRememberedSession,
  sessionKey,
  sessionLabel,
  workspaceSignature,
  writeWorkspace,
} from "./lib/workspace";

const SESSION_POLL_MS = 15_000;
const AGENT_EVENT_REFRESH_MS = 1_000;

interface HostSummary {
  hostId: string;
}

/** GET /api/groups, POST /api/groups* answers and `groups.changed` events. */
interface GroupList {
  revision: number;
  groups: WorkspaceGroup[];
}

// Only identity and activity are consumed by the session rail.
interface AgentSummary {
  id: string;
  busy?: boolean;
  waiting?: boolean;
}

function displayName(session: CollabSession): string {
  return session.sessionName || session.sessionId || session.instanceId;
}

interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
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
    const li = el("li", { className: item.danger ? "ctx-danger" : "" });
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

async function loadPublicOrigin(): Promise<string | null> {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) return null;
    const config: { publicOrigin?: unknown } = await response.json();
    if (typeof config.publicOrigin !== "string") return null;
    const url = new URL(config.publicOrigin);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

const publicOrigin = loadPublicOrigin();

function createDashboard(root: HTMLElement): void {
  const state = {
    ...readWorkspace(localStorage),
    groups: [] as WorkspaceGroup[],
    hosts: [] as HostSummary[],
    sessions: [] as CollabSession[],
    selectedSession: null as CollabSession | null,
    selectedAccess: null as "view" | "control" | null,
    agents: [] as AgentSummary[],
  };
  // Revision of state.groups; -1 accepts the next list whatever its revision.
  let groupsRevision = -1;
  // Hosts whose latest session listing succeeded.
  let listedHosts = new Set<string>();
  let lastWorkspaceSignature: string | null | undefined;
  let tailViewer: CollabTailViewer | null = null;
  let collabRequest = 0;
  let leftDrawerOpen = false;
  let rightDrawerOpen = false;
  let drawerTrigger: HTMLElement | null = null;
  const launcher = new SessionLauncher((label) => {
    showStatus(`Started ${label}; waiting for it to register…`, "ok");
    void pollSessions().catch((error: unknown) =>
      showStatus((error as Error).message, "warning"),
    );
  });
  const sessionPane = new SessionPane({ showStatus });
  const filesPane = new FilesPane(
    { showStatus },
    (session) => sessionPane.cwdFor(session),
    publicOrigin,
  );
  const modelRolesPane = new ModelRolesPane({ showStatus }, (pane) => {
    state.inspector = pane;
    persist();
    render();
  });
  const authPane = new AuthPane({ showStatus });
  let inspectorShell:
    | { tabs: Map<InspectorPane, HTMLButtonElement>; body: HTMLElement }
    | undefined;

  function isCompactLayout(): boolean {
    return window.matchMedia("(max-width: 768px)").matches;
  }

  function setDrawer(
    drawer: "left" | "right",
    open: boolean,
    trigger?: HTMLElement,
  ): void {
    if (drawer === "left") leftDrawerOpen = open;
    else rightDrawerOpen = open;
    if (open && trigger) drawerTrigger = trigger;
    root.dataset.leftDrawerOpen = String(leftDrawerOpen);
    root.dataset.rightDrawerOpen = String(rightDrawerOpen);
    root
      .querySelector<HTMLButtonElement>("[data-session-drawer-toggle]")
      ?.setAttribute("aria-expanded", String(leftDrawerOpen));
    root
      .querySelector<HTMLButtonElement>("[data-inspector-drawer-toggle]")
      ?.setAttribute("aria-expanded", String(rightDrawerOpen));
    const compact = isCompactLayout();
    for (const [selector, isOpen] of [
      ["[data-session-rail]", leftDrawerOpen],
      ["[data-inspector]", rightDrawerOpen],
    ] as const) {
      const panel = root.querySelector<HTMLElement>(selector);
      if (!panel) continue;
      panel.toggleAttribute("inert", compact && !isOpen);
      if (compact && !isOpen) panel.setAttribute("aria-hidden", "true");
      else panel.removeAttribute("aria-hidden");
    }
    const backdrop = root.querySelector<HTMLButtonElement>(
      "[data-drawer-backdrop]",
    );
    if (backdrop) backdrop.hidden = !leftDrawerOpen && !rightDrawerOpen;
    if (!open && !leftDrawerOpen && !rightDrawerOpen) {
      drawerTrigger?.focus();
      drawerTrigger = null;
    }
    if (open) {
      requestAnimationFrame(() => {
        root
          .querySelector<HTMLButtonElement>(
            drawer === "left"
              ? "[data-session-drawer-close]"
              : "[data-inspector-drawer-close]",
          )
          ?.focus({ preventScroll: true });
      });
    }
  }

  function closeDrawers(): void {
    if (!leftDrawerOpen && !rightDrawerOpen) return;
    leftDrawerOpen = false;
    rightDrawerOpen = false;
    setDrawer("left", false);
  }

  function edgeSwipeOptions(offsetX: () => number): EdgeSwipeOptions {
    return {
      offsetX,
      viewportWidth: () => window.innerWidth,
      enabled: isCompactLayout,
      drawers: () => ({ left: leftDrawerOpen, right: rightDrawerOpen }),
      onSwipe: (action) => {
        const toggle = root.querySelector<HTMLElement>(
          action.endsWith("left")
            ? "[data-session-drawer-toggle]"
            : "[data-inspector-drawer-toggle]",
        );
        setDrawer(
          action.endsWith("left") ? "left" : "right",
          action.startsWith("open"),
          toggle ?? undefined,
        );
      },
    };
  }

  function persist(): void {
    writeWorkspace(localStorage, {
      version: 1,
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

  // Each host's list is applied as soon as it arrives, so one slow host
  // never holds back the sessions of the others. A host whose listing is
  // pending or fails keeps its previous list, and a selection on that host is
  // never swapped for another session: only a host that answers without the
  // session can retire it.
  async function loadSessions(): Promise<void> {
    const byHost = new Map<string, CollabSession[]>();
    for (const host of state.hosts) byHost.set(host.hostId, []);
    for (const session of state.sessions)
      byHost.get(session.host_id)?.push(session);
    const settledHosts = new Set<string>();
    const listed = new Set<string>();
    const apply = (): void => {
      state.sessions = state.hosts.flatMap(
        (host) => byHost.get(host.hostId) ?? [],
      );
      reconcileSelection();
      render();
    };
    await Promise.all(
      state.hosts.map(async (host) => {
        try {
          const result = await json<{ sessions: CollabSession[] }>(
            `/api/hosts/${encodeURIComponent(host.hostId)}/collab`,
          );
          byHost.set(
            host.hostId,
            keepKnownOmpcLabels(
              byHost.get(host.hostId) ?? [],
              result.sessions.map((session) => ({
                ...session,
                host_id: host.hostId,
              })),
            ),
          );
          listed.add(host.hostId);
        } catch (error) {
          showStatus(`${host.hostId}: ${(error as Error).message}`, "warning");
        }
        settledHosts.add(host.hostId);
        if (settledHosts.size < state.hosts.length) apply();
      }),
    );
    listedHosts = listed;
    apply();
    void importLegacyGroups().catch(() => {});
  }

  function reconcileSelection(): void {
    const remembered = resolveRememberedSession(state.sessions, state.selected);
    // Only a session the user picked is shown. One missing from the listing
    // (room relaunching, host late or offline, session exited) stays shown,
    // or the workspace stays empty; switching to a session the user did not
    // pick would be confusing.
    if (!remembered) return;
    if (
      state.selectedSession &&
      sessionKey(state.selectedSession) === sessionKey(remembered)
    ) {
      // Same room as before this refresh: only update its polled fields
      // (participants, etc.); selectSession() would blank and reload the
      // live iframe for no reason.
      state.selectedSession = remembered;
      return;
    }
    selectSession(remembered);
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
    // Re-fetch hosts too: a host that registers after page load must appear
    // without a manual reload.
    state.hosts = await json<HostSummary[]>("/api/hosts");
    await loadSessions();
    render();
  }

  function selectSession(session: CollabSession): void {
    const request = ++collabRequest;
    // A different session invalidates every in-flight capability result before
    // its old surface is torn down.
    tailViewer?.destroy();
    tailViewer = null;
    const frame = root.querySelector<HTMLIFrameElement>("[data-collab-frame]");
    if (frame) frame.src = "about:blank";
    state.selected = sessionKey(session);
    unseenIdle.delete(`${session.host_id}:${session.instanceId}`);
    state.selectedSession = session;
    state.selectedAccess = null;
    persist();
    render();
    void openCollab(defaultRequestedAccess(session), request);
  }

  function applyGroups(list: GroupList): void {
    if (list.revision <= groupsRevision) return;
    groupsRevision = list.revision;
    state.groups = list.groups;
    const rail = root.querySelector("[data-session-rail]");
    if (rail) renderRail(rail);
  }

  async function loadGroups(): Promise<void> {
    applyGroups(await json<GroupList>("/api/groups"));
  }

  async function changeGroups(
    path: string,
    body?: unknown,
    method = "POST",
  ): Promise<void> {
    try {
      // A change from this tab must not reach an empty hub before this
      // browser's legacy groups, or their import would be refused.
      await importLegacyGroups(true);
      applyGroups(
        await json<GroupList>(`/api/groups${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    } catch (error) {
      showStatus((error as Error).message, "warning");
    }
  }

  function setGroup(session: CollabSession, groupId: string | null): void {
    void changeGroups("/assign", { session: groupMemberKey(session), groupId });
  }

  // Uploads groups this browser kept before the hub stored them, once, into
  // a hub with no groups. It waits while a connected host has not listed
  // (see legacyGroupsForImport) and is retried after every session load; a
  // group change in this tab runs it first without waiting. The local copy
  // goes once imported, or when the hub already had groups from another tab
  // or device before this tab's attempt.
  let legacyImport: Promise<void> | undefined;
  async function importLegacyGroups(force = false): Promise<void> {
    while (legacyImport) await legacyImport.catch(() => {});
    legacyImport = runLegacyImport(force);
    try {
      await legacyImport;
    } finally {
      legacyImport = undefined;
    }
  }

  async function runLegacyImport(force: boolean): Promise<void> {
    const legacy = readLegacyGroups(localStorage);
    if (legacy.length === 0) return;
    if (groupsRevision < 0) {
      if (!force) return;
      await loadGroups();
    }
    if (state.groups.length === 0) {
      const waitingHosts = new Set(
        force
          ? []
          : state.hosts
              .map((host) => host.hostId)
              .filter((hostId) => !listedHosts.has(hostId)),
      );
      const groups = legacyGroupsForImport(
        legacy,
        state.sessions,
        waitingHosts,
      );
      if (!groups) return;
      const response = await fetch("/api/groups/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups }),
      });
      // 409: the hub got groups elsewhere first; this tab's own changes
      // only follow a settled import.
      if (!response.ok && response.status !== 409)
        throw new Error(
          `Could not import this browser's groups (${response.status})`,
        );
      if (response.ok) applyGroups((await response.json()) as GroupList);
    }
    dropLegacyGroups(localStorage);
  }

  async function openCollab(
    access: "view" | "control",
    request = ++collabRequest,
  ): Promise<void> {
    const session = state.selectedSession;
    const selectedKey = session && sessionKey(session);
    if (!session || !selectedKey || !canRequestAccess(session, access)) return;
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
      if (
        request !== collabRequest ||
        state.selectedSession === null ||
        sessionKey(state.selectedSession) !== selectedKey
      )
        return;

      // View mode: use the lightweight tail viewer (no full-history replay).
      // Control mode: use the full Collab iframe (needs the composer UI).
      if (access === "view") {
        tailViewer?.destroy();
        const frame = root.querySelector<HTMLIFrameElement>(
          "[data-collab-frame]",
        );
        if (frame) frame.style.display = "none";
        const workspace = root.querySelector("[data-workspace]");
        let viewerEl = workspace?.querySelector<HTMLElement>(".tail-viewer");
        if (!viewerEl) {
          viewerEl = document.createElement("div");
          workspace?.appendChild(viewerEl);
        }
        tailViewer = new CollabTailViewer(viewerEl);
        void tailViewer.connect(result.url);
      } else {
        tailViewer?.destroy();
        tailViewer = null;
        root.querySelector(".tail-viewer")?.remove();
        const frame = root.querySelector<HTMLIFrameElement>(
          "[data-collab-frame]",
        );
        if (frame) {
          frame.style.display = "";
          frame.src = collabFrameUrl(result.url, location.origin);
        }
      }

      state.selectedAccess = access;
      render();
      showStatus(
        `${access === "control" ? "Control" : "View"} room opened`,
        "ok",
      );
    } catch (error) {
      if (request !== collabRequest) return;
      const message = (error as Error).message;
      showStatus(
        /generation|stale|not found/i.test(message)
          ? "Session changed on its host. Refresh sessions and retry."
          : message,
        "warning",
      );
    }
  }

  async function exitSession(session: CollabSession): Promise<void> {
    if (
      !window.confirm(
        `Exit "${sessionLabel(session)}"? This closes OMP and its ompc tmux session, if present.`,
      )
    )
      return;
    try {
      await json(
        `${sessionApiBase(session.host_id, session.instanceId)}/exit`,
        { method: "POST" },
      );
      showStatus(`Exit requested for ${sessionLabel(session)}`, "ok");
      void pollSessions().catch((error: unknown) =>
        showStatus((error as Error).message, "warning"),
      );
    } catch (error) {
      showStatus((error as Error).message, "warning");
    }
  }

  async function forkSession(session: CollabSession): Promise<void> {
    if (
      session.access !== "control" ||
      !session.features?.includes(SESSION_FORK_FEATURE)
    )
      return;
    const requestedName = prompt("Name this forked session");
    if (requestedName === null || !requestedName.trim()) return;
    try {
      const result = await json<{ ok: true; label: string }>(
        `${sessionApiBase(session.host_id, session.instanceId)}/fork`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: requestedName.trim() }),
        },
      );
      showStatus(`Started ${result.label}; waiting for it to register…`, "ok");
      void pollSessions().catch((error: unknown) =>
        showStatus((error as Error).message, "warning"),
      );
    } catch (error) {
      showStatus((error as Error).message, "warning");
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
      {
        label: "Copy share link",
        disabled: session.access !== "control",
        onSelect: () => {
          const link = buildShareUrl(location.origin, {
            host: session.host_id,
            instance: session.instanceId,
            sessionId: session.sessionId,
            cwd: session.cwd,
            label: session.label,
          });
          void copyText(link).then((ok) =>
            ok
              ? showStatus("Share link copied", "ok")
              : showStatus("Copy failed", "warning"),
          );
        },
      },
    ];
    const current = state.groups.find((group) =>
      group.sessions.includes(groupMemberKey(session)),
    );
    const agent = state.agents.find(
      (candidate) =>
        candidate.id === `${session.host_id}:${session.instanceId}`,
    );
    items.push({
      label: "Fork session",
      disabled:
        session.access !== "control" ||
        !session.features?.includes(SESSION_FORK_FEATURE) ||
        agent?.busy === true,
      onSelect: () => void forkSession(session),
    });
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
        if (!name?.trim()) return;
        void changeGroups("", { name, session: groupMemberKey(session) });
      },
    });
    items.push({
      label: "Exit session",
      danger: true,
      disabled:
        session.access !== "control" ||
        !session.features?.includes(EXIT_FEATURE),
      onSelect: () => void exitSession(session),
    });
    return items;
  }

  function renderRail(container: Element): void {
    const rail = container as HTMLElement;
    const oldScrollTop = rail.scrollTop;
    const railTop = rail.getBoundingClientRect().top;
    const oldAnchor = Array.from(
      rail.querySelectorAll<HTMLElement>(".session-card"),
    ).find((card) => card.getBoundingClientRect().bottom > railTop);
    const anchorKey = oldAnchor?.dataset.sessionKey;
    const anchorTop = oldAnchor?.getBoundingClientRect().top;
    rail.replaceChildren();
    const drawerHeader = el("div", { className: "drawer-header" });
    drawerHeader.append(el("strong", { text: "Sessions" }));
    const close = el("button", { type: "button", text: "Close" });
    close.dataset.sessionDrawerClose = "";
    drawerHeader.append(close);
    container.append(drawerHeader);
    const addGroup = el("button", {
      className: "quiet",
      text: "+ New project group",
      type: "button",
    });
    (addGroup as HTMLButtonElement).onclick = () => {
      const name = prompt("Group name?");
      if (!name?.trim()) return;
      void changeGroups("", { name });
    };
    container.append(addGroup);
    const groups = groupSessions(state.sessions, state.groups);
    for (const host of state.hosts) {
      if (!groups.some((group) => !group.custom && group.name === host.hostId))
        groups.push({
          id: `host:${host.hostId}`,
          name: host.hostId,
          custom: false,
          sessions: [],
        });
    }
    for (const group of groups) {
      const section = el("div", { className: "session-group" });
      const heading = el("div", { className: "session-group-heading" });
      heading.append(el("h2", { text: group.name }));
      if (!group.custom) {
        const start = el("button", {
          type: "button",
          text: "+",
          title: `Start session on ${group.name}`,
        }) as HTMLButtonElement;
        start.className = "host-start-session";
        start.setAttribute("aria-label", `Start session on ${group.name}`);
        start.onclick = () =>
          void launcher.open(
            group.name,
            state.sessions.find((session) => session.host_id === group.name)
              ?.cwd,
          );
        heading.append(start);
      } else {
        const remove = el("button", {
          type: "button",
          text: "×",
          title: `Delete group ${group.name}`,
        }) as HTMLButtonElement;
        remove.className = "host-start-session group-delete";
        remove.setAttribute("aria-label", `Delete group ${group.name}`);
        remove.onclick = () => {
          if (
            confirm(
              `Delete group "${group.name}"? Its sessions return to their hosts.`,
            )
          )
            void changeGroups(
              `/${encodeURIComponent(group.id)}`,
              undefined,
              "DELETE",
            );
        };
        heading.append(remove);
      }
      section.append(heading);
      if (group.sessions.length === 0)
        section.append(el("p", { className: "empty", text: "No sessions" }));
      for (const session of group.sessions) {
        const card = el("button", {
          className: `session-card${sessionKey(session) === state.selected ? " selected" : ""}`,
          type: "button",
          title: displayName(session),
        }) as HTMLButtonElement;
        card.dataset.sessionKey = sessionKey(session);
        const agent = state.agents.find(
          (a) => a.id === `${session.host_id}:${session.instanceId}`,
        );
        const busy = agent?.busy;
        if (busy !== undefined) {
          const [stateClass, label] =
            agent?.waiting === true
              ? ["waiting", "Waiting for your answer"]
              : busy
                ? ["working", "Working"]
                : ["idle", "Idle"];
          const dot = el("span", {
            className: `activity-dot ${stateClass}${stateClass === "idle" && agent !== undefined && unseenIdle.has(agent.id) ? " unseen" : ""}`,
            title: label,
          });
          // Described rather than named, so the card's accessible name stays
          // the session label.
          dot.setAttribute("aria-hidden", "true");
          card.setAttribute("aria-description", label);
          card.append(dot);
        }
        card.append(
          el("span", {
            className: "session-label",
            text: sessionLabel(session),
          }),
        );
        // Control is the norm; only flag the exception.
        if (session.access !== "control")
          card.append(
            el("span", {
              className: `badge ${session.access}`,
              text: session.access,
            }),
          );
        card.onclick = () => {
          // Same rule as the refresh path: re-selecting the room that is
          // already open would blank the iframe and replay its whole history.
          // A selection that never opened (selectedAccess still null) retries.
          const open =
            state.selectedAccess !== null &&
            state.selectedSession !== null &&
            sessionKey(state.selectedSession) === sessionKey(session);
          if (!open) selectSession(session);
          if (isCompactLayout()) closeDrawers();
        };
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
    const newAnchor = anchorKey
      ? Array.from(rail.querySelectorAll<HTMLElement>(".session-card")).find(
          (card) => card.dataset.sessionKey === anchorKey,
        )
      : undefined;
    if (newAnchor && anchorTop !== undefined)
      rail.scrollTop += newAnchor.getBoundingClientRect().top - anchorTop;
    else rail.scrollTop = oldScrollTop;
  }

  function renderWorkspace(container: Element): void {
    const session = state.selectedSession;
    const signature = workspaceSignature(session, state.selectedAccess);
    if (signature === lastWorkspaceSignature) return;
    lastWorkspaceSignature = signature;
    // Preserve live elements from being destroyed by replaceChildren
    const frame = container.querySelector<HTMLIFrameElement>(
      "[data-collab-frame]",
    );
    const viewerEl = container.querySelector<HTMLElement>(".tail-viewer");
    container.replaceChildren();
    if (!session) {
      tailViewer?.destroy();
      tailViewer = null;
      container.append(
        el("div", {
          className: "empty workspace-empty",
          text: "No live OMP Collab rooms found. Start one on a registered host, then refresh.",
        }),
      );
      return;
    }
    // The Collab iframe (control mode) shows the session title in its own
    // header, so only label the workspace while connecting or for the
    // title-less tail viewer.
    if (state.selectedAccess !== "control") {
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
          text: state.selectedAccess === "view" ? "view" : "connecting…",
        }),
      );
      header.append(title);
      container.append(header);
    }
    // Tail viewer active → show it; otherwise show the collab iframe.
    if (tailViewer && viewerEl) {
      viewerEl.style.display = "";
      container.append(viewerEl);
      if (frame) {
        frame.style.display = "none";
        container.append(frame);
      }
    } else {
      const iframeEl = frame ?? document.createElement("iframe");
      iframeEl.className = "collab-frame";
      iframeEl.dataset.collabFrame = "";
      iframeEl.title = "OMP Collab session";
      iframeEl.referrerPolicy = "no-referrer";
      container.append(iframeEl);
    }
  }

  // Agents that went idle while the user was elsewhere pulse until opened.
  const unseenIdle = new Set<string>();
  const lastAgentState = new Map<string, string>();
  function agentStateOf(a: AgentSummary): string {
    return a.waiting === true ? "waiting" : a.busy ? "working" : "idle";
  }
  function selectedAgentId(): string | null {
    const s = state.selectedSession;
    return s ? `${s.host_id}:${s.instanceId}` : null;
  }
  function noteAgentTransitions(agents: AgentSummary[]): void {
    const seen = selectedAgentId();
    for (const a of agents) {
      if (a.busy === undefined) continue;
      const now = agentStateOf(a);
      const before = lastAgentState.get(a.id);
      if (before !== undefined && before !== now) {
        if (now === "idle" && a.id !== seen) unseenIdle.add(a.id);
        else unseenIdle.delete(a.id);
      }
      lastAgentState.set(a.id, now);
    }
  }
  async function loadAgents(): Promise<void> {
    try {
      const result = await json<{ agents: AgentSummary[] }>("/api/agents");
      noteAgentTransitions(result.agents);
      state.agents = result.agents;
    } catch {
      // Agent activity is auxiliary; preserve the last known rail indicators.
    }
  }
  const INSPECTOR_LABELS: Record<InspectorPane, string> = {
    session: "Session",
    files: "Files",
    agents: "Agents",
    models: "Roles",
    auth: "Login",
  };

  /** Persistent pane trees stay attached across renders to preserve focus and edit state. */
  function renderInspector(container: Element): void {
    if (!inspectorShell || !container.contains(inspectorShell.body)) {
      container.replaceChildren();
      const drawerHeader = el("div", { className: "drawer-header" });
      drawerHeader.append(el("strong", { text: "Inspector" }));
      const close = el("button", { type: "button", text: "Close" });
      close.dataset.inspectorDrawerClose = "";
      drawerHeader.append(close);
      const tabBar = el("div", { className: "tabs" });
      const tabs = new Map<InspectorPane, HTMLButtonElement>();
      for (const pane of INSPECTOR_PANES) {
        const tab = el("button", {
          text: INSPECTOR_LABELS[pane],
          type: "button",
        }) as HTMLButtonElement;
        tab.dataset.inspectorTab = pane;
        tab.onclick = () => {
          state.inspector = pane;
          persist();
          render();
        };
        tabs.set(pane, tab);
        tabBar.append(tab);
      }
      const body = el("div", { className: "inspector-body" });
      container.append(drawerHeader, tabBar, body);
      inspectorShell = { tabs, body };
    }
    const { tabs, body } = inspectorShell;
    const session = state.selectedSession;
    const authAvailable =
      !!session && supportsAuth(session) && session.access === "control";
    // A persisted Login selection falls back to Session when this session
    // cannot log in, without overwriting the stored choice.
    const inspector =
      state.inspector === "auth" && !authAvailable
        ? "session"
        : state.inspector;
    for (const [pane, tab] of tabs) {
      tab.hidden = pane === "auth" && !authAvailable;
      tab.classList.toggle("active", pane === inspector);
      tab.setAttribute("aria-pressed", String(pane === inspector));
    }
    sessionPane.setSession(state.selectedSession);
    filesPane.setSession(state.selectedSession);
    sessionPane.setActive(inspector === "session");
    modelRolesPane.setSession(state.selectedSession);
    modelRolesPane.setView(inspector === "agents" ? "agents" : "roles");
    modelRolesPane.setActive(inspector === "models" || inspector === "agents");
    filesPane.setActive(inspector === "files");
    authPane.setSession(state.selectedSession);
    authPane.setActive(inspector === "auth");
    const pane =
      inspector === "session"
        ? sessionPane.element
        : inspector === "files"
          ? filesPane.element
          : inspector === "auth"
            ? authPane.element
            : modelRolesPane.element;
    if (body.firstElementChild !== pane || body.childElementCount !== 1)
      body.replaceChildren(pane);
  }

  function render(): void {
    const rail = root.querySelector("[data-session-rail]");
    const workspace = root.querySelector("[data-workspace]");
    const inspector = root.querySelector("[data-inspector]");
    if (rail) renderRail(rail);
    if (workspace) renderWorkspace(workspace);
    if (inspector) renderInspector(inspector);
    const selected = state.selectedSession;
    const label = root.querySelector("[data-topbar-session]");
    if (label)
      label.textContent = selected ? sessionLabel(selected) : "No session";
  }

  // Customize the same-origin Collab guest on every frame load (see
  // lib/collab-frame.ts), forward its edge swipes to the drawers, and add
  // scheduled send to a control room whose extension serves it.
  root.addEventListener(
    "load",
    (event) => {
      const frame = event.target;
      if (!(frame instanceof HTMLIFrameElement)) return;
      const doc = frame.contentDocument;
      if (!doc?.head) return;
      customizeCollabFrame(doc, localStorage);
      attachCollabFileLinks(doc, (path) => filesPane.openFilePath(path));
      attachEdgeSwipe(
        doc,
        edgeSwipeOptions(() => frame.getBoundingClientRect().left),
      );
      const session = state.selectedSession;
      if (
        session &&
        state.selectedAccess === "control" &&
        doc.location.href !== "about:blank" &&
        session.features?.includes(SCHEDULE_FEATURE)
      )
        attachScheduledSend(
          doc,
          scheduleApi(sessionApiBase(session.host_id, session.instanceId)),
        );
    },
    true,
  );
  attachEdgeSwipe(
    document,
    edgeSwipeOptions(() => 0),
  );

  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("button");
    if (!target) return;
    if (target.matches("[data-session-drawer-toggle]")) {
      setDrawer("left", !leftDrawerOpen, target);
      return;
    }
    if (target.matches("[data-inspector-drawer-toggle]")) {
      setDrawer("right", !rightDrawerOpen, target);
      return;
    }
    if (target.matches("[data-session-drawer-close]")) {
      setDrawer("left", false);
      return;
    }
    if (target.matches("[data-inspector-drawer-close]")) {
      setDrawer("right", false);
      return;
    }
    if (target.matches("[data-drawer-backdrop]")) closeDrawers();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isCompactLayout()) closeDrawers();
  });
  window
    .matchMedia("(min-width: 769px)")
    .addEventListener("change", (event) => {
      if (event.matches) closeDrawers();
    });
  let edgeSwipe:
    | { side: "left" | "right"; x: number; y: number; pointerId: number }
    | undefined;
  root.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" || !isCompactLayout()) return;
    const edge = 24;
    if (event.clientX <= edge)
      edgeSwipe = {
        side: "left",
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
      };
    else if (event.clientX >= window.innerWidth - edge)
      edgeSwipe = {
        side: "right",
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
      };
  });
  root.addEventListener("pointerup", (event) => {
    if (!edgeSwipe || event.pointerId !== edgeSwipe.pointerId) return;
    const swipe = edgeSwipe;
    edgeSwipe = undefined;
    const horizontal = event.clientX - swipe.x;
    const vertical = Math.abs(event.clientY - swipe.y);
    if (vertical > 32 || Math.abs(horizontal) < 72) return;
    if (swipe.side === "left" && horizontal > 0) setDrawer("left", true);
    if (swipe.side === "left" && horizontal < 0) setDrawer("left", false);
    if (swipe.side === "right" && horizontal < 0) setDrawer("right", true);
    if (swipe.side === "right" && horizontal > 0) setDrawer("right", false);
  });
  root.addEventListener("pointercancel", () => {
    edgeSwipe = undefined;
  });
  setDrawer("left", false);

  // A reconnecting agent can emit hundreds of these per second. Run one
  // refresh at a time, then hold off for AGENT_EVENT_REFRESH_MS, folding
  // every event that arrives meanwhile into a single follow-up.
  let agentEventBusy = false;
  let agentEventQueued = false;
  function refreshForAgentEvent(): void {
    if (agentEventBusy) {
      agentEventQueued = true;
      return;
    }
    agentEventBusy = true;
    void Promise.all([refresh(), loadAgents()])
      .then(() => render())
      .catch(() => {})
      .finally(() =>
        setTimeout(() => {
          agentEventBusy = false;
          if (!agentEventQueued) return;
          agentEventQueued = false;
          refreshForAgentEvent();
        }, AGENT_EVENT_REFRESH_MS),
      );
  }

  // Reconnects after the hub restarts or the link drops. Events sent in the
  // gap are not replayed (activity dots in particular), so reconnects reload
  // host, session and agent activity data.
  let reconnectDelay = 1000;
  let hadSocket = false;
  function connectSocket(): void {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/dashboard`,
    );
    socket.onopen = () => {
      reconnectDelay = 1000;
      if (hadSocket) {
        // Group changes in the gap were missed too, and a restarted hub may
        // number its revisions from a lower value.
        groupsRevision = -1;
        void loadGroups().catch(() => {});
        refreshForAgentEvent();
      }
      hadSocket = true;
    };
    socket.onmessage = handleSocketMessage;
    socket.onclose = () => {
      setTimeout(connectSocket, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
  }
  function handleSocketMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(String(event.data)) as {
        event?: string;
        agentId?: string;
        busy?: boolean;
        waiting?: boolean;
        revision?: number;
        groups?: WorkspaceGroup[];
      };
      if (data.event === "groups.changed") {
        if (typeof data.revision === "number" && Array.isArray(data.groups))
          applyGroups({ revision: data.revision, groups: data.groups });
        return;
      }
      if (data.event === "agent.activity") {
        // Only the dots change, so redraw the rail and leave the workspace
        // (and its live Collab iframe) alone.
        const agent = state.agents.find((a) => a.id === data.agentId);
        if (agent && typeof data.busy === "boolean") {
          agent.busy = data.busy;
          agent.waiting = data.waiting === true;
          const rail = root.querySelector("[data-session-rail]");
          if (rail) renderRail(rail);
        }
        return;
      }
      if (
        data.event === "agent.registered" ||
        data.event === "agent.disconnected"
      ) {
        // An agent connecting or disconnecting can change host visibility.
        refreshForAgentEvent();
      }
    } catch {
      // ignore malformed frames
    }
  }
  connectSocket();

  setInterval(() => void pollSessions().catch(() => {}), SESSION_POLL_MS);
  void Promise.all([refresh(), loadGroups()])
    // A failed import keeps the legacy copy and is retried after a session load.
    .then(() => importLegacyGroups().catch(() => {}))
    .then(() => loadAgents())
    .then(() => render())
    .catch((error) => showStatus(error.message, "warning"));
}

const root = document.querySelector<HTMLElement>("[data-omp-dashboard]");
if (root) createDashboard(root);

// Offline fallback page for the installed app (see sw.js). Installability
// itself only needs the manifest, so a failed registration is harmless.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
