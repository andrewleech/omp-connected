// Client for the hub's send-to-host routes. Session scoped calls
// (`destinations`, `plan`, `commit`) go to
// `/api/hosts/:host/sessions/:instance/transfer/...`; operation calls to
// `/api/transfers`. Wire types mirror hub/src/server/types.ts. `plan` and
// `preflight` are produced by the extension, so they are normalised here and
// every field the dashboard shows is optional on the wire.

import { ApiError, sessionApiBase } from "./session-api";

export const TRANSFER_FEATURE = "session.transfer.v1";
/** A worker silent this long can be abandoned (mirrors the hub's limit). */
export const TRANSFER_ABANDON_AFTER_MS = 15 * 60 * 1000;

export const TRANSFER_STATES = [
  "prepared",
  "source-stopping",
  "source-stopped",
  "staged",
  "publishing",
  "source-departed",
  "destination-starting",
  "completed",
  "aborting",
  "rolled-back",
] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];
export type TransferProjectMode = "create" | "session-only" | "update";
export const TRANSFER_RECOVER_ACTIONS = [
  "resume",
  "retry-launch",
  "rollback-source",
  "restore-project",
  "cleanup",
] as const;
export type TransferRecoverAction = (typeof TRANSFER_RECOVER_ACTIONS)[number];

export interface TransferDestination {
  name: string;
  hostId: string;
}

export interface TransferDestinations {
  enabled: boolean;
  destinations: TransferDestination[];
}

export interface TransferCommand {
  seq: number;
  type: "cancel" | "recover";
  payload: Record<string, unknown>;
  createdAt: string;
  ackedAt?: string;
}

/** One operation as the hub exposes it (no secrets). */
export interface TransferView {
  id: string;
  sessionId: string;
  host: string;
  instance: string;
  destination: string;
  state: TransferState;
  lastConfirmedState: TransferState;
  history: { state: TransferState; at: string; detail?: string }[];
  error?: { code: string; message: string; at: string };
  planDigest: string;
  projectMode: TransferProjectMode;
  progress?: Record<string, unknown>;
  workerStarted: boolean;
  createdAt: string;
  updatedAt: string;
  commands: TransferCommand[];
  finished: boolean;
}

export interface PlanRequest {
  destination: string;
  projectMode?: TransferProjectMode;
  destinationPath?: string;
}

export interface CommitRequest {
  destination: string;
  planId: string;
  planDigest: string;
  projectMode: TransferProjectMode;
  acceptIncomplete: boolean;
}

export interface ProjectWarning {
  kind: string;
  path: string;
  detail?: string;
}

export interface PlanConflict {
  path: string;
  sourceKind: string;
  destinationKind: string;
  reason: string;
}

export interface PlanEntry {
  path: string;
  action: "add" | "replace" | "mode-change";
  kind: string;
  bytes: number;
}

/** Entries kept for display; the counts always cover every entry. */
export const MAX_LISTED_ENTRIES = 200;

/** What the plan dialog shows, normalised from the extension's answer. */
export interface TransferPlanView {
  planId: string;
  digest: string;
  mode: TransferProjectMode;
  project: {
    adds: number;
    replacements: number;
    modeChanges: number;
    unchanged: number;
    destinationOnly: number;
    totalBytes: number;
    entries: PlanEntry[];
    entriesOmitted: number;
    conflicts: PlanConflict[];
    warnings: ProjectWarning[];
    secretFiles: string[];
  };
  sourceProject: string;
  destinationProject: string;
  /** True when the destination project directory already exists. */
  destinationExists: boolean;
  sessionId: string;
  title: string;
  launcherName: string;
  children: number | null;
  archiveBytes: number | null;
  missingBlobs: string[];
  externalReferences: string[];
  skippedSymlinks: string[];
  gitDirty: boolean | null;
  knownUsers: string[];
  warnings: string[];
  blockers: string[];
  runtimeVersion: string;
  runtimeCompatible: boolean | null;
}

export type TransferErrorKind =
  | "duplicate"
  | "unsupported"
  | "rate-limited"
  | "forbidden"
  | "not-found"
  | "timeout"
  | "invalid"
  | "unreachable"
  | "server";

export class TransferApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly kind: TransferErrorKind,
    /** Milliseconds the hub asked the client to wait (429). */
    readonly retryAfterMs?: number,
    readonly code?: string,
    /** The operation a failed commit left behind, when the hub names one. */
    readonly operationId?: string,
  ) {
    super(message, status);
  }
}

