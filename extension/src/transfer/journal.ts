import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readdir, readFile, link, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type TransferState =
	| "prepared"
	| "source-stopping"
	| "source-stopped"
	| "staged"
	| "publishing"
	| "source-departed"
	| "destination-starting"
	| "completed"
	| "aborting"
	| "rolled-back";
export type TransferRole = "source" | "destination";
export type ProjectMode = "create" | "session-only" | "update";

export interface LaunchIntent {
	nonce: string;
	status: "recorded" | "cancelled" | "consumed";
	recordedAt: string;
	settledAt?: string;
}

export interface OperationRecord {
	operationId: string;
	role: TransferRole;
	sessionId: string;
	/** Current state. Moves only through `transition`. */
	state: TransferState;
	/** Last state a transition confirmed outside the abort path. Unchanged by `fail` and by entering `aborting` or `rolled-back`. */
	lastConfirmedState: TransferState;
	planDigest: string;
	projectMode: ProjectMode;
	destinationName?: string;
	sourceProject?: string;
	destinationProject?: string;
	sessionName?: string;
	error?: { code: string; message: string; at: string };
	launch?: LaunchIntent;
	history: { state: TransferState; at: string; detail?: string }[];
	createdAt: string;
	updatedAt: string;
}

export interface CreateOperationInit {
	operationId: string;
	role: TransferRole;
	sessionId: string;
	planDigest: string;
	projectMode: ProjectMode;
	destinationName?: string;
	sourceProject?: string;
	destinationProject?: string;
	sessionName?: string;
}

export type JournalErrorCode =
	| "invalid-id"
	| "invalid-argument"
	| "not-found"
	| "exists"
	| "corrupt"
	| "illegal-transition"
	| "lock-timeout"
	| "worker-active"
	| "launch-intent-exists"
	| "launch-intent-settled";

export class JournalError extends Error {
	readonly code: JournalErrorCode;
	constructor(code: JournalErrorCode, message: string) {
		super(message);
		this.name = "JournalError";
		this.code = code;
	}
}

export const TRANSFER_STATES: readonly TransferState[] = [
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
];

/** Allowed next states. `completed` and `rolled-back` are terminal. */
export const ALLOWED_TRANSITIONS: Readonly<Record<TransferState, readonly TransferState[]>> = {
	prepared: ["source-stopping", "aborting"],
	"source-stopping": ["source-stopped", "aborting"],
	"source-stopped": ["staged", "aborting"],
	staged: ["publishing", "aborting"],
	publishing: ["source-departed", "aborting"],
	"source-departed": ["destination-starting", "aborting"],
	"destination-starting": ["completed", "aborting"],
	completed: [],
	aborting: ["rolled-back"],
	"rolled-back": [],
};

export function isTerminalState(state: TransferState): boolean {
	return ALLOWED_TRANSITIONS[state].length === 0;
}

export const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ROLES: readonly TransferRole[] = ["source", "destination"];
const PROJECT_MODES: readonly ProjectMode[] = ["create", "session-only", "update"];
const LAUNCH_STATUSES = ["recorded", "cancelled", "consumed"];
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/** An unparseable lock file is only taken over after this age, in case a writer is mid-flight. */
const UNPARSEABLE_LOCK_GRACE_MS = 5_000;

/** `${XDG_STATE_HOME:-~/.local/state}/omp-connected/transfers`. */
export function defaultJournalDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const xdg = env.XDG_STATE_HOME;
	const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
	return join(base, "omp-connected", "transfers");
}

export interface OperationJournalOptions {
	/** How long `withOperationLock` waits for another holder. Default 30 s. */
	lockTimeoutMs?: number;
}

interface LockInfo {
	pid: number;
	/** Kernel start time of the holder (Linux `/proc` clock ticks), or null when unavailable. */
	startTime: number | null;
	startedAt: string;
	token: string;
}

type LockRead = { raw: string; info: LockInfo | undefined; mtimeMs: number };

/** Kernel start time of a process, used to tell a live holder from a reused pid. */
async function processStartTime(pid: number): Promise<number | null> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const value = Number(fields[19]);
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

