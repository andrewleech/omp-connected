// Send-to-host operation records. The hub keeps one record per operation in
// `transfers.json` under its state dir (atomic replace; an invalid file is
// renamed aside, like the session group file), so progress and recovery
// survive a hub restart.
//
// An operation's worker authenticates with a short-lived token; a longer
// lived renewal secret obtains the next token until the worker finishes.
// Both are 32 random bytes (base64url) generated here; the store keeps only
// their SHA-256 verifiers and compares them in constant time. Nothing the
// store exposes through `view()` contains a verifier or a secret.

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  TRANSFER_ABANDON_AFTER_MS,
  TRANSFER_PROJECT_MODES,
  TRANSFER_RETENTION_MS,
  TRANSFER_STATES,
  TRANSFER_TERMINAL_STATES,
  TRANSFER_TOKEN_TTL_MS,
  type TransferCommand,
  type TransferEventPayload,
  type TransferProjectMode,
  type TransferRecord,
  type TransferState,
  type TransferView,
} from "./types";

const FILE_NAME = "transfers.json";
const FILE_VERSION = 1;
/** History entries kept per operation; the oldest are dropped. */
export const MAX_TRANSFER_HISTORY = 200;

/** A request the store refuses; `status` is the HTTP answer. */
export class TransferRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function verifierOf(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

/** Constant-time check of `secret` against a stored verifier; an empty
 *  (revoked) verifier never matches. */
export function matchesVerifier(secret: string, verifier: string): boolean {
  if (verifier === "") return false;
  const given = Buffer.from(verifierOf(secret));
  const stored = Buffer.from(verifier);
  return given.length === stored.length && timingSafeEqual(given, stored);
}

export function isTerminalState(state: TransferState): boolean {
  return TRANSFER_TERMINAL_STATES.includes(state);
}

/** An operation that can still change: neither terminal nor finished. */
function isActive(record: TransferRecord): boolean {
  return !record.finished && !isTerminalState(record.state);
}

export interface NewTransfer {
  sessionId: string;
  host: string;
  instance: string;
  destination: string;
  planDigest: string;
  projectMode: TransferProjectMode;
}

/** The secrets of a new operation; they exist only in this return value. */
export interface TransferCredentials {
  id: string;
  token: string;
  renewalSecret: string;
}

export type TokenCheck = "ok" | "invalid" | "expired";

export function transferView(record: TransferRecord): TransferView {
  const { tokenVerifier, tokenExpiresAt, renewalVerifier, ...view } =
    structuredClone(record);
  return view;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isState(value: unknown): value is TransferState {
  return TRANSFER_STATES.includes(value as TransferState);
}

function isStringField(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function parseCommand(value: unknown): value is TransferCommand {
  return (
    isObject(value) &&
    Number.isInteger(value.seq) &&
    (value.type === "cancel" || value.type === "recover") &&
    isObject(value.payload) &&
    isStringField(value, "createdAt") &&
    (value.ackedAt === undefined || typeof value.ackedAt === "string")
  );
}

function parseRecord(value: unknown): value is TransferRecord {
  if (!isObject(value)) return false;
  const strings = [
    "id",
    "sessionId",
    "host",
    "instance",
    "destination",
    "planDigest",
    "createdAt",
    "updatedAt",
    "tokenVerifier",
    "renewalVerifier",
  ];
  return (
    strings.every((key) => isStringField(value, key)) &&
    isState(value.state) &&
    isState(value.lastConfirmedState) &&
    TRANSFER_PROJECT_MODES.includes(value.projectMode as TransferProjectMode) &&
    typeof value.tokenExpiresAt === "number" &&
    typeof value.finished === "boolean" &&
    typeof value.workerStarted === "boolean" &&
    Array.isArray(value.history) &&
    value.history.every(
      (entry) =>
        isObject(entry) && isState(entry.state) && isStringField(entry, "at"),
    ) &&
    Array.isArray(value.commands) &&
    value.commands.every(parseCommand) &&
    (value.error === undefined || isObject(value.error)) &&
    (value.progress === undefined || isObject(value.progress))
  );
}

/** The state file's records, or null when it is not valid. */
function parseStateFile(value: unknown): TransferRecord[] | null {
  if (
    !isObject(value) ||
    value.version !== FILE_VERSION ||
    !Array.isArray(value.transfers)
  )
    return null;
  const ids = new Set<string>();
  for (const entry of value.transfers) {
    if (!parseRecord(entry) || ids.has(entry.id)) return null;
    ids.add(entry.id);
  }
  return value.transfers as TransferRecord[];
}

export class TransferStore {
  readonly path: string;
  private records = new Map<string, TransferRecord>();
  private listeners = new Set<(transfer: TransferView) => void>();

  constructor(
    stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(stateDir, FILE_NAME);
    for (const record of this.load())
      if (!this.expired(record)) this.records.set(record.id, record);
  }

  /** Called with the new view after every announced change. */
  onChange(listener: (transfer: TransferView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): TransferView[] {
    return [...this.records.values()].map(transferView);
  }

  view(id: string): TransferView | undefined {
    const record = this.records.get(id);
    return record && transferView(record);
  }

  /**
   * Adds an operation in state `prepared` and returns its secrets. Refuses
   * with 409 while another unfinished operation exists for the same session
   * id or the same host instance. The check and the insert run without an
   * await between them, so concurrent commits cannot both pass.
   */
  create(input: NewTransfer): TransferCredentials {
    for (const record of this.records.values()) {
      if (
        isActive(record) &&
        (record.sessionId === input.sessionId ||
          (record.host === input.host && record.instance === input.instance))
      )
        throw new TransferRequestError(
          `transfer ${record.id} is already in progress for this session`,
          409,
        );
    }
    const at = this.iso();
    const token = newSecret();
    const renewalSecret = newSecret();
    const record: TransferRecord = {
      id: randomUUID(),
      ...input,
      state: "prepared",
      lastConfirmedState: "prepared",
      history: [{ state: "prepared", at }],
      workerStarted: false,
      createdAt: at,
      updatedAt: at,
      commands: [],
      tokenVerifier: verifierOf(token),
      tokenExpiresAt: this.now() + TRANSFER_TOKEN_TTL_MS,
      renewalVerifier: verifierOf(renewalSecret),
      finished: false,
    };
    const kept = [...this.records.values()].filter((r) => !this.expired(r));
    this.persist([...kept, record]);
    this.records = new Map(kept.map((r) => [r.id, r]));
    this.records.set(record.id, record);
    return { id: record.id, token, renewalSecret };
  }

  /** Drops an operation that never started; no change event is sent. */
  remove(id: string): void {
    if (!this.records.has(id)) return;
    this.persist([...this.records.values()].filter((r) => r.id !== id));
    this.records.delete(id);
  }

  /** True once the worker reported any event for the operation. */
  workerStarted(id: string): boolean {
    return this.records.get(id)?.workerStarted ?? false;
  }

  /** Sends the current view of `id` to the change listeners. */
  announce(id: string): void {
    const view = this.view(id);
    if (view) for (const listener of this.listeners) listener(view);
  }

  /** Checks a worker token; the expiry is only reported for a correct token. */
  checkToken(id: string, token: string): TokenCheck {
    const record = this.require(id);
    if (!matchesVerifier(token, record.tokenVerifier)) return "invalid";
    return this.now() >= record.tokenExpiresAt ? "expired" : "ok";
  }

  /** True when `secret` is the renewal secret and the worker has not finished. */
  checkRenewal(id: string, secret: string): boolean {
    const record = this.require(id);
    return !record.finished && matchesVerifier(secret, record.renewalVerifier);
  }

  /** Replaces the worker token; the caller has checked the renewal secret. */
  renew(id: string): { token: string; expiresAt: number } {
    const token = newSecret();
    const expiresAt = this.now() + TRANSFER_TOKEN_TTL_MS;
    this.update(
      id,
      (record) => {
        record.tokenVerifier = verifierOf(token);
        record.tokenExpiresAt = expiresAt;
      },
      false,
    );
    return { token, expiresAt };
  }

  /**
   * Records a worker event. In a non-terminal state the event moves the
   * state forward; a terminal state never changes, but until the worker
   * finishes it still takes `error` and `progress` (recovery reporting).
   * A state change, or an event with neither error nor progress, clears the
   * recorded error and confirms the state; a same-state event that only
   * carries `progress` leaves both alone. An event that changes nothing
   * writes nothing. Returns whether the record changed.
   */
  applyEvent(id: string, event: TransferEventPayload): boolean {
    const current = this.require(id);
    const terminal = isTerminalState(current.state);
    if (terminal && current.finished) return false;
    const sameError = event.error
      ? current.error?.code === event.error.code &&
        current.error.message === event.error.message
      : current.error === undefined;
    const moved = !terminal && event.state !== current.state;
    const confirms = !terminal && !event.error && (moved || !event.progress);
    const errorChanged = event.error ? !sameError : confirms && !sameError;
    const progressChanged =
      event.progress !== undefined &&
      JSON.stringify(event.progress) !== JSON.stringify(current.progress);
    if (!moved && current.workerStarted && !errorChanged && !progressChanged)
      return false;
    const at = this.iso();
    this.update(id, (record) => {
      record.workerStarted = true;
      if (moved) {
        record.state = event.state;
        record.history.push({
          state: event.state,
          at,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        });
        record.history = record.history.slice(-MAX_TRANSFER_HISTORY);
      }
      if (event.error) {
        if (!sameError) record.error = { ...event.error, at };
      } else if (confirms) {
        record.error = undefined;
        record.lastConfirmedState = record.state;
      }
      if (event.progress) record.progress = event.progress;
    });
    return true;
  }

  /** Appends a command for the worker. Refused with 409 once it finished. */
  addCommand(
    id: string,
    type: TransferCommand["type"],
    payload: Record<string, unknown>,
  ): TransferCommand {
    if (this.require(id).finished)
      throw new TransferRequestError("transfer is finished", 409);
    const record = this.update(id, (next) => {
      const seq = (next.commands.at(-1)?.seq ?? 0) + 1;
      next.commands.push({ seq, type, payload, createdAt: this.iso() });
    });
    return structuredClone(record.commands.at(-1) as TransferCommand);
  }

  /** Commands after `after` that the worker has not acknowledged, in order. */
  pendingCommands(id: string, after: number): TransferCommand[] {
    return structuredClone(
      this.require(id).commands.filter(
        (command) => command.seq > after && command.ackedAt === undefined,
      ),
    );
  }

  /** Marks one command acknowledged; repeating an ack changes nothing. */
  ackCommand(id: string, seq: number): void {
    const command = this.require(id).commands.find((c) => c.seq === seq);
    if (!command)
      throw new TransferRequestError(`command ${seq} not found`, 404);
    if (command.ackedAt !== undefined) return;
    this.update(id, (record) => {
      const target = record.commands.find((c) => c.seq === seq);
      if (target) target.ackedAt = this.iso();
    });
  }

  /** Ends the worker's access to renewal; repeating it changes nothing. */
  finish(id: string): void {
    if (this.require(id).finished) return;
    this.update(id, (record) => {
      record.finished = true;
      record.renewalVerifier = "";
    });
  }

  /**
   * Closes an operation nobody is driving: its worker never reported in, or
   * has been silent for TRANSFER_ABANDON_AFTER_MS. The operation ends as
   * `rolled-back` with an `abandoned` error, finished, and both credentials
   * revoked. Refused with 409 when it is terminal, finished, or its worker
   * is still active.
   */
  abandon(id: string): void {
    const current = this.require(id);
    if (current.finished || isTerminalState(current.state))
      throw new TransferRequestError("transfer is already finished", 409);
    const silent = this.now() - Date.parse(current.updatedAt);
    if (current.workerStarted && silent < TRANSFER_ABANDON_AFTER_MS)
      throw new TransferRequestError(
        "transfer worker is still active; wait before abandoning it",
        409,
      );
    const at = this.iso();
    this.update(id, (record) => {
      record.state = "rolled-back";
      record.history.push({ state: "rolled-back", at, detail: "abandoned" });
      record.history = record.history.slice(-MAX_TRANSFER_HISTORY);
      record.error = {
        code: "abandoned",
        message:
          "Transfer abandoned on the hub; the source session may need `ompc-send recover`.",
        at,
      };
      record.finished = true;
      record.tokenVerifier = "";
      record.tokenExpiresAt = 0;
      record.renewalVerifier = "";
    });
  }

  private require(id: string): TransferRecord {
    const record = this.records.get(id);
    if (!record)
      throw new TransferRequestError(`transfer '${id}' not found`, 404);
    return record;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** A finished terminal operation past its retention period. */
  private expired(record: TransferRecord): boolean {
    return (
      record.finished &&
      isTerminalState(record.state) &&
      this.now() - Date.parse(record.updatedAt) >= TRANSFER_RETENTION_MS
    );
  }

  /** Applies `change` to a copy, saves it, then publishes it. */
  private update(
    id: string,
    change: (record: TransferRecord) => void,
    announce = true,
  ): TransferRecord {
    const next = structuredClone(this.require(id));
    change(next);
    next.updatedAt = this.iso();
    this.persist(
      [...this.records.values()].map((r) => (r.id === id ? next : r)),
    );
    this.records.set(id, next);
    if (announce) this.announce(id);
    return next;
  }

  private load(): TransferRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let records: TransferRecord[] | null = null;
    try {
      records = parseStateFile(JSON.parse(raw));
    } catch {
      // Not JSON; handled below with every other invalid file.
    }
    if (records) return records;
    const aside = `${this.path}.corrupt-${Date.now()}`;
    try {
      renameSync(this.path, aside);
      console.error(
        `transfers: ${this.path} is not valid; moved it to ${aside} and started with no transfers`,
      );
    } catch (error) {
      console.error(
        `transfers: ${this.path} is not valid and could not be moved aside (${(error as Error).message}); started with no transfers`,
      );
    }
    return [];
  }

  /** Atomic replace: a crash leaves either the old or the new file. */
  private persist(records: TransferRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      const fd = openSync(temp, "w", 0o600);
      try {
        writeSync(
          fd,
          `${JSON.stringify({ version: FILE_VERSION, transfers: records })}\n`,
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