export function transferErrorKind(status: number): TransferErrorKind {
  switch (status) {
    case 0:
      return "unreachable";
    case 400:
      return "invalid";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "duplicate";
    case 429:
      return "rate-limited";
    case 501:
      return "unsupported";
    case 504:
      return "timeout";
    default:
      return "server";
  }
}

/** Seconds or an HTTP date, as `Retry-After` allows; undefined when absent or invalid. */
export function retryAfterMs(
  header: string | null,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** The text shown for a failed request; the hub's own message when it sent one. */
export function transferErrorMessage(
  kind: TransferErrorKind,
  hubMessage: string | undefined,
  retryMs?: number,
): string {
  switch (kind) {
    case "rate-limited": {
      const wait =
        retryMs === undefined
          ? ""
          : ` Try again in ${Math.ceil(retryMs / 1000)}s.`;
      return `Too many transfer requests.${wait}`;
    }
    case "unsupported":
      return (
        hubMessage ||
        "This session does not support Send to host. Restart it with the updated omp-connected extension."
      );
    case "duplicate":
      return (
        hubMessage || "A transfer for this session is already in progress."
      );
    case "forbidden":
      return hubMessage || "Send to host needs control access to this session.";
    case "timeout":
      return hubMessage || "The session did not answer in time. Try again.";
    case "unreachable":
      return "Hub unreachable";
    case "not-found":
      return hubMessage || "Not found. The session may have disconnected.";
    default:
      return hubMessage || "Request failed";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

const PROJECT_MODES: readonly string[] = ["create", "session-only", "update"];
const ENTRY_ACTIONS: readonly string[] = ["add", "replace", "mode-change"];

/**
 * The plan dialog's view of a `transfer.plan` answer. Throws a
 * `TransferApiError` of kind `invalid` when the answer lacks a plan id,
 * digest or project mode, since a commit cannot be bound to such a plan.
 */
export function parsePlanResult(raw: unknown): TransferPlanView {
  const result = isObject(raw) ? raw : {};
  const plan = isObject(result.plan) ? result.plan : {};
  const pre = isObject(result.preflight) ? result.preflight : {};
  const planId = str(result.planId);
  const digest = str(result.digest);
  if (!planId || !digest || !PROJECT_MODES.includes(str(plan.mode)))
    throw new TransferApiError(
      "The host returned an incomplete transfer plan",
      502,
      "invalid",
    );
  const mode = plan.mode as TransferProjectMode;
  const entries = objects(plan.entries)
    .filter(
      (entry) =>
        typeof entry.path === "string" &&
        ENTRY_ACTIONS.includes(str(entry.action)),
    )
    .map(
      (entry): PlanEntry => ({
        path: str(entry.path),
        action: entry.action as PlanEntry["action"],
        kind: str(entry.kind),
        bytes: num(entry.bytes) ?? 0,
      }),
    );
  const warnings = objects(plan.warnings).map(
    (warning): ProjectWarning => ({
      kind: str(warning.kind),
      path: str(warning.path),
      ...(typeof warning.detail === "string" ? { detail: warning.detail } : {}),
    }),
  );
  const destinationExists =
    typeof pre.destinationExists === "boolean"
      ? pre.destinationExists
      : mode !== "create";
  return {
    planId,
    digest,
    mode,
    project: {
      adds: entries.filter((entry) => entry.action === "add").length,
      replacements: entries.filter((entry) => entry.action === "replace")
        .length,
      modeChanges: entries.filter((entry) => entry.action === "mode-change")
        .length,
      unchanged: num(plan.unchanged) ?? 0,
      destinationOnly: num(plan.destinationOnly) ?? 0,
      totalBytes: num(plan.totalBytes) ?? 0,
      entries: entries.slice(0, MAX_LISTED_ENTRIES),
      entriesOmitted: Math.max(0, entries.length - MAX_LISTED_ENTRIES),
      conflicts: objects(plan.conflicts).map(
        (conflict): PlanConflict => ({
          path: str(conflict.path),
          sourceKind: str(conflict.sourceKind),
          destinationKind: str(conflict.destinationKind),
          reason: str(conflict.reason),
        }),
      ),
      warnings,
      secretFiles: warnings
        .filter((warning) => warning.kind === "possible-secret-file")
        .map((warning) => warning.path),
    },
    sourceProject: str(pre.sourceProject),
    destinationProject: str(pre.destinationProject),
    destinationExists,
    sessionId: str(pre.sessionId),
    title: str(pre.title),
    launcherName: str(pre.launcherName),
    children: num(pre.children),
    archiveBytes: num(pre.archiveBytes),
    missingBlobs: strings(pre.missingBlobs),
    externalReferences: strings(pre.externalReferences),
    skippedSymlinks: strings(pre.skippedSymlinks),
    gitDirty: typeof pre.gitDirty === "boolean" ? pre.gitDirty : null,
    knownUsers: strings(pre.knownUsers),
    warnings: strings(pre.warnings),
    blockers: strings(pre.blockers),
    runtimeVersion: str(pre.runtimeVersion),
    runtimeCompatible:
      typeof pre.runtimeCompatible === "boolean" ? pre.runtimeCompatible : null,
  };
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface TransferApi {
  destinations(host: string, instance: string): Promise<TransferDestinations>;
  plan(
    host: string,
    instance: string,
    request: PlanRequest,
  ): Promise<TransferPlanView>;
  commit(
    host: string,
    instance: string,
    request: CommitRequest,
  ): Promise<{ operationId: string }>;
  list(): Promise<TransferView[]>;
  get(id: string): Promise<TransferView>;
  cancel(id: string): Promise<TransferView>;
  recover(id: string, action: TransferRecoverAction): Promise<TransferView>;
  /** Closes an operation whose worker is gone; 409 when it is not. */
  abandon(id: string): Promise<TransferView>;
}

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * REST helpers for the transfer routes. `fetchImpl` defaults to the global
 * `fetch`, looked up per call so a test can replace it.
 */
export function createTransferApi(
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
): TransferApi {
  async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url, { cache: "no-store", ...init });
    } catch {
      throw new TransferApiError(
        transferErrorMessage("unreachable", undefined),
        0,
        "unreachable",
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const kind = transferErrorKind(response.status);
      const wait = retryAfterMs(response.headers.get("retry-after"));
      const hubMessage =
        isObject(body) && typeof body.error === "string"
          ? body.error
          : undefined;
      throw new TransferApiError(
        transferErrorMessage(kind, hubMessage, wait),
        response.status,
        kind,
        wait,
        isObject(body) && typeof body.code === "string" ? body.code : undefined,
        isObject(body) && typeof body.operationId === "string"
          ? body.operationId
          : undefined,
      );
    }
    return body as T;
  }
  const post = (url: string, body?: unknown): Promise<unknown> =>
    call(url, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
    });
  const scoped = (host: string, instance: string, route: string): string =>
    `${sessionApiBase(host, instance)}/transfer/${route}`;
  const operation = (id: string): string =>
    `/api/transfers/${encodeURIComponent(id)}`;

  return {
    async destinations(host, instance) {
      const raw = await post(scoped(host, instance, "destinations"), {});
      const body = isObject(raw) ? raw : {};
      return {
        enabled: body.enabled === true,
        destinations: objects(body.destinations)
          .filter(
            (item) => typeof item.name === "string" && item.name.length > 0,
          )
          .map((item) => ({
            name: str(item.name),
            hostId: str(item.hostId),
          })),
      };
    },
    async plan(host, instance, request) {
      return parsePlanResult(
        await post(scoped(host, instance, "plan"), {
          destination: request.destination,
          ...(request.projectMode === undefined
            ? {}
            : { projectMode: request.projectMode }),
          ...(request.destinationPath === undefined
            ? {}
            : { destinationPath: request.destinationPath }),
        }),
      );
    },
    async commit(host, instance, request) {
      const raw = await post(scoped(host, instance, "commit"), {
        destination: request.destination,
        planId: request.planId,
        planDigest: request.planDigest,
        projectMode: request.projectMode,
        acceptIncomplete: request.acceptIncomplete,
      });
      const operationId = isObject(raw) ? str(raw.operationId) : "";
      if (!operationId)
        throw new TransferApiError(
          "The hub did not return an operation id",
          502,
          "invalid",
        );
      return { operationId };
    },
    list: () => call<TransferView[]>("/api/transfers"),
    get: (id) => call<TransferView>(operation(id)),
    cancel: (id) => post(`${operation(id)}/cancel`) as Promise<TransferView>,
    recover: (id, action) =>
      post(`${operation(id)}/recover`, { action }) as Promise<TransferView>,
    abandon: (id) => post(`${operation(id)}/abandon`) as Promise<TransferView>,
  };
}