let selfStartTime: Promise<number | null> | undefined;

async function makeLockInfo(): Promise<LockInfo> {
	selfStartTime ??= processStartTime(process.pid);
	return {
		pid: process.pid,
		startTime: await selfStartTime,
		startedAt: new Date().toISOString(),
		token: randomUUID(),
	};
}

function parseLockInfo(raw: string): LockInfo | undefined {
	try {
		const value = JSON.parse(raw);
		if (
			value &&
			typeof value === "object" &&
			Number.isInteger(value.pid) &&
			value.pid > 0 &&
			(value.startTime === null || typeof value.startTime === "number") &&
			typeof value.token === "string"
		) {
			return value as LockInfo;
		}
	} catch {}
	return undefined;
}

async function readLock(path: string): Promise<LockRead | undefined> {
	try {
		const [raw, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		return { raw, info: parseLockInfo(raw), mtimeMs: stats.mtimeMs };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function lockIsStale(lock: LockRead): Promise<boolean> {
	if (!lock.info) return Date.now() - lock.mtimeMs > UNPARSEABLE_LOCK_GRACE_MS;
	if (!pidAlive(lock.info.pid)) return true;
	if (lock.info.startTime !== null) {
		const current = await processStartTime(lock.info.pid);
		if (current !== null && current !== lock.info.startTime) return true;
	}
	return false;
}

/** Creates `path` exclusively with complete content; false when it already exists. */
async function tryCreateLock(path: string, info: LockInfo): Promise<boolean> {
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temp, JSON.stringify(info), { mode: 0o600, flag: "wx" });
	try {
		await link(temp, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		await unlink(temp).catch(ignoreMissing);
	}
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
	if (error.code !== "ENOENT") throw error;
}

async function releaseLock(path: string, token: string): Promise<void> {
	const held = await readLock(path);
	if (held?.info?.token === token) await unlink(path).catch(ignoreMissing);
}

/**
 * Removes a stale lock. Takeovers serialise on a short-lived guard file so two processes
 * cannot both delete a lock the other has just created. Returns true when this call made progress.
 */
async function takeOver(path: string, observed: LockRead): Promise<boolean> {
	const guardPath = `${path}.takeover`;
	const guardInfo = await makeLockInfo();
	if (!(await tryCreateLock(guardPath, guardInfo))) {
		const guard = await readLock(guardPath);
		if (guard && (await lockIsStale(guard))) {
			const again = await readLock(guardPath);
			if (again?.raw === guard.raw) await unlink(guardPath).catch(ignoreMissing);
			return true;
		}
		return false;
	}
	try {
		const current = await readLock(path);
		if (current && current.raw === observed.raw && (await lockIsStale(current))) {
			await unlink(path).catch(ignoreMissing);
		}
		return true;
	} finally {
		await releaseLock(guardPath, guardInfo.token);
	}
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function acquireFileLock(path: string, timeoutMs: number): Promise<LockInfo> {
	const info = await makeLockInfo();
	const deadline = Date.now() + timeoutMs;
	let wait = 2;
	for (;;) {
		if (await tryCreateLock(path, info)) return info;
		const held = await readLock(path);
		if (!held) continue;
		if ((await lockIsStale(held)) && (await takeOver(path, held))) continue;
		if (Date.now() >= deadline) {
			throw new JournalError("lock-timeout", `Timed out waiting for lock held by pid ${held.info?.pid ?? "unknown"}`);
		}
		await delay(wait);
		wait = Math.min(wait * 2, 50);
	}
}

/** In-process queue per lock path; the file lock only arbitrates between processes. */
const queues = new Map<string, Promise<void>>();
/** Lock paths held by the current async call chain, so nested calls on the same operation do not deadlock. */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const { promise: gate, resolve: release } = Promise.withResolvers<void>();
	const tail = previous.then(() => gate);
	queues.set(key, tail);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (queues.get(key) === tail) queues.delete(key);
	}
}

function assertId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !OPERATION_ID_PATTERN.test(id)) {
		throw new JournalError("invalid-id", "Operation id must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/");
	}
}

