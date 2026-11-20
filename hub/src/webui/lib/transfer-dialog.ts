// The Send to host dialog: destination picker, plan view with the project
// conflict box, and progress with recovery. All state logic (step machine,
// button enabling, label text, recovery mapping, handoff matching) is in
// pure functions exported for tests; `TransferDialog` only builds DOM and
// runs requests. Closing the dialog never cancels the worker: progress
// tracking continues in the background and the dialog reopens on a failure.

import { button, el } from "./dom";
import {
  type PlanRequest,
  TRANSFER_ABANDON_AFTER_MS,
  TRANSFER_FEATURE,
  type TransferApi,
  type TransferApiError,
  type TransferDestination,
  type TransferErrorKind,
  type TransferPlanView,
  type TransferProjectMode,
  type TransferRecoverAction,
  type TransferState,
  type TransferView,
  createTransferApi,
} from "./transfer-api";
import {
  type CollabSession,
  type StorageLike,
  type WorkspaceGroup,
  groupMemberKey,
  sessionLabel,
} from "./workspace";

// ---------------------------------------------------------------------------
// Menu item
// ---------------------------------------------------------------------------

export const MENU_LABEL = "Send to host";
export const REASON_NOT_CONTROL =
  "Send to host needs control access to this session.";
export const REASON_UNSUPPORTED =
  "This session cannot be sent: transfer is not enabled for it. Enable it in the transfer configuration and restart the session.";
export const REASON_BUSY =
  "The agent is busy. Wait until it is idle, then send the session.";

export interface MenuState {
  disabled: boolean;
  /** Why the item is disabled; empty when it is enabled. */
  reason: string;
}

