// Standalone single-session links (/s/). The link carries no secret: it names
// a session by instance id, plus the cwd / ompc label / session id needed to
// find it again or start it after the omp process has gone. The page resolves
// it to a live Collab room on every load, so the link survives restarts.

export interface ShareTarget {
  host: string;
  /** Instance id of the omp process the link was copied from. */
  instance?: string;
  /** Conversation (session file) id; survives a restart via resume. */
  sessionId?: string;
  cwd?: string;
  /** Full ompc label (`<dir>` or `<dir>.<suffix>`). */
  label?: string;
}

/** The fields of a hub collab.list entry that matching needs. */
export interface ShareCandidate {
  instanceId: string;
  sessionId?: string;
  label?: string;
  cwd?: string;
}

export const SHARE_PATH = "/s/";

export function buildShareUrl(origin: string, target: ShareTarget): string {
  const url = new URL(SHARE_PATH, origin);
  url.searchParams.set("host", target.host);
  if (target.instance) url.searchParams.set("i", target.instance);
  if (target.sessionId) url.searchParams.set("sid", target.sessionId);
  if (target.cwd) url.searchParams.set("cwd", target.cwd);
  if (target.label) url.searchParams.set("label", target.label);
  return url.toString();
}

export function parseShareUrl(search: string): ShareTarget | null {
  const params = new URLSearchParams(search);
  const host = params.get("host");
  if (!host) return null;
  const target: ShareTarget = { host };
  for (const [key, field] of [
    ["i", "instance"],
    ["sid", "sessionId"],
    ["cwd", "cwd"],
    ["label", "label"],
  ] as const) {
    const value = params.get(key);
    if (value) target[field] = value;
  }
  return target;
}

/**
 * Picks the live session a link refers to: the same instance if it is still
 * running, else the same conversation, else the same ompc label in the same
 * directory. Returns undefined when nothing matches or a weaker key is
 * ambiguous (two live sessions sharing a conversation or label).
 */
export function matchSession<T extends ShareCandidate>(
  sessions: readonly T[],
  target: ShareTarget,
): T | undefined {
  if (target.instance) {
    const exact = sessions.find((s) => s.instanceId === target.instance);
    if (exact) return exact;
  }
  const only = (found: T[]) => (found.length === 1 ? found[0] : undefined);
  if (target.sessionId) {
    const hit = only(sessions.filter((s) => s.sessionId === target.sessionId));
    if (hit) return hit;
  }
  if (target.label) {
    return only(
      sessions.filter(
        (s) =>
          s.label === target.label &&
          (!target.cwd || !s.cwd || s.cwd === target.cwd),
      ),
    );
  }
  return undefined;
}

/** The ompc name suffix of `label` for a session rooted at `cwd`: `proj.review` in /x/proj is `review`. */
export function labelSuffix(label: string | undefined, cwd: string): string {
  if (!label) return "";
  const base = cwd.split("/").filter(Boolean).pop() ?? "";
  return label.startsWith(`${base}.`) ? label.slice(base.length + 1) : "";
}
