// Pure, unit-testable helpers for the fleet dashboard's client-side state.

export const WORKSPACE_STORAGE_KEY = "omp-hub-dashboard/v1";

const WORKSPACE_VERSION = 1;
export const INSPECTOR_PANES = ["session", "files", "agents"] as const;
export type InspectorPane = (typeof INSPECTOR_PANES)[number];
const DEFAULT_INSPECTOR_PANE: InspectorPane = "session";

/**
 * The persisted inspector pane. Stored `controls` and `participants` values
 * name parts of the Session tab, so they map onto it; any other unknown
 * value falls back to the default pane.
 */
export function inspectorPaneFromStorage(value: unknown): InspectorPane {
  if (value === "controls" || value === "participants") return "session";
  return INSPECTOR_PANES.includes(value as InspectorPane)
    ? (value as InspectorPane)
    : DEFAULT_INSPECTOR_PANE;
}

export interface CollabSession {
  host_id: string;
  instanceId: string;
  generation: number;
  access: "view" | "control";
  startedAt: number;
  sessionName?: string | null;
  sessionId?: string;
  cwd?: string;
  participants?: number;
  /** Registered agent label from the hub (the ompc session name). */
  label?: string;
  /** Capabilities of the session's registered omp-connected extension. */
  features?: string[];
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  sessions: string[];
}

export interface Workspace {
  version: number;
  groups: WorkspaceGroup[];
  selected: string | null;
  inspector: InspectorPane;
}

export interface SessionGroup {
  id: string;
  name: string;
  custom: boolean;
  sessions: CollabSession[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function sessionKey(session: CollabSession): string {
  return `${session.host_id}:${session.instanceId}:${session.generation}`;
}

/**
 * Compact rail label: the hub-registered agent label (bin/ompc's session
 * name, `<dir>` or `<dir>.<suffix>`), else the project directory's basename,
 * falling back to the session's own verbose name only when no cwd was
 * reported. The verbose name remains available via the session object for
 * the central pane heading; this is deliberately the short form.
 */
export function sessionLabel(session: CollabSession): string {
  if (session.label) return session.label;
  const base = session.cwd?.split("/").filter(Boolean).pop();
  return base || session.sessionName || session.sessionId || session.instanceId;
}

export function readWorkspace(storage: StorageLike): Workspace {
  try {
    const raw = storage.getItem(WORKSPACE_STORAGE_KEY);
    const value = raw
      ? (JSON.parse(raw) as Partial<Workspace> & { groups?: unknown })
      : null;
    if (
      !value ||
      value.version !== WORKSPACE_VERSION ||
      !Array.isArray(value.groups)
    ) {
      return {
        version: WORKSPACE_VERSION,
        groups: [],
        selected: null,
        inspector: DEFAULT_INSPECTOR_PANE,
      };
    }
    const groups = value.groups
      .filter((group): group is WorkspaceGroup => {
        return (
          !!group &&
          typeof group === "object" &&
          typeof (group as WorkspaceGroup).id === "string" &&
          typeof (group as WorkspaceGroup).name === "string"
        );
      })
      .map((group) => ({
        id: group.id,
        name: group.name,
        sessions: Array.isArray(group.sessions)
          ? group.sessions.filter(
              (key): key is string => typeof key === "string",
            )
          : [],
      }));
    return {
      version: WORKSPACE_VERSION,
      groups,
      selected: typeof value.selected === "string" ? value.selected : null,
      inspector: inspectorPaneFromStorage(value.inspector),
    };
  } catch {
    return {
      version: WORKSPACE_VERSION,
      groups: [],
      selected: null,
      inspector: DEFAULT_INSPECTOR_PANE,
    };
  }
}

export function writeWorkspace(
  storage: StorageLike,
  workspace: Workspace,
): void {
  storage.setItem(
    WORKSPACE_STORAGE_KEY,
    JSON.stringify({
      version: WORKSPACE_VERSION,
      groups: workspace.groups.map(({ id, name, sessions }) => ({
        id,
        name,
        sessions,
      })),
      selected: workspace.selected,
      inspector: workspace.inspector,
    }),
  );
}

export function groupSessions(
  sessions: CollabSession[],
  groups: WorkspaceGroup[],
): SessionGroup[] {
  const grouped = new Set(groups.flatMap((group) => group.sessions));
  const byRecency = (left: CollabSession, right: CollabSession) =>
    right.startedAt - left.startedAt ||
    sessionKey(left).localeCompare(sessionKey(right));
  const named: SessionGroup[] = groups.map((group) => ({
    id: group.id,
    name: group.name,
    custom: true,
    sessions: sessions
      .filter((session) => group.sessions.includes(sessionKey(session)))
      .sort(byRecency),
  }));
  const hosts = new Map<string, CollabSession[]>();
  for (const session of sessions.filter(
    (session) => !grouped.has(sessionKey(session)),
  )) {
    const host = hosts.get(session.host_id) ?? [];
    host.push(session);
    hosts.set(session.host_id, host);
  }
  return [
    ...named,
    ...[...hosts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, hostSessions]) => ({
        id: `host:${id}`,
        name: id,
        custom: false,
        sessions: hostSessions.sort(byRecency),
      })),
  ];
}

export function canRequestAccess(
  session: CollabSession,
  access: "view" | "control",
): boolean {
  return (
    access === "view" || (access === "control" && session.access === "control")
  );
}

/** The most capable mode a host advertises for a newly selected room. */
export function defaultRequestedAccess(
  session: CollabSession,
): "view" | "control" {
  return session.access === "control" ? "control" : "view";
}

export function resolveRememberedSession(
  sessions: CollabSession[],
  selected: string | null,
): CollabSession | null {
  return sessions.find((session) => sessionKey(session) === selected) ?? null;
}

/**
 * Identity of what the workspace pane currently shows. Two renders with the
 * same signature must leave the live <iframe> untouched — detaching and
 * reinserting it forces a browser to reload its browsing context, dropping
 * the embedded Collab guest's connection and transcript. There is no
 * heartbeat or generic event tick that could trigger a spurious re-render
 * (see dashboard-events.ts); the memo stays as defense in depth against
 * any future over-eager render() call.
 */
export function workspaceSignature(
  session: CollabSession | null,
  access: string | null,
): string | null {
  return session ? `${sessionKey(session)}::${access ?? ""}` : null;
}
