// Pure, unit-testable helpers for the fleet dashboard's client-side state.
// Session groups live on the hub (/api/groups); this browser's storage keeps
// only the selected session and the inspector pane.

export const WORKSPACE_STORAGE_KEY = "omp-hub-dashboard/v1";

const WORKSPACE_VERSION = 1;
export const INSPECTOR_PANES = [
  "session",
  "files",
  "agents",
  "models",
  "auth",
] as const;
export type InspectorPane = (typeof INSPECTOR_PANES)[number];
const DEFAULT_INSPECTOR_PANE: InspectorPane = "session";

/** The persisted inspector pane. Legacy controls/participants/agents values map to their current pane. */
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
  /** Registered agent label from the hub: the ompc session name, else the
   *  cwd's basename, so not unique. */
  label?: string;
  /** Capabilities of the session's registered omp-connected extension. */
  features?: string[];
  /** The ompc session name the agent explicitly registered with; unique
   *  per host among live sessions. */
  ompcLabel?: string;
}

/** A session group as the hub stores it; `sessions` holds `groupMemberKey`s. */
export interface WorkspaceGroup {
  id: string;
  name: string;
  sessions: string[];
}

export interface Workspace {
  version: number;
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
 * A session's group member key. Unlike `sessionKey` it has no generation, so
 * a session keeps its group when its room is hosted again; a session started
 * by ompc keys on its session name, which also survives an omp restart.
 */
export function groupMemberKey(session: CollabSession): string {
  return session.ompcLabel
    ? `${session.host_id}:label:${session.ompcLabel}`
    : `${session.host_id}:instance:${session.instanceId}`;
}

/**
 * `next` with each session's ompc session name filled in from `previous`
 * when the listing lost it, as it does while a restarted hub waits for the
 * session's agent to register again, so the session keeps its group key.
 */
export function keepKnownOmpcLabels(
  previous: CollabSession[],
  next: CollabSession[],
): CollabSession[] {
  return next.map((session) => {
    if (session.ompcLabel) return session;
    const known = previous.find(
      (old) =>
        old.host_id === session.host_id &&
        old.instanceId === session.instanceId &&
        old.ompcLabel,
    )?.ompcLabel;
    return known ? { ...session, ompcLabel: known } : session;
  });
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

function parseStored(storage: StorageLike): unknown {
  try {
    const raw = storage.getItem(WORKSPACE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function readWorkspace(storage: StorageLike): Workspace {
  const value = parseStored(storage);
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== WORKSPACE_VERSION
  )
    return {
      version: WORKSPACE_VERSION,
      selected: null,
      inspector: DEFAULT_INSPECTOR_PANE,
    };
  return {
    version: WORKSPACE_VERSION,
    selected:
      "selected" in value && typeof value.selected === "string"
        ? value.selected
        : null,
    inspector: inspectorPaneFromStorage(
      "inspector" in value ? value.inspector : undefined,
    ),
  };
}

/** Saves the workspace, keeping any legacy groups until `dropLegacyGroups`. */
export function writeWorkspace(
  storage: StorageLike,
  workspace: Workspace,
): void {
  storeWorkspace(storage, workspace, readLegacyGroups(storage));
}

function storeWorkspace(
  storage: StorageLike,
  workspace: Workspace,
  legacyGroups: WorkspaceGroup[],
): void {
  storage.setItem(
    WORKSPACE_STORAGE_KEY,
    JSON.stringify({
      version: WORKSPACE_VERSION,
      ...(legacyGroups.length > 0 ? { groups: legacyGroups } : {}),
      selected: workspace.selected,
      inspector: workspace.inspector,
    }),
  );
}

/** Groups this browser stored itself before the hub kept them. */
export function readLegacyGroups(storage: StorageLike): WorkspaceGroup[] {
  const value = parseStored(storage);
  if (
    typeof value !== "object" ||
    value === null ||
    !("groups" in value) ||
    !Array.isArray(value.groups)
  )
    return [];
  return value.groups.flatMap((group: unknown) =>
    typeof group === "object" &&
    group !== null &&
    "id" in group &&
    typeof group.id === "string" &&
    "name" in group &&
    typeof group.name === "string"
      ? [
          {
            id: group.id,
            name: group.name,
            sessions:
              "sessions" in group && Array.isArray(group.sessions)
                ? group.sessions.filter(
                    (key: unknown): key is string => typeof key === "string",
                  )
                : [],
          },
        ]
      : [],
  );
}

export function dropLegacyGroups(storage: StorageLike): void {
  storeWorkspace(storage, readWorkspace(storage), []);
}

/**
 * Legacy groups as a `POST /api/groups/import` body. Their members are
 * `sessionKey`s; each becomes the `groupMemberKey` of the listed session it
 * names (any generation). A member that matches no listed session is
 * dropped, unless its host is in `waitingHosts` (connected, but its latest
 * listing has not succeeded): then the result is null, so the import waits.
 */
export function legacyGroupsForImport(
  groups: WorkspaceGroup[],
  sessions: CollabSession[],
  waitingHosts: ReadonlySet<string>,
): { name: string; sessions: string[] }[] | null {
  const body = [];
  for (const group of groups) {
    const members = new Set<string>();
    for (const key of group.sessions) {
      const session = resolveRememberedSession(sessions, key);
      if (session) members.add(groupMemberKey(session));
      else if ([...waitingHosts].some((host) => key.startsWith(`${host}:`)))
        return null;
    }
    body.push({
      name: group.name.trim().slice(0, 64) || "Group",
      sessions: [...members],
    });
  }
  return body;
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
      .filter((session) => group.sessions.includes(groupMemberKey(session)))
      .sort(byRecency),
  }));
  const hosts = new Map<string, CollabSession[]>();
  for (const session of sessions.filter(
    (session) => !grouped.has(groupMemberKey(session)),
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

/**
 * The listed session a stored selection key refers to: the same room, or the
 * room the same OMP process hosts now. A process hosts a new generation when
 * its room ends (e.g. a relay send backlog), and that is still the session
 * the user picked.
 */
export function resolveRememberedSession(
  sessions: CollabSession[],
  selected: string | null,
): CollabSession | null {
  if (!selected) return null;
  return (
    sessions.find((session) => sessionKey(session) === selected) ??
    sessions.find((session) =>
      selected.startsWith(`${session.host_id}:${session.instanceId}:`),
    ) ??
    null
  );
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