/** Whether the context menu item is usable, and the reason when it is not. */
export function sendToHostMenuState(
  session: Pick<CollabSession, "access" | "features">,
  agentBusy: boolean,
): MenuState {
  if (session.access !== "control")
    return { disabled: true, reason: REASON_NOT_CONTROL };
  if (!session.features?.includes(TRANSFER_FEATURE))
    return { disabled: true, reason: REASON_UNSUPPORTED };
  if (agentBusy) return { disabled: true, reason: REASON_BUSY };
  return { disabled: false, reason: "" };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function plural(
  count: number,
  singular: string,
  many = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : many}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// ---------------------------------------------------------------------------
// Project conflict box
// ---------------------------------------------------------------------------

export const CONFLICT_CHOICES = ["update", "session-only", "cancel"] as const;
export type ConflictChoice = (typeof CONFLICT_CHOICES)[number];
export const DEFAULT_CONFLICT_CHOICE: ConflictChoice = "session-only";
export const CONFLICT_LABELS: Record<ConflictChoice, string> = {
  update: "Update project with rsync",
  "session-only": "Leave project untouched; transfer session only",
  cancel: "Cancel",
};
export const CONFLICT_HINTS: Record<ConflictChoice, string> = {
  update:
    "Adds and replaces files on the destination; files only present there are kept. Review the change preview before confirming.",
  "session-only":
    "Code and dependencies on the destination stay unchanged. The destination project directory must be usable for the session.",
  cancel: "Nothing is changed on either host.",
};

/** The project mode a choice commits, or null when it commits nothing. */
export function modeForChoice(
  destinationExists: boolean,
  choice: ConflictChoice,
): TransferProjectMode | null {
  if (!destinationExists) return "create";
  if (choice === "update") return "update";
  if (choice === "session-only") return "session-only";
  return null;
}

// ---------------------------------------------------------------------------
// Step machine
// ---------------------------------------------------------------------------

export type DialogStep =
  | "destination"
  | "planning"
  | "plan"
  | "committing"
  | "progress";

export interface PendingPlan {
  seq: number;
  projectMode?: TransferProjectMode;
}

export interface DialogState {
  step: DialogStep;
  /** Null until the destinations request settles. */
  destinations: TransferDestination[] | null;
  enabled: boolean;
  destination: string | null;
  plan: TransferPlanView | null;
  choice: ConflictChoice;
  acceptIncomplete: boolean;
  /** A plan request that has not been answered; `seq` rejects stale answers. */
  pendingPlan: PendingPlan | null;
  planSeq: number;
  error: string | null;
  operationId: string | null;
}

export function initialDialogState(): DialogState {
  return {
    step: "destination",
    destinations: null,
    enabled: false,
    destination: null,
    plan: null,
    choice: DEFAULT_CONFLICT_CHOICE,
    acceptIncomplete: false,
    pendingPlan: null,
    planSeq: 0,
    error: null,
    operationId: null,
  };
}

export type DialogEvent =
  | {
      type: "destinations-loaded";
      enabled: boolean;
      destinations: TransferDestination[];
    }
  | { type: "destinations-failed"; message: string }
  | { type: "select-destination"; name: string }
  | {
      type: "plan-loaded";
      seq: number;
      plan: TransferPlanView;
      requested?: TransferProjectMode;
    }
  | { type: "plan-failed"; seq: number; message: string }
  | { type: "choose"; choice: ConflictChoice }
  | { type: "replan" }
  | { type: "set-accept-incomplete"; value: boolean }
  | { type: "commit-requested"; agentBusy: boolean }
  | { type: "commit-accepted"; operationId: string }
  | { type: "commit-failed"; message: string }
  | { type: "attach"; operationId: string }
  | { type: "back" };

/** What the plan view must be in for the current choice, or null. */
function wantedMode(state: DialogState): TransferProjectMode | null {
  return state.plan
    ? modeForChoice(state.plan.destinationExists, state.choice)
    : null;
}

/** Ask for a plan in `projectMode`; any older request becomes stale. */
function requestPlan(
  state: DialogState,
  projectMode?: TransferProjectMode,
): DialogState {
  const seq = state.planSeq + 1;
  return {
    ...state,
    planSeq: seq,
    pendingPlan: { seq, ...(projectMode ? { projectMode } : {}) },
  };
}

/** Changes in what an incomplete archive lacks invalidate a prior acceptance. */
export function incompleteSignature(plan: TransferPlanView): string {
  return JSON.stringify([
    plan.missingBlobs,
    plan.externalReferences,
    plan.skippedSymlinks,
  ]);
}

export function reduceDialog(
  state: DialogState,
  event: DialogEvent,
): DialogState {
  switch (event.type) {
    case "destinations-loaded":
      return {
        ...state,
        destinations: event.destinations,
        enabled: event.enabled,
        error: null,
      };
    case "destinations-failed":
      return { ...state, destinations: null, error: event.message };
    case "select-destination": {
      if (state.step !== "destination") return state;
      if (!state.destinations?.some((d) => d.name === event.name)) return state;
      return requestPlan({
        ...state,
        step: "planning",
        destination: event.name,
        plan: null,
        choice: DEFAULT_CONFLICT_CHOICE,
        acceptIncomplete: false,
        error: null,
      });
    }
    case "plan-loaded": {
      if (event.seq !== state.planSeq || !state.pendingPlan) return state;
      const plan = event.plan;
      const keepAccept =
        state.plan !== null &&
        incompleteSignature(state.plan) === incompleteSignature(plan);
      const next: DialogState = {
        ...state,
        step: "plan",
        plan,
        pendingPlan: null,
        acceptIncomplete: keepAccept && state.acceptIncomplete,
        error:
          event.requested && plan.mode !== event.requested
            ? `The host planned "${plan.mode}" instead of "${event.requested}". Plan again.`
            : null,
      };
      // The first answer carries the host's own default mode; align it with
      // the selected choice before the user can confirm.
      const wanted = wantedMode(next);
      return event.requested === undefined && wanted && plan.mode !== wanted
        ? requestPlan(next, wanted)
        : next;
    }
    case "plan-failed": {
      if (event.seq !== state.planSeq || !state.pendingPlan) return state;
      if (!state.plan)
        return {
          ...state,
          step: "destination",
          destination: null,
          pendingPlan: null,
          error: event.message,
        };
      // A failed preview falls back to the choice the shown plan matches.
      return {
        ...state,
        step: "plan",
        pendingPlan: null,
        choice: state.plan.mode === "update" ? "update" : "session-only",
        error: event.message,
      };
    }
    case "choose": {
      if (state.step !== "plan" || !state.plan) return state;
      const next = { ...state, choice: event.choice, error: null };
      const wanted = wantedMode(next);
      if (!wanted || wanted === state.plan.mode)
        // The shown plan already fits; drop any request for another mode.
        return state.pendingPlan
          ? { ...next, pendingPlan: null, planSeq: state.planSeq + 1 }
          : next;
      return requestPlan(next, wanted);
    }
    case "replan": {
      if (state.step !== "plan" || !state.plan) return state;
      return requestPlan(
        { ...state, error: null },
        wantedMode(state) ?? undefined,
      );
    }
    case "set-accept-incomplete":
      return { ...state, acceptIncomplete: event.value };
    case "commit-requested":
      if (
        state.step !== "plan" ||
        commitBlockers(state, event.agentBusy).length > 0
      )
        return state;
      return { ...state, step: "committing", error: null };
    case "commit-accepted":
      return { ...state, step: "progress", operationId: event.operationId };
    case "commit-failed":
      return state.step === "committing"
        ? { ...state, step: "plan", error: event.message }
        : state;
    case "attach":
      return {
        ...state,
        step: "progress",
        operationId: event.operationId,
        error: null,
      };
    case "back":
      if (state.step !== "plan" && state.step !== "planning") return state;
      return {
        ...state,
        step: "destination",
        destination: null,
        plan: null,
        pendingPlan: null,
        planSeq: state.planSeq + 1,
        choice: DEFAULT_CONFLICT_CHOICE,
        acceptIncomplete: false,
        error: null,
      };
  }
}

/** What an archive lacks; each entry needs the explicit incomplete acceptance. */
export function incompleteReasons(plan: TransferPlanView): string[] {
  const reasons: string[] = [];
  if (plan.missingBlobs.length > 0)
    reasons.push(
      `${plural(plan.missingBlobs.length, "referenced asset")} missing`,
    );
  if (plan.externalReferences.length > 0)
    reasons.push(
      `${plural(plan.externalReferences.length, "reference")} to history or paths outside the archive`,
    );
  if (plan.skippedSymlinks.length > 0)
    reasons.push(
      `${plural(plan.skippedSymlinks.length, "artifact symlink")} skipped`,
    );
  return reasons;
}

export function requiresIncompleteAcceptance(plan: TransferPlanView): boolean {
  return incompleteReasons(plan).length > 0;
}

/** Why the plan cannot be committed yet; empty when it can. */
export function commitBlockers(
  state: DialogState,
  agentBusy: boolean,
): string[] {
  const { plan } = state;
  if (!plan) return ["No plan yet."];
  const reasons: string[] = [];
  if (agentBusy) reasons.push(REASON_BUSY);
  if (state.pendingPlan) reasons.push("Loading the project preview.");
  const mode = modeForChoice(plan.destinationExists, state.choice);
  if (mode === null) reasons.push("Cancel is selected.");
  else if (!state.pendingPlan && plan.mode !== mode)
    reasons.push("The preview does not match the selected project option.");
  if (plan.project.conflicts.length > 0)
    reasons.push(
      `${plural(plan.project.conflicts.length, "project conflict")} must be resolved on the destination, then plan again.`,
    );
  reasons.push(...plan.blockers);
  if (requiresIncompleteAcceptance(plan) && !state.acceptIncomplete)
    reasons.push("Accept the incomplete archive to continue.");
  return reasons;
}

export interface PrimaryAction {
  kind: "none" | "close" | "commit";
  label: string;
  disabled: boolean;
  reasons: string[];
}

/** The plan step's main button: send, or close when Cancel is chosen. */
export function primaryAction(
  state: DialogState,
  agentBusy: boolean,
): PrimaryAction {
  const { plan } = state;
  if (state.step !== "plan" || !plan)
    return { kind: "none", label: "", disabled: true, reasons: [] };
  const destination = state.destination ?? "destination";
  if (plan.destinationExists && state.choice === "cancel")
    return { kind: "close", label: "Cancel", disabled: false, reasons: [] };
  const mode = modeForChoice(plan.destinationExists, state.choice);
  const label =
    mode === "update"
      ? `Update project and send to ${destination}`
      : mode === "session-only"
        ? `Send session only to ${destination}`
        : `Send to ${destination}`;
  const reasons = commitBlockers(state, agentBusy);
  return { kind: "commit", label, disabled: reasons.length > 0, reasons };
}

/** The plan request the dialog must send next, or null. */
export function pendingPlanRequest(state: DialogState): PlanRequest | null {
  if (!state.pendingPlan || !state.destination) return null;
  return {
    destination: state.destination,
    ...(state.pendingPlan.projectMode
      ? { projectMode: state.pendingPlan.projectMode }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Plan view text
// ---------------------------------------------------------------------------

/** Label and value rows for the plan summary; empty values are left out. */
export function planFacts(
  plan: TransferPlanView,
  destination: TransferDestination | undefined,
): [string, string][] {
  const rows: [string, string | null][] = [
    ["Title", plan.title],
    ["Session ID", plan.sessionId],
    ["Launcher name", plan.launcherName],
    [
      "Destination host",
      destination ? `${destination.name} (${destination.hostId})` : "",
    ],
    ["Source project", plan.sourceProject],
    ["Destination project", plan.destinationProject],
    ["Nested histories", plan.children === null ? "" : String(plan.children)],
    [
      "Session size",
      plan.archiveBytes === null ? "" : formatBytes(plan.archiveBytes),
    ],
    [
      "Destination runtime",
      plan.runtimeVersion
        ? `${plan.runtimeVersion}${plan.runtimeCompatible === false ? " (incompatible)" : ""}`
        : "",
    ],
    [
      "Git state",
      plan.gitDirty === null
        ? ""
        : plan.gitDirty
          ? "Uncommitted changes on the destination project"
          : "Clean",
    ],
  ];
  return rows.filter((row): row is [string, string] => !!row[1]);
}

/** One line for the update preview. */
export function changePreviewSummary(plan: TransferPlanView): string {
  const p = plan.project;
  return [
    `${plural(p.adds, "addition")}`,
    `${plural(p.replacements, "replacement")}`,
    `${plural(p.modeChanges, "mode change")}`,
    `${plural(p.destinationOnly, "destination-only entry", "destination-only entries")} kept`,
    `${formatBytes(p.totalBytes)} to copy`,
  ].join(", ");
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export const STATE_LABELS: Record<TransferState, string> = {
  prepared: "Prepared",
  "source-stopping": "Stopping the source session",
  "source-stopped": "Source session stopped",
  staged: "Session and project staged on the destination",
  publishing: "Publishing on the destination",
  "source-departed": "Source marked as departed",
  "destination-starting": "Starting the destination session",
  completed: "Completed",
  aborting: "Stopping the transfer",
  "rolled-back": "Rolled back",
};

const PATH_STATES: TransferState[] = [
  "prepared",
  "source-stopping",
  "source-stopped",
  "staged",
  "publishing",
  "source-departed",
  "destination-starting",
  "completed",
];
const BEFORE_PUBLISH: TransferState[] = [
  "prepared",
  "source-stopping",
  "source-stopped",
  "staged",
];

export function isSettled(transfer: TransferView): boolean {
  return (
    transfer.finished ||
    transfer.state === "completed" ||
    transfer.state === "rolled-back"
  );
}

export function isActive(transfer: TransferView): boolean {
  return !isSettled(transfer);
}

/** False for a snapshot older than the one already held. */
export function isNewer(
  held: TransferView | undefined,
  next: TransferView,
): boolean {
  return !held || next.updatedAt >= held.updatedAt;
}

export interface TimelineStep {
  state: TransferState;
  label: string;
  status: "done" | "current" | "failed" | "pending" | "skipped";
  at?: string;
}

/** The state timeline: the success path, plus the abort branch once taken. */
export function transferTimeline(transfer: TransferView): TimelineStep[] {
  const reached = new Map<TransferState, string>();
  for (const entry of transfer.history)
    if (!reached.has(entry.state)) reached.set(entry.state, entry.at);
  const current = transfer.state;
  const aborted = current === "aborting" || current === "rolled-back";
  const failed = transfer.error !== undefined;
  const currentIndex = PATH_STATES.indexOf(current);
  const status = (
    state: TransferState,
    index: number,
  ): TimelineStep["status"] => {
    if (state === current) {
      if (failed) return "failed";
      return isSettled(transfer) ? "done" : "current";
    }
    if (reached.has(state) || (!aborted && index < currentIndex)) return "done";
    return aborted ? "skipped" : "pending";
  };
  const states: TransferState[] = aborted
    ? [...PATH_STATES, "aborting", "rolled-back"]
    : PATH_STATES;
  return states.map((state, index) => {
    const at = reached.get(state);
    return {
      state,
      label: STATE_LABELS[state],
      status: status(state, index),
      ...(at ? { at } : {}),
    };
  });
}

export function downtimeText(ms: number): string {
  return `Source session unavailable for ${formatDuration(ms)}`;
}

/** How long the source session has been (or was) unavailable. */
export function sourceDowntimeMs(
  transfer: TransferView,
  now: number,
): number | null {
  const start = transfer.history.find((e) => e.state === "source-stopping")?.at;
  if (!start) return null;
  const endState = transfer.history.find(
    (e) => e.state === "completed" || e.state === "rolled-back",
  );
  const end = endState ? Date.parse(endState.at) : now;
  const from = Date.parse(start);
  return Number.isFinite(from) && Number.isFinite(end)
    ? Math.max(0, end - from)
    : null;
}

const DOWNTIME_STATES: TransferState[] = [
  "source-stopping",
  "source-stopped",
  "staged",
  "publishing",
  "source-departed",
  "destination-starting",
];

export function downtimeNotice(transfer: TransferView): string | null {
  if (!DOWNTIME_STATES.includes(transfer.state)) return null;
  if (transfer.error)
    return "The source session is stopped. Choose a recovery action below; nothing restarts automatically.";
  return "The source session is stopped or stopping and stays unavailable until the destination session starts. Closing this window does not stop the transfer.";
}

export interface RecoverOption {
  action: TransferRecoverAction;
  label: string;
  description: string;
  /** A request for this action waits for the worker. */
  pending: boolean;
}

const RECOVER_TEXT: Record<
  TransferRecoverAction,
  { label: string; description: string }
> = {
  resume: {
    label: "Resume transfer",
    description: "Continues the transfer from the last confirmed step.",
  },
  "retry-launch": {
    label: "Retry launch",
    description:
      "Starts the destination session again from the imported data. The worker checks that no destination session owns it first.",
  },
  "rollback-source": {
    label: "Roll back source",
    description:
      "Cancels the pending destination launch, then lets the source session resume. Refused when the destination already started.",
  },
  "restore-project": {
    label: "Restore project",
    description:
      "Undoes the project update on the destination. Files edited since the update are reported and left alone.",
  },
  cleanup: {
    label: "Clean up",
    description:
      "Removes staging data on both hosts. Project backups are kept.",
  },
};

/** Recovery buttons for an operation, mapped to the hub's recover actions. */
export function recoverOptions(transfer: TransferView): RecoverOption[] {
  const actions: TransferRecoverAction[] = [];
  const { state } = transfer;
  if (transfer.error && !isSettled(transfer)) {
    if (BEFORE_PUBLISH.includes(state))
      actions.push("resume", "rollback-source", "cleanup");
    else if (state === "publishing") {
      actions.push("resume");
      if (transfer.projectMode === "update") actions.push("restore-project");
      actions.push("rollback-source", "cleanup");
    } else if (state === "source-departed" || state === "destination-starting")
      actions.push("retry-launch", "rollback-source");
    else if (state === "aborting") actions.push("rollback-source", "cleanup");
  } else if (!transfer.finished) {
    if (state === "rolled-back") {
      if (transfer.projectMode === "update") actions.push("restore-project");
      actions.push("cleanup");
    } else if (state === "completed") actions.push("cleanup");
  }
  return actions.map((action) => ({
    action,
    ...RECOVER_TEXT[action],
    pending: transfer.commands.some(
      (command) =>
        command.type === "recover" &&
        command.ackedAt === undefined &&
        command.payload.action === action,
    ),
  }));
}

export interface CancelInfo {
  available: boolean;
  label: string;
  explanation: string;
  pending: boolean;
}

/** The Cancel button and what it does at the operation's current boundary. */
export function cancelInfo(transfer: TransferView): CancelInfo {
  const pending = transfer.commands.some(
    (command) => command.type === "cancel" && command.ackedAt === undefined,
  );
  const { state } = transfer;
  if (isSettled(transfer))
    return { available: false, label: "Cancel", explanation: "", pending };
  if (state === "aborting")
    return {
      available: false,
      label: "Cancel",
      explanation: "The transfer is already stopping.",
      pending,
    };
  if (BEFORE_PUBLISH.includes(state))
    return {
      available: true,
      label: "Cancel transfer",
      explanation:
        "Nothing is published yet. Cancelling removes staged data and the source session can then be recovered; the project and session data on the destination stay unchanged.",
      pending,
    };
  if (state === "publishing")
    return {
      available: true,
      label: "Request safe stop",
      explanation:
        "Publishing is under way. The worker stops at the next recorded boundary and does not roll back by itself; use the recovery actions afterwards.",
      pending,
    };
  return {
    available: true,
    label: "Request safe stop",
    explanation:
      "The destination session is, or is about to be, running. Cancelling does not undo that. To return the session, send it back with a new transfer.",
    pending,
  };
}

/** The operation's progress detail line, from the worker's free-form report. */
export function progressDetail(transfer: TransferView): {
  message: string;
  done: number | null;
  total: number | null;
} {
  const p = transfer.progress ?? {};
  const number = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  return {
    message: typeof p.message === "string" ? p.message : "",
    done: number(p.bytesDone),
    total: number(p.bytesTotal),
  };
}

/** Poll interval after `failures` consecutive failed polls. */
export function nextPollDelay(failures: number): number {
  return Math.min(2000 * 2 ** Math.max(0, failures), 15_000);
}

// ---------------------------------------------------------------------------
// Handoff: selecting the destination session and keeping the group
// ---------------------------------------------------------------------------

export interface Handoff {
  transferId: string;
  sessionId: string;
  sourceHost: string;
  sourceInstance: string;
  /** The source session's `groupMemberKey`. */
  memberKey: string;
  /** Dashboard host id of the destination; empty when unknown. */
  destinationHostId: string;
  createdAt: number;
}

export const HANDOFF_STORAGE_KEY = "omp-hub-transfer-handoffs/v1";
const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

function isHandoff(value: unknown): value is Handoff {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.transferId === "string" &&
    typeof h.sessionId === "string" &&
    typeof h.sourceHost === "string" &&
    typeof h.sourceInstance === "string" &&
    typeof h.memberKey === "string" &&
    typeof h.destinationHostId === "string" &&
    typeof h.createdAt === "number"
  );
}

export function readHandoffs(
  storage: StorageLike,
  now = Date.now(),
): Handoff[] {
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(HANDOFF_STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Handoff =>
            isHandoff(item) && now - item.createdAt < HANDOFF_TTL_MS,
        )
      : [];
  } catch {
    return [];
  }
}

function saveHandoffs(storage: StorageLike, handoffs: Handoff[]): void {
  try {
    storage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(handoffs));
  } catch {
    // storage full or unavailable; the handoff then only lasts for this page
  }
}

export function writeHandoff(storage: StorageLike, handoff: Handoff): void {
  saveHandoffs(storage, [
    ...readHandoffs(storage).filter((h) => h.transferId !== handoff.transferId),
    handoff,
  ]);
}

export function dropHandoff(storage: StorageLike, transferId: string): void {
  saveHandoffs(
    storage,
    readHandoffs(storage).filter((h) => h.transferId !== transferId),
  );
}

/** The registered destination session, or undefined while it is not listed. */
export function findDestinationSession(
  sessions: CollabSession[],
  handoff: Pick<
    Handoff,
    "sessionId" | "sourceHost" | "sourceInstance" | "destinationHostId"
  >,
): CollabSession | undefined {
  return sessions
    .filter(
      (session) =>
        session.sessionId === handoff.sessionId &&
        !(
          session.host_id === handoff.sourceHost &&
          session.instanceId === handoff.sourceInstance
        ) &&
        (!handoff.destinationHostId ||
          session.host_id === handoff.destinationHostId),
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

/** Select the destination only when the user is still on the source session. */
export function shouldSelectDestination(
  selected: CollabSession | null,
  handoff: Pick<Handoff, "sourceHost" | "sourceInstance">,
): boolean {
  return (
    selected === null ||
    (selected.host_id === handoff.sourceHost &&
      selected.instanceId === handoff.sourceInstance)
  );
}

/** The custom group to move the destination into, or null. */
export function groupReassignment(
  groups: WorkspaceGroup[],
  oldKey: string,
  newKey: string,
): string | null {
  const group = groups.find((g) => g.sessions.includes(oldKey));
  return group && !group.sessions.includes(newKey) ? group.id : null;
}

/** The latest unsettled operation for a session, or undefined. */
export function findActiveTransfer(
  transfers: TransferView[],
  ref: { host: string; instance: string; sessionId?: string },
): TransferView | undefined {
  return transfers
    .filter(
      (t) =>
        isActive(t) &&
        ((t.host === ref.host && t.instance === ref.instance) ||
          (ref.sessionId !== undefined && t.sessionId === ref.sessionId)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

// ---------------------------------------------------------------------------
// Commit in flight and silent workers
// ---------------------------------------------------------------------------

const PENDING_PREFIX = "pending:";
const PENDING_HANDOFF_TTL_MS = 10 * 60 * 1000;
const PENDING_MATCH_SLACK_MS = 60_000;

/** The handoff id used before a commit answers and the operation id is known. */
export function pendingHandoffId(host: string, instance: string): string {
  return `${PENDING_PREFIX}${host}:${instance}`;
}

export function isPendingHandoff(
  handoff: Pick<Handoff, "transferId">,
): boolean {
  return handoff.transferId.startsWith(PENDING_PREFIX);
}

export type PendingResolution =
  | { action: "promote"; transfer: TransferView }
  | { action: "keep" }
  | { action: "drop" };

/**
 * What to do with a handoff stored before its commit answered: adopt the
 * newest operation of that session created since, keep waiting, or give up
 * once it is too old to be an operation still being created.
 */
export function resolvePendingHandoff(
  handoff: Handoff,
  transfers: TransferView[],
  now: number,
): PendingResolution {
  const since = handoff.createdAt - PENDING_MATCH_SLACK_MS;
  const match = transfers
    .filter(
      (t) =>
        t.host === handoff.sourceHost &&
        t.instance === handoff.sourceInstance &&
        Date.parse(t.createdAt) >= since,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (match) return { action: "promote", transfer: match };
  return now - handoff.createdAt > PENDING_HANDOFF_TTL_MS
    ? { action: "drop" }
    : { action: "keep" };
}

/** Re-keys a pending handoff to the operation id it turned out to have. */
export function promoteHandoff(
  storage: StorageLike,
  pendingId: string,
  transferId: string,
): void {
  const all = readHandoffs(storage);
  const pending = all.find((h) => h.transferId === pendingId);
  if (!pending) return;
  saveHandoffs(storage, [
    ...all.filter(
      (h) => h.transferId !== pendingId && h.transferId !== transferId,
    ),
    { ...pending, transferId },
  ]);
}

/** Failures after which the hub may still have created the operation. */
export function commitOutcomeUnknown(kind: TransferErrorKind): boolean {
  return kind === "unreachable" || kind === "timeout" || kind === "server";
}

export const ABANDON_EXPLANATION =
  "The hub stops tracking this operation. The source session may need `ompc-send recover` on the source host.";
export const ABANDON_CONFIRM = `Abandon this transfer?\n\n${ABANDON_EXPLANATION}`;

export interface AbandonInfo {
  eligible: boolean;
  /** The worker's last report (ISO 8601). */
  since: string;
}

/**
 * Whether the hub accepts Abandon: the operation is unsettled and its
 * worker never reported in or has been silent for the hub's limit.
 */
export function abandonInfo(transfer: TransferView, now: number): AbandonInfo {
  const since = transfer.updatedAt;
  if (isSettled(transfer)) return { eligible: false, since };
  const silent = now - Date.parse(since);
  return {
    eligible:
      !transfer.workerStarted ||
      (Number.isFinite(silent) && silent >= TRANSFER_ABANDON_AFTER_MS),
    since,
  };
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

export interface TransferDialogHooks {
  showStatus(message: string, kind?: string): void;
  isBusy(session: CollabSession): boolean;
  storage: StorageLike;
  /** An operation completed; the host applies its handoff once the session lists. */
  onCompleted(transfer: TransferView): void;
}

function listLines(items: string[], limit = 10): HTMLElement {
  const list = el("ul", { className: "transfer-list" });
  for (const item of items.slice(0, limit))
    list.append(el("li", { text: item }));
  if (items.length > limit)
    list.append(el("li", { text: `and ${items.length - limit} more` }));
  return list;
}

function notice(kind: "error" | "warning" | "info", text: string): HTMLElement {
  const node = el("p", { className: `transfer-note ${kind}`, text });
  if (kind === "error") node.setAttribute("role", "alert");
  return node;
}

export class TransferDialog {
  readonly #dialog = el("dialog", {
    className: "session-launcher transfer-dialog",
  }) as HTMLDialogElement;
  readonly #title = el("h2");
  readonly #body = el("div", { className: "transfer-body" });
  readonly #footer = el("div", {
    className: "session-launch-actions transfer-actions",
  });
  readonly #api: TransferApi;
  #state = initialDialogState();
  #session: CollabSession | null = null;
  #openRequest = 0;
  #inFlightPlan = 0;
  #actionError = "";
  #actionBusy = false;
  readonly #views = new Map<string, TransferView>();
  readonly #watch = new Set<string>();
  readonly #handled = new Set<string>();
  #shownId: string | null = null;
  #notifiedError = "";
  #pollTimer: number | undefined;
  #pollFailures = 0;
  #pollNote = "";
  #clock: number | undefined;
  #downtime: HTMLElement | null = null;
  /** Whether the last progress render offered Abandon. */
  #abandonShown = false;

  constructor(
    private readonly hooks: TransferDialogHooks,
    api: TransferApi = createTransferApi(),
  ) {
    this.#api = api;
    this.#dialog.dataset.transferDialog = "";
    this.#title.id = "transfer-dialog-title";
    this.#dialog.setAttribute("aria-labelledby", this.#title.id);
    const header = el("header", { className: "session-launch-header" });
    const close = button("Close", "small");
    close.title = "Closing this window does not stop a running transfer";
    close.onclick = () => {
      if (this.#state.step !== "committing") this.#dialog.close();
    };
    header.append(this.#title, close);
    this.#dialog.append(header, this.#body, this.#footer);
    this.#dialog.addEventListener("click", (event) => {
      if (event.target === this.#dialog && this.#state.step !== "committing")
        this.#dialog.close();
    });
    // The commit request in flight cannot be abandoned; every other step may close.
    this.#dialog.addEventListener("cancel", (event) => {
      if (this.#state.step === "committing") event.preventDefault();
    });
    this.#dialog.addEventListener("close", () => {
      this.#openRequest++;
      this.#stopClock();
    });
    document.body.append(this.#dialog);
  }

  /** Starts the flow for `session`, or shows its running operation. */
  async open(session: CollabSession): Promise<void> {
    const running = this.#runningFor(session);
    if (running) {
      this.#show(running);
      return;
    }
    const request = ++this.#openRequest;
    this.#inFlightPlan = 0;
    this.#session = session;
    this.#state = initialDialogState();
    this.#actionError = "";
    this.#shownId = null;
    this.#title.textContent = `Send ${sessionLabel(session)} to another host`;
    if (!this.#dialog.open) this.#dialog.showModal();
    this.#render();
    const [existing, destinations] = await Promise.allSettled([
      this.#api.list(),
      this.#api.destinations(session.host_id, session.instanceId),
    ]);
    if (request !== this.#openRequest) return;
    if (existing.status === "fulfilled") {
      const active = findActiveTransfer(existing.value, {
        host: session.host_id,
        instance: session.instanceId,
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      });
      if (active) {
        this.#ensureHandoff(session, active);
        this.#adopt(active);
        this.#show(active);
        return;
      }
    }
    if (destinations.status === "fulfilled")
      this.#dispatch({ type: "destinations-loaded", ...destinations.value });
    else
      this.#dispatch({
        type: "destinations-failed",
        message: (destinations.reason as Error).message,
      });
  }

  /** Re-evaluates enabling after the agent's busy state changed. */
  refresh(): void {
    if (this.#dialog.open && this.#state.step === "plan") this.#render();
  }

  /** A `transfer.changed` dashboard event. */
  onTransferChanged(transfer: TransferView): void {
    if (!this.#watch.has(transfer.id) && transfer.id !== this.#shownId) return;
    this.#apply(transfer);
    this.#schedulePoll(0);
  }

  /** Re-attaches to operations this browser started before a page load. */
  async resumeActive(): Promise<void> {
    const handoffs = readHandoffs(this.hooks.storage);
    if (handoffs.length === 0) return;
    const transfers = await this.#api.list();
    for (const handoff of handoffs) {
      let id = handoff.transferId;
      if (isPendingHandoff(handoff)) {
        // A commit that was in flight at reload: match the operation it made.
        const resolution = resolvePendingHandoff(
          handoff,
          transfers,
          Date.now(),
        );
        if (resolution.action === "drop") dropHandoff(this.hooks.storage, id);
        if (resolution.action !== "promote") continue;
        id = resolution.transfer.id;
        promoteHandoff(this.hooks.storage, handoff.transferId, id);
      }
      const transfer = transfers.find((t) => t.id === id);
      if (!transfer) continue;
      if (transfer.state === "rolled-back")
        dropHandoff(this.hooks.storage, transfer.id);
      else this.#adopt(transfer);
    }
  }

  #runningFor(session: CollabSession): TransferView | undefined {
    return [...this.#views.values()].find(
      (t) =>
        isActive(t) &&
        ((t.host === session.host_id && t.instance === session.instanceId) ||
          (!!session.sessionId && t.sessionId === session.sessionId)),
    );
  }

  #show(transfer: TransferView): void {
    this.#shownId = transfer.id;
    this.#actionError = "";
    this.#state = reduceDialog(this.#state, {
      type: "attach",
      operationId: transfer.id,
    });
    this.#title.textContent = `Sending to ${transfer.destination}`;
    if (!this.#dialog.open) this.#dialog.showModal();
    this.#render();
  }

  #adopt(transfer: TransferView): void {
    this.#watch.add(transfer.id);
    this.#apply(transfer);
    this.#schedulePoll(0);
  }

  #apply(transfer: TransferView): void {
    const held = this.#views.get(transfer.id);
    if (!isNewer(held, transfer)) return;
    const same = held && JSON.stringify(held) === JSON.stringify(transfer);
    this.#views.set(transfer.id, transfer);
    if (isSettled(transfer)) this.#watch.delete(transfer.id);
    this.#observe(transfer);
    if (!same && transfer.id === this.#shownId && this.#dialog.open)
      this.#render();
  }

  /** Completion hand-off and failure surfacing; failures reopen a closed dialog. */
  #observe(transfer: TransferView): void {
    if (transfer.state === "completed" && !this.#handled.has(transfer.id)) {
      this.#handled.add(transfer.id);
      this.hooks.showStatus(
        `Transferred ${transfer.sessionId.slice(0, 8)} to ${transfer.destination}; waiting for it to register…`,
        "ok",
      );
      this.hooks.onCompleted(transfer);
    }
    if (transfer.state === "rolled-back" && !this.#handled.has(transfer.id)) {
      this.#handled.add(transfer.id);
      dropHandoff(this.hooks.storage, transfer.id);
    }
    if (transfer.error) {
      const key = `${transfer.id}:${transfer.error.code}:${transfer.error.at}`;
      if (key === this.#notifiedError) return;
      this.#notifiedError = key;
      this.hooks.showStatus(
        `Transfer to ${transfer.destination} needs attention: ${transfer.error.message}`,
        "warning",
      );
      if (!this.#dialog.open) this.#show(transfer);
    }
  }

  #schedulePoll(delay = nextPollDelay(this.#pollFailures)): void {
    if (this.#pollTimer !== undefined || this.#watch.size === 0) return;
    this.#pollTimer = window.setTimeout(() => {
      this.#pollTimer = undefined;
      void this.#poll();
    }, delay);
  }

  /** Polls each running operation; failures (hub restart included) back off and retry. */
  async #poll(): Promise<void> {
    const ids = [...this.#watch];
    if (ids.length === 0) return;
    const results = await Promise.allSettled(
      ids.map((id) => this.#api.get(id)),
    );
    let failure = "";
    for (const result of results) {
      if (result.status === "fulfilled") this.#apply(result.value);
      else failure = (result.reason as TransferApiError).message;
    }
    this.#pollFailures = failure ? this.#pollFailures + 1 : 0;
    const note = failure ? `${failure}; retrying` : "";
    if (note !== this.#pollNote) {
      this.#pollNote = note;
      if (this.#dialog.open && this.#state.step === "progress") this.#render();
    }
    this.#schedulePoll();
  }

  #dispatch(event: DialogEvent): void {
    this.#state = reduceDialog(this.#state, event);
    this.#render();
    this.#runPendingPlan();
  }

  #runPendingPlan(): void {
    const session = this.#session;
    const request = pendingPlanRequest(this.#state);
    const pending = this.#state.pendingPlan;
    if (!session || !request || !pending || pending.seq === this.#inFlightPlan)
      return;
    this.#inFlightPlan = pending.seq;
    const seq = pending.seq;
    const flow = this.#openRequest;
    void this.#api
      .plan(session.host_id, session.instanceId, request)
      .then(
        (plan) => ({
          type: "plan-loaded" as const,
          seq,
          plan,
          ...(request.projectMode ? { requested: request.projectMode } : {}),
        }),
        (error: Error) => ({
          type: "plan-failed" as const,
          seq,
          message: error.message,
        }),
      )
      .then((event) => {
        // A closed or restarted flow drops the answer.
        if (flow === this.#openRequest) this.#dispatch(event);
      });
  }

  async #commit(): Promise<void> {
    const session = this.#session;
    const { plan, destination } = this.#state;
    if (!session || !plan || !destination) return;
    const mode = modeForChoice(plan.destinationExists, this.#state.choice);
    if (!mode) return;
    this.#dispatch({
      type: "commit-requested",
      agentBusy: this.hooks.isBusy(session),
    });
    if (this.#state.step !== "committing") return;
    const sessionId = plan.sessionId || session.sessionId || "";
    const pendingId = pendingHandoffId(session.host_id, session.instanceId);
    // Stored before the request so a reload while it is in flight can still
    // find the operation afterwards.
    writeHandoff(
      this.hooks.storage,
      this.#handoffFor(session, destination, sessionId, pendingId),
    );
    try {
      const { operationId } = await this.#api.commit(
        session.host_id,
        session.instanceId,
        {
          destination,
          planId: plan.planId,
          planDigest: plan.digest,
          projectMode: mode,
          acceptIncomplete: this.#state.acceptIncomplete,
        },
      );
      dropHandoff(this.hooks.storage, pendingId);
      writeHandoff(
        this.hooks.storage,
        this.#handoffFor(session, destination, sessionId, operationId),
      );
      this.#watch.add(operationId);
      this.#shownId = operationId;
      this.#dispatch({ type: "commit-accepted", operationId });
      this.#title.textContent = `Sending to ${destination}`;
      this.#schedulePoll(0);
    } catch (error) {
      await this.#commitFailed(session, error as TransferApiError, {
        destination,
        sessionId,
        pendingId,
      });
    }
  }

  /**
   * A commit that failed. The hub may name an operation it kept (no reply
   * from the extension): that one is tracked. A 409 that matches a running
   * operation for this session attaches to it.
   */
  async #commitFailed(
    session: CollabSession,
    error: TransferApiError,
    ctx: { destination: string; sessionId: string; pendingId: string },
  ): Promise<void> {
    const { storage } = this.hooks;
    if (error.operationId) {
      dropHandoff(storage, ctx.pendingId);
      writeHandoff(
        storage,
        this.#handoffFor(
          session,
          ctx.destination,
          ctx.sessionId,
          error.operationId,
        ),
      );
      this.hooks.showStatus(error.message, "warning");
      this.#watch.add(error.operationId);
      this.#shownId = error.operationId;
      this.#state = reduceDialog(this.#state, {
        type: "attach",
        operationId: error.operationId,
      });
      this.#title.textContent = `Sending to ${ctx.destination}`;
      this.#render();
      this.#schedulePoll(0);
      return;
    }
    if (error.kind === "duplicate") {
      try {
        const active = findActiveTransfer(await this.#api.list(), {
          host: session.host_id,
          instance: session.instanceId,
          ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        });
        if (active) {
          dropHandoff(storage, ctx.pendingId);
          this.#ensureHandoff(session, active);
          this.#adopt(active);
          this.#show(active);
          return;
        }
      } catch {
        // fall through to the plain error
      }
    }
    // Nothing started unless the outcome is unknown; then the stored handoff
    // stays so a reload can still match the operation.
    if (!commitOutcomeUnknown(error.kind)) dropHandoff(storage, ctx.pendingId);
    this.#dispatch({ type: "commit-failed", message: error.message });
  }

  #handoffFor(
    session: CollabSession,
    destination: string,
    sessionId: string,
    transferId: string,
  ): Handoff {
    return {
      transferId,
      sessionId,
      sourceHost: session.host_id,
      sourceInstance: session.instanceId,
      memberKey: groupMemberKey(session),
      destinationHostId:
        this.#state.destinations?.find((d) => d.name === destination)?.hostId ??
        "",
      createdAt: Date.now(),
    };
  }

  /** Keeps the group and selection handoff of an operation found, not started, here. */
  #ensureHandoff(session: CollabSession, transfer: TransferView): void {
    const { storage } = this.hooks;
    if (readHandoffs(storage).some((h) => h.transferId === transfer.id)) return;
    writeHandoff(
      storage,
      this.#handoffFor(
        session,
        transfer.destination,
        session.sessionId || transfer.sessionId,
        transfer.id,
      ),
    );
  }

  async #act(run: () => Promise<TransferView>): Promise<void> {
    if (this.#actionBusy) return;
    this.#actionBusy = true;
    this.#actionError = "";
    this.#render();
    try {
      const view = await run();
      this.#apply(view);
      this.#schedulePoll(0);
    } catch (error) {
      this.#actionError = (error as Error).message;
    } finally {
      this.#actionBusy = false;
      this.#render();
    }
  }

  /** Ticks the source downtime line only; a full re-render would drop focus. */
  #startClock(): void {
    if (this.#clock !== undefined) return;
    this.#clock = window.setInterval(() => {
      const view = this.#shownId ? this.#views.get(this.#shownId) : undefined;
      if (!view || !this.#dialog.open) return;
      // A silent worker sends no updates, so eligibility is re-checked here.
      if (abandonInfo(view, Date.now()).eligible !== this.#abandonShown) {
        this.#render();
        return;
      }
      const down = sourceDowntimeMs(view, Date.now());
      if (this.#downtime && down !== null && isActive(view))
        this.#downtime.textContent = downtimeText(down);
    }, 1000);
  }

  #stopClock(): void {
    clearInterval(this.#clock);
    this.#clock = undefined;
  }

  // -- rendering ------------------------------------------------------------

  #render(): void {
    const scroll = this.#body.scrollTop;
    this.#body.replaceChildren();
    this.#footer.replaceChildren();
    switch (this.#state.step) {
      case "destination":
        this.#renderDestination();
        break;
      case "planning":
        this.#renderPlanning();
        break;
      case "plan":
      case "committing":
        this.#renderPlan();
        break;
      case "progress":
        this.#renderProgress();
        break;
    }
    this.#body.scrollTop = scroll;
  }

  #renderDestination(): void {
    const { destinations, enabled, error } = this.#state;
    this.#body.append(
      el("p", {
        className: "empty",
        text: "Moves this conversation to another configured host, at the same project path relative to home. Running processes, subagents and terminals do not move.",
      }),
    );
    if (error) this.#body.append(notice("error", error));
    if (destinations === null) {
      if (error) {
        const retry = button("Retry");
        retry.onclick = () => {
          if (this.#session) void this.open(this.#session);
        };
        this.#footer.append(retry);
      } else this.#body.append(notice("info", "Loading destinations…"));
      return;
    }
    if (!enabled)
      this.#body.append(
        notice(
          "warning",
          'Send to host is off for this session. Set "enabled": true in omp-connected/transfer.json (under the XDG config directory) and restart the session.',
        ),
      );
    else if (destinations.length === 0)
      this.#body.append(
        notice(
          "warning",
          'No destinations are configured. Add named entries under "destinations" in omp-connected/transfer.json with an ssh target and allowed roots, then restart the session.',
        ),
      );
    const list = el("div", { className: "transfer-destinations" });
    list.setAttribute("role", "list");
    for (const destination of destinations) {
      const row = button("", "past-session");
      row.disabled = !enabled;
      row.append(
        el("strong", { text: destination.name }),
        el("span", { text: destination.hostId }),
      );
      row.onclick = () =>
        this.#dispatch({ type: "select-destination", name: destination.name });
      list.append(row);
    }
    this.#body.append(list);
  }

  #renderPlanning(): void {
    this.#body.append(
      notice(
        "info",
        `Inspecting ${this.#state.destination ?? "the destination"}. This compares both project trees and can take a while for large projects…`,
      ),
    );
    const back = button("Back");
    back.onclick = () => this.#dispatch({ type: "back" });
    this.#footer.append(back);
  }

  #renderPlan(): void {
    const state = this.#state;
    const { plan } = state;
    if (!plan) return;
    const session = this.#session;
    const busy = session ? this.hooks.isBusy(session) : false;
    const committing = state.step === "committing";
    const destination = state.destinations?.find(
      (d) => d.name === state.destination,
    );

    if (state.error) this.#body.append(notice("error", state.error));
    const facts = el("dl", { className: "transfer-facts" });
    for (const [label, value] of planFacts(plan, destination)) {
      facts.append(el("dt", { text: label }), el("dd", { text: value }));
    }
    this.#body.append(facts);

    for (const blocker of plan.blockers)
      this.#body.append(notice("error", blocker));
    if (plan.runtimeCompatible === false)
      this.#body.append(
        notice(
          "error",
          "The destination runtime is not compatible with this session.",
        ),
      );
    for (const warning of plan.warnings)
      this.#body.append(notice("warning", warning));
    if (plan.knownUsers.length > 0) {
      this.#body.append(
        notice("warning", "Known users of the destination project:"),
        listLines(plan.knownUsers),
      );
    }
    if (plan.project.secretFiles.length > 0)
      this.#body.append(
        notice(
          "warning",
          "These project files look like they hold secrets and travel with the project:",
        ),
        listLines(plan.project.secretFiles),
      );
    const otherWarnings = plan.project.warnings.filter(
      (w) => w.kind !== "possible-secret-file",
    );
    if (otherWarnings.length > 0)
      this.#body.append(
        notice("warning", "Project portability warnings:"),
        listLines(
          otherWarnings.map(
            (w) => `${w.kind}: ${w.path}${w.detail ? ` (${w.detail})` : ""}`,
          ),
        ),
      );
    this.#renderIncomplete(plan);
    this.#renderProject(plan);

    if (plan.project.conflicts.length > 0) {
      this.#body.append(
        notice(
          "error",
          `${plural(plan.project.conflicts.length, "project conflict")} block the transfer. Resolve them on the destination, then plan again.`,
        ),
        listLines(
          plan.project.conflicts.map(
            (c) =>
              `${c.path}: ${c.reason || `${c.sourceKind} over ${c.destinationKind}`}`,
          ),
        ),
      );
    }

    const back = button("Back");
    back.disabled = committing;
    back.onclick = () => this.#dispatch({ type: "back" });
    this.#footer.append(back);
    const again = button("Plan again");
    again.disabled = committing || state.pendingPlan !== null;
    again.onclick = () => this.#dispatch({ type: "replan" });
    this.#footer.append(again);
    const primary = primaryAction(state, busy);
    if (primary.kind !== "none") {
      const go = button(committing ? "Starting…" : primary.label);
      go.disabled = primary.disabled || committing;
      if (primary.reasons.length > 0) go.title = primary.reasons.join(" ");
      go.onclick = () => {
        if (primary.kind === "close") this.#dialog.close();
        else void this.#commit();
      };
      this.#footer.append(go);
      if (primary.disabled && primary.reasons.length > 0 && !committing)
        this.#body.append(
          el("p", {
            className: "transfer-why",
            text: primary.reasons.join(" "),
          }),
        );
    }
  }

  #renderIncomplete(plan: TransferPlanView): void {
    if (!requiresIncompleteAcceptance(plan)) return;
    const box = el("div", { className: "transfer-incomplete" });
    box.append(
      notice(
        "warning",
        `The archive is incomplete: ${incompleteReasons(plan).join("; ")}.`,
      ),
    );
    for (const [title, items] of [
      ["Missing assets", plan.missingBlobs],
      ["References outside the archive", plan.externalReferences],
      ["Skipped artifact symlinks", plan.skippedSymlinks],
    ] as const) {
      if (items.length === 0) continue;
      box.append(el("h4", { text: title }), listLines([...items]));
    }
    const label = el("label", { className: "transfer-check" });
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = this.#state.acceptIncomplete;
    check.disabled = this.#state.step === "committing";
    check.onchange = () =>
      this.#dispatch({ type: "set-accept-incomplete", value: check.checked });
    label.append(
      check,
      el("span", {
        text: "Send the incomplete archive anyway. Missing items will not exist on the destination.",
      }),
    );
    box.append(label);
    this.#body.append(box);
  }

  #renderProject(plan: TransferPlanView): void {
    const state = this.#state;
    const section = el("section", { className: "transfer-project" });
    if (!plan.destinationExists) {
      section.append(
        el("h3", { text: "Project" }),
        el("p", {
          text: `The destination project does not exist. It will be created at ${plan.destinationProject || "the destination path"} from the source project (${plural(plan.project.entries.length + plan.project.entriesOmitted, "entry", "entries")}, ${formatBytes(plan.project.totalBytes)}).`,
        }),
      );
      this.#body.append(section);
      return;
    }
    const box = el("fieldset", { className: "transfer-conflict-box" });
    box.append(
      el("legend", {
        text: `The project already exists at ${plan.destinationProject || "the destination path"}`,
      }),
    );
    const locked = state.step === "committing";
    for (const choice of CONFLICT_CHOICES) {
      const label = el("label", { className: "transfer-choice" });
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "transfer-project-choice";
      radio.value = choice;
      radio.checked = state.choice === choice;
      radio.disabled = locked;
      radio.onchange = () => this.#dispatch({ type: "choose", choice });
      const text = el("span");
      text.append(
        el("strong", { text: CONFLICT_LABELS[choice] }),
        el("small", { text: CONFLICT_HINTS[choice] }),
      );
      label.append(radio, text);
      box.append(label);
    }
    section.append(box);
    if (state.pendingPlan)
      section.append(notice("info", "Loading the project preview…"));
    else if (state.choice === "update" && plan.mode === "update")
      section.append(this.#changePreview(plan));
    this.#body.append(section);
  }

  #changePreview(plan: TransferPlanView): HTMLElement {
    const preview = el("div", { className: "transfer-preview" });
    preview.append(
      el("h3", { text: "Change preview" }),
      el("p", { text: changePreviewSummary(plan) }),
    );
    if (plan.project.entries.length > 0) {
      const details = document.createElement("details");
      details.append(
        el("summary", {
          text: `Show ${plural(plan.project.entries.length, "entry", "entries")}`,
        }),
        listLines(
          plan.project.entries.map((e) => `${e.action}: ${e.path}`),
          plan.project.entries.length,
        ),
      );
      if (plan.project.entriesOmitted > 0)
        details.append(
          el("p", {
            className: "empty",
            text: `${plan.project.entriesOmitted} more not listed`,
          }),
        );
      preview.append(details);
    }
    return preview;
  }

  #renderProgress(): void {
    const transfer = this.#shownId ? this.#views.get(this.#shownId) : undefined;
    this.#startClock();
    this.#abandonShown = false;
    if (!transfer) {
      this.#body.append(notice("info", "Starting the transfer…"));
      if (this.#pollNote) this.#body.append(notice("warning", this.#pollNote));
      return;
    }
    this.#title.textContent = `Sending to ${transfer.destination}`;
    const timeline = el("ol", { className: "transfer-timeline" });
    for (const step of transferTimeline(transfer)) {
      if (step.status === "skipped") continue;
      const item = el("li", { text: step.label });
      item.dataset.status = step.status;
      if (step.status === "current") item.setAttribute("aria-current", "step");
      if (step.at) {
        const time = el("time", {
          text: new Date(step.at).toLocaleTimeString(),
        });
        time.setAttribute("datetime", step.at);
        item.append(time);
      }
      timeline.append(item);
    }
    this.#body.append(timeline);

    const detail = progressDetail(transfer);
    if (detail.message) this.#body.append(el("p", { text: detail.message }));
    if (detail.done !== null && detail.total) {
      const bar = document.createElement("progress");
      bar.max = detail.total;
      bar.value = Math.min(detail.done, detail.total);
      this.#body.append(bar);
    }
    const notes = downtimeNotice(transfer);
    if (notes) this.#body.append(notice("warning", notes));
    const down = sourceDowntimeMs(transfer, Date.now());
    this.#downtime = null;
    if (down !== null) {
      this.#downtime = el("p", {
        className: "empty",
        text: downtimeText(down),
      });
      this.#body.append(this.#downtime);
    }
    if (this.#pollNote) this.#body.append(notice("warning", this.#pollNote));
    if (transfer.state === "completed")
      this.#body.append(
        notice(
          "info",
          "The session continues on the destination. This dashboard selects it once it registers. The source files stay as a recovery copy.",
        ),
      );
    if (transfer.state === "rolled-back")
      this.#body.append(
        notice(
          "info",
          "The transfer was rolled back; the source session can be resumed.",
        ),
      );

    if (transfer.error) {
      this.#body.append(
        notice(
          "error",
          `${transfer.error.message} (${transfer.error.code}; last confirmed: ${STATE_LABELS[transfer.lastConfirmedState]})`,
        ),
      );
    }
    if (this.#actionError)
      this.#body.append(notice("error", this.#actionError));

    const options = recoverOptions(transfer);
    if (options.length > 0) {
      const box = el("div", { className: "transfer-recover" });
      box.append(el("h3", { text: "Recovery" }));
      for (const option of options) {
        const row = el("div", { className: "transfer-recover-row" });
        const go = button(
          option.pending ? `${option.label} (requested)` : option.label,
        );
        go.disabled = option.pending || this.#actionBusy;
        go.onclick = () => {
          if (!window.confirm(`${option.label}?\n\n${option.description}`))
            return;
          void this.#act(() => this.#api.recover(transfer.id, option.action));
        };
        row.append(go, el("small", { text: option.description }));
        box.append(row);
      }
      this.#body.append(box);
    }

    const cancel = cancelInfo(transfer);
    if (cancel.available) {
      const row = el("div", { className: "transfer-recover" });
      const go = button(cancel.pending ? "Stop requested" : cancel.label);
      go.disabled = cancel.pending || this.#actionBusy;
      go.onclick = () => {
        if (!window.confirm(`${cancel.label}?\n\n${cancel.explanation}`))
          return;
        void this.#act(() => this.#api.cancel(transfer.id));
      };
      row.append(go, el("small", { text: cancel.explanation }));
      this.#body.append(row);
    }

    const abandon = abandonInfo(transfer, Date.now());
    this.#abandonShown = abandon.eligible;
    if (abandon.eligible) {
      const row = el("div", { className: "transfer-recover" });
      row.append(
        notice(
          "warning",
          `Worker not responding since ${new Date(abandon.since).toLocaleTimeString()}`,
        ),
      );
      const go = button("Abandon");
      go.disabled = this.#actionBusy;
      go.onclick = () => {
        if (!window.confirm(ABANDON_CONFIRM)) return;
        void this.#act(() => this.#api.abandon(transfer.id));
      };
      row.append(go, el("small", { text: ABANDON_EXPLANATION }));
      this.#body.append(row);
    }
    this.#body.append(
      el("p", {
        className: "empty",
        text: "Closing this window does not stop the transfer.",
      }),
    );
  }
}
