// Client-side wire types and pure helpers for the hub's per-session REST
// routes (`/api/hosts/:hostId/sessions/:instanceId/...`), which the
// dashboard's Session and Files inspector tabs are built on.

export const SESSION_FEATURE = "session.v1";
export const NEEDS_UPDATE_NOTE =
  "Controls need the updated omp-connected extension; restart this session to enable them.";
export const VIEW_ONLY_FILES_NOTE = "Files need a control-shared session.";
export const VIEW_ONLY_CONTROLS_NOTE =
  "This session is shared view-only; controls need a control-shared session.";
export const MAX_COMPACT_INSTRUCTIONS = 4000;
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export interface ModelRef {
  provider: string;
  id: string;
  name: string;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface SessionInfo {
  cwd: string;
  pid: number;
  sessionName: string | null;
  access: "view" | "control";
  idle: boolean;
  model: ModelRef | null;
  thinkingLevel: string | null;
  thinkingLevels: string[];
  contextUsage: ContextUsage | null;
  models: ModelRef[];
}

export interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  target?: "file" | "dir";
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
}

/** A failed hub request; `status` is 0 when the hub could not be reached. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function errorMessage(body: unknown, status: number): string {
  if (
    body &&
    typeof body === "object" &&
    typeof (body as { error?: unknown }).error === "string"
  )
    return (body as { error: string }).error;
  return status === 0 ? "Hub unreachable" : `Request failed (${status})`;
}

export async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError(errorMessage(null, 0), 0);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(errorMessage(body, response.status), response.status);
  return body as T;
}

export function postJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function sessionApiBase(hostId: string, instanceId: string): string {
  return `/api/hosts/${encodeURIComponent(hostId)}/sessions/${encodeURIComponent(instanceId)}`;
}

export function supportsSessionV1(session: { features?: string[] }): boolean {
  return session.features?.includes(SESSION_FEATURE) ?? false;
}

export interface RequestTicket {
  readonly seq: number;
  readonly key: string;
}

/**
 * Orders overlapping reads of one view. Every request takes a ticket; a
 * response is applied only if it belongs to the view's current key and no
 * newer ticket's response has been applied yet, so a slow older response can
 * never overwrite a newer one. An older response that arrives first is still
 * applied, which keeps a view fresh even when every request outlives the
 * polling interval.
 */
export class LatestResponseGate {
  #issued = 0;
  #applied = 0;

  begin(key: string): RequestTicket {
    this.#issued += 1;
    return { seq: this.#issued, key };
  }

  accept(ticket: RequestTicket, currentKey: string | null): boolean {
    if (ticket.key !== currentKey || ticket.seq <= this.#applied) return false;
    this.#applied = ticket.seq;
    return true;
  }

  /** Discards every response to a ticket issued before this call. */
  invalidate(): void {
    this.#applied = this.#issued;
  }
}

export interface ModelGroup {
  provider: string;
  models: ModelRef[];
}

/**
 * Models grouped by provider (providers sorted, models in listed order). The
 * current model is included even when it is missing from `models`, so the
 * selector always shows what the session is really using.
 */
export function groupModels(
  models: ModelRef[],
  current: ModelRef | null,
): ModelGroup[] {
  const all =
    current &&
    !models.some(
      (model) => model.provider === current.provider && model.id === current.id,
    )
      ? [current, ...models]
      : models;
  const groups = new Map<string, ModelRef[]>();
  for (const model of all) {
    const group = groups.get(model.provider);
    if (group) group.push(model);
    else groups.set(model.provider, [model]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, entries]) => ({ provider, models: entries }));
}

/** A `<select>` value naming a model; model ids may themselves contain `/`. */
export function modelValue(model: Pick<ModelRef, "provider" | "id">): string {
  return JSON.stringify([model.provider, model.id]);
}

export function parseModelValue(
  value: string,
): { provider: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    )
      return { provider: parsed[0], id: parsed[1] };
  } catch {
    // not a model value
  }
  return null;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  const [scaled, unit] =
    count < 999_500 ? [count / 1000, "k"] : [count / 1_000_000, "M"];
  const text = scaled < 10 ? scaled.toFixed(1) : String(Math.round(scaled));
  return `${text.replace(/\.0$/, "")}${unit}`;
}

/** Bar fill (0-100, or null when unknown) and a label for context usage. */
export function contextSummary(usage: ContextUsage | null): {
  percent: number | null;
  text: string;
} {
  if (!usage) return { percent: null, text: "Unknown" };
  const { tokens, contextWindow } = usage;
  const raw =
    usage.percent ??
    (tokens !== null && contextWindow ? (tokens / contextWindow) * 100 : null);
  const percent = raw === null ? null : Math.min(100, Math.max(0, raw));
  if (tokens === null && contextWindow === null)
    return {
      percent,
      text: percent === null ? "Unknown" : `${Math.round(percent)}%`,
    };
  const used = tokens === null ? "?" : formatTokens(tokens);
  const window = contextWindow === null ? "?" : formatTokens(contextWindow);
  const suffix = percent === null ? "" : ` (${Math.round(percent)}%)`;
  return { percent, text: `${used} / ${window} tokens${suffix}` };
}