function assertNonce(nonce: unknown): asserts nonce is string {
	if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
		throw new JournalError("invalid-argument", "Launch nonce must match /^[A-Za-z0-9_-]{1,128}$/");
	}
}

function nonceEquals(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function isState(value: unknown): value is TransferState {
	return typeof value === "string" && (TRANSFER_STATES as readonly string[]).includes(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isOptionalString = (value: unknown): boolean => value === undefined || isString(value);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(id: string, text: string): OperationRecord {
	const corrupt = (reason: string) => new JournalError("corrupt", `Operation record ${id} is corrupt: ${reason}`);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw corrupt((error as Error).message);
	}
	if (!isObject(value)) throw corrupt("not an object");
	if (value.operationId !== id) throw corrupt("operationId does not match the file name");
	if (!ROLES.includes(value.role as TransferRole)) throw corrupt("invalid role");
	if (!isString(value.sessionId) || !isString(value.planDigest)) throw corrupt("invalid sessionId or planDigest");
	if (!isState(value.state) || !isState(value.lastConfirmedState)) throw corrupt("invalid state");
	if (!PROJECT_MODES.includes(value.projectMode as ProjectMode)) throw corrupt("invalid projectMode");
	if (!isString(value.createdAt) || !isString(value.updatedAt)) throw corrupt("invalid timestamps");
	if (
		!isOptionalString(value.destinationName) ||
		!isOptionalString(value.sourceProject) ||
		!isOptionalString(value.destinationProject) ||
		!isOptionalString(value.sessionName)
	) {
		throw corrupt("invalid optional field");
	}
	if (
		!Array.isArray(value.history) ||
		!value.history.every(
			(entry: unknown) => isObject(entry) && isState(entry.state) && isString(entry.at) && isOptionalString(entry.detail),
		)
	) {
		throw corrupt("invalid history");
	}
	const { error, launch } = value;
	if (error !== undefined && !(isObject(error) && isString(error.code) && isString(error.message) && isString(error.at))) {
		throw corrupt("invalid error");
	}
	if (
		launch !== undefined &&
		!(
			isObject(launch) &&
			isString(launch.nonce) &&
			LAUNCH_STATUSES.includes(launch.status as string) &&
			isString(launch.recordedAt) &&
			isOptionalString(launch.settledAt)
		)
	) {
		throw corrupt("invalid launch intent");
	}
	// Every field was checked above.
	return value as unknown as OperationRecord;
}

/** Writes JSON to a same-directory temp file, fsyncs it, renames over `path`, then fsyncs the directory. */
async function writeAtomic(dir: string, path: string, data: string): Promise<void> {
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(ignoreMissing);
		throw error;
	}
	try {
		const directory = await open(dir, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch {}
}

/** One JSON file per operation under `dir`, mutated only under a per-operation cross-process lock. */
export class OperationJournal {
	readonly #dir: string;
	readonly #lockTimeoutMs: number;

	constructor(dir: string, options: OperationJournalOptions = {}) {
		this.#dir = dir;
		this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	}

	#recordPath(id: string): string {
		assertId(id);
		return join(this.#dir, `${id}.json`);
	}

	#lockPath(id: string): string {
		assertId(id);
		return join(this.#dir, `${id}.lock`);
	}

	async #read(id: string): Promise<OperationRecord | undefined> {
		let text: string;
		try {
			text = await readFile(this.#recordPath(id), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		return parseRecord(id, text);
	}

	async #write(record: OperationRecord): Promise<void> {
		await mkdir(this.#dir, { recursive: true, mode: 0o700 });
		await writeAtomic(this.#dir, this.#recordPath(record.operationId), `${JSON.stringify(record, null, "\t")}\n`);
	}

	/** Loads under the operation lock, applies `change`, and persists the result. */
	async #mutate(id: string, change: (record: OperationRecord, now: string) => OperationRecord | undefined): Promise<OperationRecord> {
		return this.withOperationLock(id, async () => {
			const record = await this.#read(id);
			if (!record) throw new JournalError("not-found", `Operation ${id} not found`);
			const now = new Date().toISOString();
			const next = change(structuredClone(record), now);
			if (!next) return record;
			next.updatedAt = now;
			await this.#write(next);
			return next;
		});
	}

	async create(init: CreateOperationInit): Promise<OperationRecord> {
		assertId(init.operationId);
		if (!ROLES.includes(init.role)) throw new JournalError("invalid-argument", "Invalid role");
		if (!PROJECT_MODES.includes(init.projectMode)) throw new JournalError("invalid-argument", "Invalid projectMode");
		if (!isString(init.sessionId) || init.sessionId === "") throw new JournalError("invalid-argument", "sessionId is required");
		if (!isString(init.planDigest)) throw new JournalError("invalid-argument", "planDigest is required");
		for (const key of ["destinationName", "sourceProject", "destinationProject", "sessionName"] as const) {
			if (!isOptionalString(init[key])) throw new JournalError("invalid-argument", `${key} must be a string`);
		}
		return this.withOperationLock(init.operationId, async () => {
			if (await this.#read(init.operationId)) {
				throw new JournalError("exists", `Operation ${init.operationId} already exists`);
			}
			const now = new Date().toISOString();
			const record: OperationRecord = {
				operationId: init.operationId,
				role: init.role,
				sessionId: init.sessionId,
				state: "prepared",
				lastConfirmedState: "prepared",
				planDigest: init.planDigest,
				projectMode: init.projectMode,
				...(init.destinationName !== undefined && { destinationName: init.destinationName }),
				...(init.sourceProject !== undefined && { sourceProject: init.sourceProject }),
				...(init.destinationProject !== undefined && { destinationProject: init.destinationProject }),
				...(init.sessionName !== undefined && { sessionName: init.sessionName }),
				history: [{ state: "prepared", at: now }],
				createdAt: now,
				updatedAt: now,
			};
			await this.#write(record);
			return record;
		});
	}

	/** Returns undefined only when no record exists; an unreadable record throws `corrupt`. */
	async load(id: string): Promise<OperationRecord | undefined> {
		return this.#read(id);
	}

	async #listFiles(): Promise<string[]> {
		let names: string[];
		try {
			names = await readdir(this.#dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return names
			.filter((name) => name.endsWith(".json") && OPERATION_ID_PATTERN.test(name.slice(0, -".json".length)))
			.map((name) => name.slice(0, -".json".length));
	}

	/** Lists readable records oldest first. Corrupt records are skipped; see `listCorrupt`. */
	async list(): Promise<OperationRecord[]> {
		const records: OperationRecord[] = [];
		for (const id of await this.#listFiles()) {
			try {
				const record = await this.#read(id);
				if (record) records.push(record);
			} catch (error) {
				if (!(error instanceof JournalError && error.code === "corrupt")) throw error;
			}
		}
		return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId));
	}

	async listCorrupt(): Promise<{ operationId: string; message: string }[]> {
		const corrupt: { operationId: string; message: string }[] = [];
		for (const id of await this.#listFiles()) {
			try {
				await this.#read(id);
			} catch (error) {
				if (!(error instanceof JournalError && error.code === "corrupt")) throw error;
				corrupt.push({ operationId: id, message: error.message });
			}
		}
		return corrupt;
	}

	/**
	 * Moves to `to` when the table allows it from the current state, clearing any recorded error.
	 * Entering `aborting` or `rolled-back` leaves `lastConfirmedState` at the pre-abort state.
	 */
	async transition(id: string, to: TransferState, detail?: string): Promise<OperationRecord> {
		if (!isState(to)) throw new JournalError("invalid-argument", `Unknown state ${String(to)}`);
		return this.#mutate(id, (record, now) => {
			if (!ALLOWED_TRANSITIONS[record.state].includes(to)) {
				throw new JournalError("illegal-transition", `Cannot move operation ${id} from ${record.state} to ${to}`);
			}
			record.state = to;
			if (to !== "aborting" && to !== "rolled-back") record.lastConfirmedState = to;
			record.history.push({ state: to, at: now, ...(detail !== undefined && { detail }) });
			delete record.error;
			return record;
		});
	}

	/** Records an error without changing `state` or `lastConfirmedState`. */
	async fail(id: string, error: { code: string; message: string }): Promise<OperationRecord> {
		if (!error || !isString(error.code) || !isString(error.message)) {
			throw new JournalError("invalid-argument", "error needs a string code and message");
		}
		return this.#mutate(id, (record, now) => {
			record.error = { code: error.code, message: error.message, at: now };
			return record;
		});
	}

	/** Exclusive across processes and across callers in this process. Nested calls from inside `fn` for the same id run inline. */
	async withOperationLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const path = this.#lockPath(id);
		const held = heldLocks.getStore();
		if (held?.has(path)) return fn();
		return withMutex(path, async () => {
			await mkdir(this.#dir, { recursive: true, mode: 0o700 });
			const info = await acquireFileLock(path, this.#lockTimeoutMs);
			try {
				return await heldLocks.run(new Set([...(held ?? []), path]), fn);
			} finally {
				await releaseLock(path, info.token);
			}
		});
	}

	/** Single worker per operation. Throws `worker-active` while another live process (or this one) holds it. */
	async acquireWorkerLock(id: string): Promise<{ release(): Promise<void> }> {
		assertId(id);
		await mkdir(this.#dir, { recursive: true, mode: 0o700 });
		const path = join(this.#dir, `${id}.worker.lock`);
		const info = await makeLockInfo();
		for (;;) {
			if (await tryCreateLock(path, info)) break;
			const held = await readLock(path);
			if (!held) continue;
			if (!(await lockIsStale(held))) {
				throw new JournalError("worker-active", `Operation ${id} already has a worker (pid ${held.info?.pid ?? "unknown"})`);
			}
			if (!(await takeOver(path, held))) await delay(2);
		}
		let released = false;
		return {
			release: async () => {
				if (released) return;
				released = true;
				await releaseLock(path, info.token);
			},
		};
	}

	/** Records a launch intent. Repeating the same nonce while recorded is a no-op. */
	async recordLaunchIntent(id: string, nonce: string): Promise<void> {
		assertNonce(nonce);
		await this.#mutate(id, (record, now) => {
			const launch = record.launch;
			if (launch) {
				if (launch.status !== "recorded") {
					throw new JournalError("launch-intent-settled", `Launch intent for ${id} is already ${launch.status}`);
				}
				if (!nonceEquals(launch.nonce, nonce)) {
					throw new JournalError("launch-intent-exists", `Operation ${id} already has a launch intent`);
				}
				return undefined;
			}
			record.launch = { nonce, status: "recorded", recordedAt: now };
			return record;
		});
	}

	/**
	 * Cancels a recorded intent permanently. 'already-consumed' means a launch may be running.
	 * 'none' covers both no intent and no operation record.
	 */
	async cancelLaunchIntent(id: string): Promise<"cancelled" | "already-consumed" | "none"> {
		return this.withOperationLock(id, async () => {
			const record = await this.#read(id);
			if (!record?.launch) return "none";
			if (record.launch.status === "consumed") return "already-consumed";
			if (record.launch.status === "recorded") {
				const now = new Date().toISOString();
				record.launch = { ...record.launch, status: "cancelled", settledAt: now };
				record.updatedAt = now;
				await this.#write(record);
			}
			return "cancelled";
		});
	}

	/** True exactly once: when the intent is recorded and the nonce matches. */
	async consumeLaunchIntent(id: string, nonce: string): Promise<boolean> {
		assertNonce(nonce);
		return this.withOperationLock(id, async () => {
			const record = await this.#read(id);
			const launch = record?.launch;
			if (!record || !launch || launch.status !== "recorded" || !nonceEquals(launch.nonce, nonce)) return false;
			const now = new Date().toISOString();
			record.launch = { ...launch, status: "consumed", settledAt: now };
			record.updatedAt = now;
			await this.#write(record);
			return true;
		});
	}
}
