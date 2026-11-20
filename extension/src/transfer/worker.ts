// Source-side send-to-host worker. `plan` is a read-only preflight; `run` drives
// one operation through the commit protocol on the source host (reserve, stop,
// pack, stage, publish, depart, launch, verify) with every step recorded in the
// source journal first and mirrored to the hub; `recover` performs the explicit
// recovery actions. The destination is reached only through `ssh.ts`.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, type Dirent, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import {
	type DestinationConfig,
	getDestination,
	loadTransferConfig,
	resolveDestinationPolicy,
} from "./config.js";
import { createHubClient, createNoopHubClient, type HubCommand, type HubTransferClient, isRecord } from "./hub-client.js";
import {
	defaultJournalDir,
	isTerminalState,
	JournalError,
	OPERATION_ID_PATTERN,
	OperationJournal,
	type OperationRecord,
	type ProjectMode,
	type TransferState,
} from "./journal.js";
import {
	buildManifest,
	DEFAULT_EXCLUDES,
	diffManifests,
	type ProjectPlan,
	ProjectSyncError,
	resolveDestinationProject,
	sha256File,
	type TreeManifest,
} from "./project-sync.js";
import { callHelper, rsyncFiles, SshError, TRANSFER_PROTOCOL } from "./ssh.js";

// ---------------------------------------------------------------------------
// Public types

export interface SessionFacts {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	title?: string;
	launcherName?: string;
	/** Process id of the owning OMP; absent for an inactive session. */
	pid?: number;
	hostId?: string;
	instanceId?: string;
}

export interface PlanRequest {
	destination: string;
	projectMode?: ProjectMode;
	destinationPath?: string;
	session: SessionFacts;
}

export interface RunRequest {
	operationId: string;
	/** Absent for a local CLI run, which has no hub. */
	hubUrl?: string;
	token?: string;
	renewalSecret?: string;
	planId: string;
	planDigest: string;
	projectMode: ProjectMode;
	acceptIncomplete: boolean;
	destination: string;
	session: SessionFacts;
}

export interface Preflight {
	sessionId: string;
	title: string | null;
	launcherName: string | null;
	sourceProject: string;
	destinationProject: string;
	destinationExists: boolean;
	destinationHostId: string;
	destinationHome: string;
	projectMode: ProjectMode;
	/** The session process is running, so commit needs the stop handshake. */
	live: boolean;
	children: number;
	archiveBytes: number;
	/** Sizes come from the files, not a pack; missing blobs cannot be known until the source stops. */
	archiveEstimated: boolean;
	missingBlobs: string[];
	externalReferences: string[];
	skippedSymlinks: string[];
	/** Commit needs `acceptIncomplete` when true. */
	acceptIncompleteRequired: boolean;
	gitDirty: boolean | null;
	knownUsers: string[];
	warnings: string[];
	/** Non-empty disables commit. */
	blockers: string[];
	runtimeVersion: string | null;
	runtimeCompatible: boolean;
	freeBytes: number | null;
	destinationSession: { existsLocally: boolean; sessionFile: string | null };
	/** The helper journal directory and the destination share a filesystem; null when the helper does not report it. */
	stagingSameFilesystem: boolean | null;
}

export interface PlanResult {
	planId: string;
	digest: string;
	plan: ProjectPlan;
	preflight: Preflight;
}

export interface WorkerTiming {
	/** How long to wait for `stop-ack.json`. */
	stopAckTimeoutMs: number;
	/** How long to wait for the owner process to exit after an acknowledged stop. */
	pidExitTimeoutMs: number;
	pollMs: number;
	arrivalTimeoutMs: number;
	arrivalPollMs: number;
	/** Hub command poll interval while a run is active. */
	commandPollMs: number;
	/** How long a failed operation waits for recovery commands before the worker exits. */
	recoveryWaitMs: number;
	recoveryPollMs: number;
	helperRetries: number;
	helperBackoffMs: number;
	helperTimeoutMs: number;
	/** Limit for ops that hash or move large trees (import, publish, restore, inspect, cleanup) and for each rsync attempt. */
	helperLongTimeoutMs: number;
	/** How long to wait while the destination answers `op-busy` for an operation. */
	opBusyWaitMs: number;
	opBusyPollMs: number;
	rsyncRetries: number;
	rsyncBackoffMs: number;
}

export const DEFAULT_TIMING: Readonly<WorkerTiming> = {
	stopAckTimeoutMs: 60_000,
	pidExitTimeoutMs: 60_000,
	pollMs: 500,
	arrivalTimeoutMs: 120_000,
	arrivalPollMs: 1000,
	commandPollMs: 2000,
	recoveryWaitMs: 24 * 60 * 60 * 1000,
	recoveryPollMs: 2000,
	helperRetries: 2,
	helperBackoffMs: 1000,
	helperTimeoutMs: 120_000,
	helperLongTimeoutMs: 30 * 60_000,
	opBusyWaitMs: 30 * 60_000,
	opBusyPollMs: 2000,
	rsyncRetries: 3,
	rsyncBackoffMs: 2000,
};

export interface WorkerContext {
	env?: NodeJS.ProcessEnv;
	/** Source home directory; defaults to `$HOME`. */
	home?: string;
	journalDir?: string;
	configPath?: string;
	timing?: Partial<WorkerTiming>;
	/** Overrides the client built from the request (tests). */
	hub?: HubTransferClient;
	fetch?: typeof fetch;
	log?: (line: string) => void;
	/** Keep a failed operation alive for recovery commands. Defaults to true when a hub is configured. */
	awaitRecovery?: boolean;
	/** Test seam: runs after each journal transition; a throw ends the run like a crash. */
	afterTransition?: (state: TransferState) => void | Promise<void>;
}

export type RecoverAction = "resume" | "retry-launch" | "rollback-source" | "restore-project" | "cleanup";
export const RECOVER_ACTIONS: readonly RecoverAction[] = ["resume", "retry-launch", "rollback-source", "restore-project", "cleanup"];

export interface RunOutcome {
	operationId: string;
	state: TransferState;
	error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Errors

export class WorkerError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "WorkerError";
	}
}

/** A recovery request that does not apply to the operation's state; the operation's own error stays recorded. */
class Refused extends WorkerError {}

class CancelledError extends WorkerError {
	constructor(readonly boundary: string) {
		super("cancelled", `cancelled at ${boundary}`);
	}
}

/** A failure reported by the destination helper. */
class HelperFailure extends WorkerError {}

/** The helper could not be reached or did not answer. */
class TargetUnreachable extends WorkerError {
	constructor(message: string) {
		super("target-unreachable", message);
	}
}

/** Raised by the `afterTransition` seam; ends the run without recording a failure. */
class CrashSignal extends Error {}

export function errorInfo(error: unknown): { code: string; message: string } {
	const code = isRecord(error) ? error.code : undefined;
	return {
		code: typeof code === "string" ? code : "internal",
		message: error instanceof Error ? error.message : String(error),
	};
}

// ---------------------------------------------------------------------------
// Runtime

interface Runtime {
	env: NodeJS.ProcessEnv;
	home: string;
	journalDir: string;
	configPath: string | undefined;
	journal: OperationJournal;
	timing: WorkerTiming;
	log: (line: string) => void;
	ctx: WorkerContext;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_PLAN_AGE_MS = 24 * 60 * 60 * 1000;
/** Per-operation directory of queued recovery requests (hub commands and handed-over CLI calls). */
const RECOVER_DIR = "recover-requests";
/** Helper ops that hash or move large trees get the long timeout. */
const LONG_HELPER_OPS: ReadonlySet<string> = new Set(["inspect", "import-session", "publish-project", "restore-project", "cleanup"]);

/** True while a live process holds the worker lock; reads the lock file without taking it. */
async function workerLockActive(journalDir: string, operationId: string): Promise<boolean> {
	let info: unknown;
	try {
		info = JSON.parse(await fs.readFile(path.join(journalDir, `${operationId}.worker.lock`), "utf8"));
	} catch {
		return false;
	}
	if (!isRecord(info) || !Number.isInteger(info.pid) || (info.pid as number) < 1) return false;
	const pid = info.pid as number;
	if (!pidAlive(pid)) return false;
	if (typeof info.startTime === "number") {
		try {
			const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
			const current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
			if (Number.isFinite(current) && current !== info.startTime) return false;
		} catch {
			// no /proc: the pid check stands
		}
	}
	return true;
}

function createRuntime(ctx: WorkerContext = {}): Runtime {
	const env = ctx.env ?? process.env;
	const home = ctx.home ?? env.HOME ?? homedir();
	const journalDir = ctx.journalDir ?? defaultJournalDir(env, home);
	return {
		env,
		home,
		journalDir,
		configPath: ctx.configPath,
		journal: new OperationJournal(journalDir),
		timing: { ...DEFAULT_TIMING, ...ctx.timing },
		log: ctx.log ?? ((line) => void process.stderr.write(`ompc-send: ${line}\n`)),
		ctx,
	};
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const parts = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
		return `{${parts.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

async function writePrivateJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	await fs.rename(tmp, file);
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Request parsing

function str(value: unknown, label: string, pattern?: RegExp, max = 4096): string {
	if (typeof value !== "string" || value === "" || value.length > max || (pattern && !pattern.test(value))) {
		throw new WorkerError("invalid-request", `${label} is missing or malformed`);
	}
	return value;
}

/** Display text such as a title: anything non-empty is kept, clipped to a sane length. */
function optionalText(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	return value.trim().slice(0, 256);
}

function absolutePath(value: unknown, label: string): string {
	const text = str(value, label);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (!path.isAbsolute(text) || /[\x00-\x1f\x7f]/.test(text)) throw new WorkerError("invalid-request", `${label} must be an absolute path`);
	return text;
}

function parseSession(raw: unknown): SessionFacts {
	if (!isRecord(raw)) throw new WorkerError("invalid-request", "session is missing");
	const pid = raw.pid;
	if (pid !== undefined && pid !== null && (!Number.isInteger(pid) || (pid as number) < 1)) {
		throw new WorkerError("invalid-request", "session.pid is malformed");
	}
	return {
		sessionId: str(raw.sessionId, "session.sessionId", SESSION_ID),
		sessionFile: absolutePath(raw.sessionFile, "session.sessionFile"),
		cwd: absolutePath(raw.cwd, "session.cwd"),
		title: optionalText(raw.title),
		launcherName: optionalText(raw.launcherName),
		...(typeof pid === "number" && { pid }),
		hostId: optionalText(raw.hostId),
		instanceId: optionalText(raw.instanceId),
	};
}

const PROJECT_MODES: readonly ProjectMode[] = ["create", "session-only", "update"];

function parseProjectMode(value: unknown): ProjectMode {
	if (!PROJECT_MODES.includes(value as ProjectMode)) throw new WorkerError("invalid-request", "projectMode is malformed");
	return value as ProjectMode;
}

export function parsePlanRequest(raw: unknown): PlanRequest {
	if (!isRecord(raw)) throw new WorkerError("invalid-request", "request must be a JSON object");
	return {
		destination: str(raw.destination, "destination", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
		...(raw.projectMode !== undefined && { projectMode: parseProjectMode(raw.projectMode) }),
		...(raw.destinationPath !== undefined && { destinationPath: str(raw.destinationPath, "destinationPath") }),
		session: parseSession(raw.session),
	};
}

export function parseRunRequest(raw: unknown): RunRequest {
	if (!isRecord(raw)) throw new WorkerError("invalid-request", "request must be a JSON object");
	const hubUrl = raw.hubUrl === undefined || raw.hubUrl === null ? undefined : str(raw.hubUrl, "hubUrl");
	if (hubUrl !== undefined && !/^https?:\/\//.test(hubUrl)) throw new WorkerError("invalid-request", "hubUrl must be http or https");
	if (typeof raw.acceptIncomplete !== "boolean") throw new WorkerError("invalid-request", "acceptIncomplete must be a boolean");
	return {
		operationId: str(raw.operationId, "operationId", OPERATION_ID_PATTERN),
		...(hubUrl !== undefined && {
			hubUrl,
			token: str(raw.token, "token"),
			renewalSecret: str(raw.renewalSecret, "renewalSecret"),
		}),
		planId: str(raw.planId, "planId", OPERATION_ID_PATTERN),
		planDigest: str(raw.planDigest, "planDigest", /^[A-Za-z0-9:_.-]{1,256}$/),
		projectMode: parseProjectMode(raw.projectMode),
		acceptIncomplete: raw.acceptIncomplete,
		destination: str(raw.destination, "destination", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
		session: parseSession(raw.session),
	};
}

// ---------------------------------------------------------------------------
// OMP runtime (source side)

function resolveOmpBin(rt: Runtime): string {
	if (rt.env.OMP_BIN) return rt.env.OMP_BIN;
	for (const dir of (rt.env.PATH ?? "").split(":")) {
		if (dir === "" || !path.isAbsolute(dir)) continue;
		const candidate = path.join(dir, "omp");
		if (existsSync(candidate)) return candidate;
	}
	for (const dir of [path.join(rt.home, ".bun", "bin"), path.join(rt.home, ".local", "bin")]) {
		const candidate = path.join(dir, "omp");
		if (existsSync(candidate)) return candidate;
	}
	return "omp";
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** Runs `omp <args>` (argv only) and returns the single JSON object it printed; `{ ok: false }` throws. */
async function runOmp(rt: Runtime, args: string[], timeoutMs = 10 * 60_000): Promise<Record<string, unknown>> {
	const bin = resolveOmpBin(rt);
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn([bin, ...args], { env: stringEnv(rt.env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	} catch (error) {
		throw new WorkerError("omp-missing", `cannot start omp: ${(error as Error).message}`);
	}
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	try {
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		if (stderr.trim() !== "") rt.log(`omp ${args.slice(0, 2).join(" ")}: ${stderr.trim().slice(0, 1000)}`);
		const text = stdout.trim();
		let parsed: unknown;
		for (const candidate of [text, text.split("\n").at(-1) ?? ""]) {
			try {
				parsed = JSON.parse(candidate);
				break;
			} catch {
				// try the last line next
			}
		}
		if (!isRecord(parsed)) {
			throw new WorkerError("omp-failed", `omp ${args.slice(0, 2).join(" ")} exited ${exitCode} without a JSON object`);
		}
		if (parsed.ok !== true) {
			throw new WorkerError(
				typeof parsed.code === "string" ? parsed.code : "omp-failed",
				typeof parsed.message === "string" ? parsed.message : "omp command failed",
			);
		}
		return parsed;
	} finally {
		clearTimeout(timer);
	}
}

/** True while another omp process owns the session (a lease is held or its state is unknown). */
async function leaseHeld(rt: Runtime, sessionId: string): Promise<boolean> {
	const report = await runOmpLease(rt, sessionId);
	return report.held.includes(sessionId) || report.unknown.includes(sessionId);
}

/** `omp session lease` prints `{ held, unknown }` without an `ok` field. */
async function runOmpLease(rt: Runtime, sessionId: string): Promise<{ held: string[]; unknown: string[] }> {
	const bin = resolveOmpBin(rt);
	const proc = Bun.spawn([bin, "session", "lease", "--json", "--", sessionId], {
		env: stringEnv(rt.env),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const text = (await new Response(proc.stdout).text()).trim();
	await proc.exited;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.split("\n").at(-1) ?? "");
	} catch {
		throw new WorkerError("omp-failed", "omp session lease returned no JSON");
	}
	if (!isRecord(parsed)) throw new WorkerError("omp-failed", "omp session lease returned no JSON object");
	const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
	return { held: list(parsed.held), unknown: list(parsed.unknown) };
}

async function sessionIsLive(rt: Runtime, session: SessionFacts): Promise<boolean> {
	if (session.pid !== undefined && pidAlive(session.pid)) return true;
	return leaseHeld(rt, session.sessionId);
}

/** Departure markers are `session-transfer` custom messages appended at the end of the journal. */
async function hasDepartureMarker(sessionFile: string, operationId: string): Promise<boolean> {
	const handle = await fs.open(sessionFile, "r");
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, 512 * 1024);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		for (const line of buffer.toString("utf8").split("\n")) {
			if (!line.includes("departed") || !line.includes(operationId)) continue;
			try {
				const entry: unknown = JSON.parse(line);
				const details = isRecord(entry) ? entry.details : undefined;
				if (isRecord(details) && details.kind === "departed" && details.operationId === operationId) return true;
			} catch {
				// a partial first line of the window
			}
		}
		return false;
	} finally {
		await handle.close();
	}
}

// ---------------------------------------------------------------------------
// Destination helper

interface StagingPaths {
	stagingRoot: string;
	archivePath: string;
	projectStaging: string;
	undoDir: string;
}

function within(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root.replace(/\/+$/, "")}/`);
}

function replyString(reply: Record<string, unknown>, key: string): string {
	const value = reply[key];
	if (typeof value !== "string") throw new HelperFailure("bad-reply", `helper reply lacks ${key}`);
	return value;
}

function replyBool(reply: Record<string, unknown>, key: string): boolean {
	const value = reply[key];
	if (typeof value !== "boolean") throw new HelperFailure("bad-reply", `helper reply lacks ${key}`);
	return value;
}

function replyAbsolutePath(reply: Record<string, unknown>, key: string): string {
	const value = replyString(reply, key);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\x00-\x1f\x7f]/.test(value)) {
		throw new HelperFailure("bad-reply", `helper reply has an invalid ${key}`);
	}
	return value;
}

interface HelperHello {
	home: string;
	hostId: string;
	ompBin: string | null;
	ompVersion: string | null;
	ompc: string | null;
	rsync: boolean;
	freeBytes: number | null;
	transferProtocol: number;
}

interface HelperInspect {
	resolvedProject: string;
	exists: boolean;
	isDirectory: boolean;
	manifest?: TreeManifest;
	gitDirty: boolean | null;
	knownUsers: string[];
	session: { existsLocally: boolean; sessionFile: string | null; reservation: unknown; replayable: boolean };
	/** Helper journal directory and destination project share a filesystem; null when the helper does not say. */
	stagingSameFilesystem: boolean | null;
}

/** One destination, reached through the configured ssh helper command. */
class Target {
	constructor(
		readonly rt: Runtime,
		readonly name: string,
		readonly config: DestinationConfig,
	) {}

	/**
	 * Calls one helper op. Idempotent ops pass `retry` to survive a dropped connection. A transport
	 * failure raises `TargetUnreachable`; a helper-reported failure raises `HelperFailure`.
	 */
	async call(
		op: string,
		fields: Record<string, unknown> = {},
		options: { retry?: boolean; mutating?: boolean; signal?: AbortSignal } = {},
	): Promise<Record<string, unknown>> {
		const { timing } = this.rt;
		const attempts = options.retry ? timing.helperRetries + 1 : 1;
		const timeoutMs = LONG_HELPER_OPS.has(op) ? timing.helperLongTimeoutMs : timing.helperTimeoutMs;
		const busyDeadline = Date.now() + timing.opBusyWaitMs;
		for (let attempt = 1; ; attempt++) {
			try {
				const reply = await callHelper(this.config, { op, ...fields }, { env: this.rt.env, timeoutMs, signal: options.signal });
				if (!reply.ok) {
					if (reply.code === "op-busy") {
						// The destination is still running an earlier invocation of this operation; wait for it, never race it.
						if (Date.now() > busyDeadline) throw new HelperFailure("op-busy", `the destination is still busy with ${op}`);
						await sleep(timing.opBusyPollMs);
						attempt--;
						continue;
					}
					throw new HelperFailure(reply.code, reply.message);
				}
				return reply;
			} catch (error) {
				if (!(error instanceof SshError)) throw error;
				if (error.code === "aborted") throw new CancelledError(`helper ${op}`);
				if (error.code === "invalid-config") throw new WorkerError("invalid-config", error.message);
				if (error.code === "bad-reply") throw new HelperFailure("bad-reply", error.message);
				if (error.retryable && attempt < attempts) {
					await sleep(timing.helperBackoffMs * attempt);
					// A mutating op may still be running on the destination: look at its status first, and
					// re-send only afterwards (the helper answers op-busy while the first call runs).
					if (options.mutating && typeof fields.operationId === "string") {
						await this.call("status", { operationId: fields.operationId }).catch(() => undefined);
					}
					continue;
				}
				if (error.retryable || error.code === "spawn-failed") throw new TargetUnreachable(error.message);
				throw new HelperFailure("helper-failed", error.message);
			}
		}
	}

	async hello(): Promise<HelperHello> {
		const reply = await this.call("hello", {}, { retry: true });
		const nullableString = (key: string): string | null => {
			const value = reply[key];
			if (value !== null && typeof value !== "string") throw new HelperFailure("bad-reply", `helper reply has an invalid ${key}`);
			return value;
		};
		const freeBytes = reply.freeBytes;
		if (freeBytes !== null && (typeof freeBytes !== "number" || !Number.isFinite(freeBytes) || freeBytes < 0)) {
			throw new HelperFailure("bad-reply", "helper reply has an invalid freeBytes");
		}
		if (typeof reply.transferProtocol !== "number") throw new HelperFailure("bad-reply", "helper reply lacks transferProtocol");
		return {
			home: replyAbsolutePath(reply, "home"),
			hostId: replyString(reply, "hostId"),
			ompBin: nullableString("ompBin"),
			ompVersion: nullableString("ompVersion"),
			ompc: nullableString("ompc"),
			rsync: replyBool(reply, "rsync"),
			freeBytes,
			transferProtocol: reply.transferProtocol,
		};
	}

	async inspect(projectPath: string, home: string, sessionId: string): Promise<HelperInspect> {
		const policy = resolveDestinationPolicy(this.config, home);
		const reply = await this.call("inspect", { projectPath, policy, exclude: DEFAULT_EXCLUDES, sessionId }, { retry: true });
		const exists = replyBool(reply, "exists");
		const isDirectory = replyBool(reply, "isDirectory");
		const session = reply.session;
		if (!isRecord(session) || typeof session.existsLocally !== "boolean") throw new HelperFailure("bad-reply", "helper reply has an invalid session");
		if (session.sessionFile !== null && typeof session.sessionFile !== "string") throw new HelperFailure("bad-reply", "helper reply has an invalid session");
		const gitDirty = reply.gitDirty;
		if (gitDirty !== null && typeof gitDirty !== "boolean") throw new HelperFailure("bad-reply", "helper reply has an invalid gitDirty");
		let manifest: TreeManifest | undefined;
		if (isDirectory) {
			const candidate = reply.manifest;
			if (!isRecord(candidate) || !Array.isArray(candidate.entries)) throw new HelperFailure("bad-reply", "helper reply lacks a manifest");
			manifest = candidate as unknown as TreeManifest;
		}
		const stagingSameFilesystem = typeof reply.stagingSameFilesystem === "boolean" ? reply.stagingSameFilesystem : null;
		const users = Array.isArray(reply.knownUsers) ? reply.knownUsers.slice(0, 50) : [];
		return {
			resolvedProject: replyAbsolutePath(reply, "resolvedProject"),
			exists,
			isDirectory,
			...(manifest && { manifest }),
			gitDirty,
			knownUsers: users.map((user) =>
				isRecord(user) ? `${String(user.command ?? "process")} (pid ${String(user.pid ?? "?")})` : String(user).slice(0, 200),
			),
			stagingSameFilesystem,
			session: { existsLocally: session.existsLocally, sessionFile: session.sessionFile, reservation: session.reservation ?? null, replayable: session.replayable === true },
		};
	}

	async stageDir(operationId: string): Promise<StagingPaths> {
		const reply = await this.call("stage-dir", { operationId }, { retry: true });
		const stagingRoot = replyAbsolutePath(reply, "stagingRoot");
		const archivePath = replyAbsolutePath(reply, "archivePath");
		const projectStaging = replyAbsolutePath(reply, "projectStaging");
		const undoDir = replyAbsolutePath(reply, "undoDir");
		for (const candidate of [archivePath, projectStaging]) {
			if (!within(stagingRoot, candidate) || candidate === stagingRoot) throw new HelperFailure("bad-reply", "helper staging paths are outside the staging root");
		}
		if (!/^[A-Za-z0-9._-]{1,128}$/.test(path.basename(archivePath))) throw new HelperFailure("bad-reply", "helper archive name is not safe");
		return { stagingRoot, archivePath, projectStaging, undoDir };
	}
}

// ---------------------------------------------------------------------------
// Plan store

interface BoundFacts {
	version: 1;
	sessionId: string;
	sessionFile: string;
	sourceProject: string;
	/** SHA-256 of the journal when the session was not running at plan time, else null. */
	sourceHead: string | null;
	destination: string;
	destinationHostId: string;
	destinationHome: string;
	destinationProject: string;
	destinationExists: boolean;
	projectMode: ProjectMode;
	projectPlanDigest: string;
	archive: { missingBlobs: string[]; externalReferences: string[]; skippedSymlinks: string[]; estimated: boolean };
	destinationSession: { existsLocally: boolean; sessionFile: string | null };
}

interface StoredPlan {
	version: 1;
	planId: string;
	digest: string;
	createdAt: string;
	bound: BoundFacts;
	plan: ProjectPlan;
	preflight: Preflight;
}

const plansDir = (rt: Runtime): string => path.join(rt.journalDir, "plans");

function boundDigest(bound: BoundFacts): string {
	return sha256Hex(canonicalJson(bound));
}

async function loadStoredPlan(dir: string, planId: string): Promise<StoredPlan> {
	const raw = await readJson(path.join(dir, `${planId}.json`));
	if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.bound) || !isRecord(raw.plan) || !isRecord(raw.preflight) || typeof raw.digest !== "string") {
		throw new WorkerError("plan-missing", "the stored plan is missing or unreadable; plan again");
	}
	const stored = raw as unknown as StoredPlan;
	if (stored.planId !== planId || boundDigest(stored.bound) !== stored.digest) {
		throw new WorkerError("plan-invalid", "the stored plan does not match its digest; plan again");
	}
	return stored;
}

async function pruneOldPlans(rt: Runtime): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(plansDir(rt));
	} catch {
		return;
	}
	const cutoff = Date.now() - MAX_PLAN_AGE_MS;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(plansDir(rt), name);
		const stat = await fs.stat(file).catch(() => undefined);
		if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true }).catch(() => undefined);
	}
}

async function loadDestination(rt: Runtime, name: string): Promise<Target> {
	const config = await loadTransferConfig(rt.configPath, { home: rt.home, env: rt.env });
	return new Target(rt, name, getDestination(config, name));
}

/** Maps the session project below the source home to the same relative path below the destination home. */
async function mapProject(rt: Runtime, cwd: string, destinationHome: string, override: string | undefined): Promise<{ sourceProject: string; destinationProject: string }> {
	const attempts: [string, string][] = [[path.resolve(cwd), path.resolve(rt.home)]];
	try {
		attempts.push([await fs.realpath(cwd), await fs.realpath(rt.home)]);
	} catch {
		// a missing project is reported by the manifest step
	}
	let failure: unknown;
	for (const [project, home] of attempts) {
		try {
			return { sourceProject: project, destinationProject: resolveDestinationProject(project, home, destinationHome, override) };
		} catch (error) {
			failure ??= error;
		}
	}
	throw failure;
}

async function sourceHead(file: string): Promise<string> {
	return sha256File(file);
}

interface ArchiveFacts {
	children: number;
	bytes: number;
	missingBlobs: string[];
	skippedSymlinks: string[];
	externalReferences: string[];
	estimated: boolean;
}

/** Sizes and child journals from the files, for a session whose owner is still running. */
async function estimateArchive(sessionFile: string): Promise<ArchiveFacts> {
	const facts: ArchiveFacts = { children: 0, bytes: (await fs.stat(sessionFile)).size, missingBlobs: [], skippedSymlinks: [], externalReferences: [], estimated: true };
	const artifacts = sessionFile.replace(/\.jsonl$/, "");
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) facts.skippedSymlinks.push(full);
			else if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) {
				facts.bytes += (await fs.stat(full)).size;
				if (entry.name.endsWith(".jsonl")) facts.children++;
			}
		}
	};
	if (artifacts !== sessionFile) await walk(artifacts);
	facts.skippedSymlinks.sort();
	return facts;
}

/** A real pack into a temporary directory, only to read its report; the session must not be running. */
async function packForReport(rt: Runtime, session: SessionFacts): Promise<ArchiveFacts> {
	await fs.mkdir(plansDir(rt), { recursive: true, mode: 0o700 });
	const dir = await fs.mkdtemp(path.join(plansDir(rt), "pack-"));
	try {
		const result = await runOmp(rt, ["session", "pack", session.sessionFile, "-o", path.join(dir, "preview.tar"), "--json"]);
		return parsePackResult(result, session.sessionId, false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new WorkerError("omp-bad-output", `pack result has an invalid ${label}`);
	return [...(value as string[])].sort();
}

function parsePackResult(result: Record<string, unknown>, sessionId: string, requireArchive: boolean): ArchiveFacts & { archivePath: string } {
	if (result.id !== sessionId) throw new WorkerError("omp-bad-output", "pack result names a different session");
	if (requireArchive && typeof result.archivePath !== "string") throw new WorkerError("omp-bad-output", "pack result lacks archivePath");
	const count = (value: unknown, label: string): number => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new WorkerError("omp-bad-output", `pack result has an invalid ${label}`);
		return value;
	};
	return {
		archivePath: typeof result.archivePath === "string" ? result.archivePath : "",
		children: count(result.children, "children"),
		bytes: count(result.bytes, "bytes"),
		missingBlobs: stringArray(result.missingBlobs, "missingBlobs"),
		skippedSymlinks: stringArray(result.skippedSymlinks, "skippedSymlinks"),
		externalReferences: stringArray(result.externalReferences, "externalReferences"),
		estimated: false,
	};
}

const warningText = (warning: { kind: string; path: string }): string => `${warning.kind}: ${warning.path}`;

/**
 * Read-only preflight: maps and inspects the destination project, previews the project change,
 * reports archive completeness, and stores a plan bound to the facts it saw.
 */
export async function plan(request: PlanRequest, ctx: WorkerContext = {}): Promise<PlanResult> {
	const rt = createRuntime(ctx);
	const { session } = request;
	const target = await loadDestination(rt, request.destination);
	const hello = await target.hello();
	const blockers: string[] = [];
	const warnings: string[] = [];

	if (hello.transferProtocol !== TRANSFER_PROTOCOL) blockers.push(`destination helper speaks protocol ${hello.transferProtocol}; this worker needs ${TRANSFER_PROTOCOL}`);
	if (hello.ompBin === null) blockers.push("OMP is not installed on the destination");
	if (hello.ompc === null) blockers.push("ompc is not installed on the destination");
	if (!hello.rsync) blockers.push("rsync is not installed on the destination");
	if (!Bun.which("rsync", { PATH: rt.env.PATH ?? "" })) blockers.push("rsync is not installed on this host");

	const sessionStat = await fs.stat(session.sessionFile).catch(() => undefined);
	if (!sessionStat?.isFile()) throw new WorkerError("session-missing", "the session journal does not exist");

	const { sourceProject, destinationProject } = await mapProject(rt, session.cwd, hello.home, request.destinationPath);
	const inspected = await target.inspect(destinationProject, hello.home, session.sessionId);
	const projectDirectory = await fs.stat(sourceProject).catch(() => undefined);
	if (!projectDirectory?.isDirectory()) throw new WorkerError("project-missing", "the source project directory does not exist");

	let mode: ProjectMode = request.projectMode ?? (inspected.exists ? "session-only" : "create");
	if (!inspected.exists && mode !== "create") {
		blockers.push(`the destination project ${inspected.resolvedProject} does not exist; ${mode} needs an existing directory`);
	}
	if (inspected.exists && !inspected.isDirectory) blockers.push(`${inspected.resolvedProject} exists and is not a directory`);
	if (inspected.exists && mode === "create") blockers.push(`${inspected.resolvedProject} already exists; choose update or session-only`);

	let projectPlan: ProjectPlan;
	if (mode === "session-only" || (inspected.exists && !inspected.isDirectory)) {
		if (mode !== "session-only") mode = "session-only";
		projectPlan = diffManifests({ root: sourceProject, entries: [], warnings: [] }, undefined, "session-only");
	} else {
		const sourceManifest = await buildManifest(sourceProject, { exclude: DEFAULT_EXCLUDES });
		try {
			projectPlan = diffManifests(sourceManifest, mode === "update" ? inspected.manifest : undefined, mode);
		} catch (error) {
			if (!(error instanceof ProjectSyncError) || error.code !== "invalid-plan") throw error;
			blockers.push(error.message);
			projectPlan = diffManifests({ root: sourceProject, entries: [], warnings: [] }, undefined, "session-only");
		}
	}
	if (projectPlan.conflicts.length > 0) blockers.push(`${projectPlan.conflicts.length} project path(s) conflict with the destination; resolve them and plan again`);
	for (const warning of projectPlan.warnings) warnings.push(warningText(warning));
	if (mode === "update" && inspected.knownUsers.length > 0) blockers.push(`other processes use the destination project: ${inspected.knownUsers.join(", ")}`);
	if (mode === "update" && inspected.gitDirty) warnings.push("the destination working tree has uncommitted changes");
	if (inspected.session.reservation !== null) blockers.push("the destination session is reserved by another transfer");
	if (inspected.session.existsLocally) {
		const where = inspected.session.sessionFile ? ` (${inspected.session.sessionFile})` : "";
		if (mode === "create" && !inspected.session.replayable) {
			// A new project is published before the import, so a strict refusal would arrive after a project write.
			blockers.push(`the destination already holds a copy of this session${where}; remove or reconcile it before sending a new project`);
		} else {
			// The import runs before any project write here; a diverged copy is refused by the strict import, and a prior copy
			// of a returning session is replaced only when it is a prefix the import accepts.
			warnings.push(`the destination already holds a copy of this session${where}; the strict import refuses it if it diverged`);
		}
	}
	if (inspected.stagingSameFilesystem === false && mode !== "session-only") {
		blockers.push(
			"the destination project and the helper's journal directory (omp-connected/transfers under XDG_STATE_HOME or ~/.local/state) are on different filesystems; the staged project is moved into place, so the journal directory and the destination must share a filesystem",
		);
	}

	const live = await sessionIsLive(rt, session);
	let archive: ArchiveFacts;
	let head: string | null = null;
	if (live) {
		archive = await estimateArchive(session.sessionFile);
		warnings.push("the session is running; missing blobs and external references are checked after it stops");
	} else {
		head = await sourceHead(session.sessionFile);
		try {
			archive = await packForReport(rt, session);
		} catch (error) {
			if (!(error instanceof WorkerError)) throw error;
			blockers.push(`the session cannot be packed: ${error.message}`);
			archive = await estimateArchive(session.sessionFile);
		}
	}
	if (archive.missingBlobs.length > 0) warnings.push(`${archive.missingBlobs.length} referenced image blob(s) are missing and will not travel`);
	if (archive.externalReferences.length > 0) warnings.push(`${archive.externalReferences.length} path(s) in the session point outside the packed tree`);
	if (archive.skippedSymlinks.length > 0) warnings.push(`${archive.skippedSymlinks.length} artifact symlink(s) will not be packed`);

	const needed = Math.ceil((archive.bytes + (mode === "session-only" ? 0 : projectPlan.totalBytes)) * 1.1) + 64 * 1024 * 1024;
	if (hello.freeBytes !== null && hello.freeBytes < needed) blockers.push(`the destination has ${hello.freeBytes} bytes free; about ${needed} are needed`);
	const sessionReservation = await runOmp(rt, ["session", "reservation", "--json", "--", session.sessionId]).catch(() => undefined);
	if (sessionReservation && sessionReservation.reservation) blockers.push("the source session is reserved by another transfer");

	const bound: BoundFacts = {
		version: 1,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sourceProject,
		sourceHead: head,
		destination: request.destination,
		destinationHostId: hello.hostId,
		destinationHome: hello.home,
		destinationProject: inspected.resolvedProject,
		destinationExists: inspected.exists,
		projectMode: mode,
		projectPlanDigest: projectPlan.digest,
		archive: {
			missingBlobs: archive.missingBlobs,
			externalReferences: archive.externalReferences,
			skippedSymlinks: archive.skippedSymlinks,
			estimated: archive.estimated,
		},
		destinationSession: { existsLocally: inspected.session.existsLocally, sessionFile: inspected.session.sessionFile },
	};
	const digest = boundDigest(bound);
	const planId = randomBytes(16).toString("hex");
	const preflight: Preflight = {
		sessionId: session.sessionId,
		title: session.title ?? null,
		launcherName: session.launcherName ?? null,
		sourceProject,
		destinationProject: inspected.resolvedProject,
		destinationExists: inspected.exists,
		destinationHostId: hello.hostId,
		destinationHome: hello.home,
		projectMode: mode,
		live,
		children: archive.children,
		archiveBytes: archive.bytes,
		archiveEstimated: archive.estimated,
		missingBlobs: archive.missingBlobs,
		externalReferences: archive.externalReferences,
		skippedSymlinks: archive.skippedSymlinks,
		acceptIncompleteRequired: archive.missingBlobs.length > 0 || archive.externalReferences.length > 0,
		gitDirty: inspected.gitDirty,
		knownUsers: inspected.knownUsers,
		warnings,
		blockers,
		runtimeVersion: hello.ompVersion,
		runtimeCompatible: hello.transferProtocol === TRANSFER_PROTOCOL && hello.ompBin !== null,
		freeBytes: hello.freeBytes,
		destinationSession: bound.destinationSession,
		stagingSameFilesystem: inspected.stagingSameFilesystem,
	};
	const stored: StoredPlan = { version: 1, planId, digest, createdAt: new Date().toISOString(), bound, plan: projectPlan, preflight };
	await writePrivateJson(path.join(plansDir(rt), `${planId}.json`), stored);
	await pruneOldPlans(rt);
	return { planId, digest, plan: projectPlan, preflight };
}

// ---------------------------------------------------------------------------
// Operation state on the source

interface Progress {
	sourceReserved?: boolean;
	destinationReserved?: boolean;
	/** The session process was running when the operation started. */
	live?: boolean;
	/** The owner acknowledged the stop (or is gone); the source can no longer simply continue. */
	sourceStopped?: boolean;
	staging?: StagingPaths;
	archive?: { missingBlobs: string[]; externalReferences: string[]; skippedSymlinks: string[]; children: number; bytes: number };
	cancelRequested?: boolean;
	/** The project change was undone; the run must not continue. */
	restored?: boolean;
	imported?: { sessionFile: string; mode: string };
	nonce?: string;
	/** The source reservation could not be released; the operation must not end terminal until it is. */
	sourceReleasePending?: boolean;
}

interface Operation {
	rt: Runtime;
	request: RunRequest;
	opDir: string;
	stored?: StoredPlan;
	planError?: WorkerError;
	target: Target;
	hub: HubTransferClient;
}

async function readProgress(dir: string): Promise<Progress> {
	const raw = await readJson(path.join(dir, "progress.json"));
	// A private file this worker wrote; unknown fields are ignored.
	return isRecord(raw) ? (raw as Progress) : {};
}

async function loadOperation(rt: Runtime, operationId: string): Promise<Operation> {
	if (!OPERATION_ID_PATTERN.test(operationId)) throw new WorkerError("invalid-request", "invalid operation id");
	const opDir = path.join(rt.journalDir, operationId);
	const raw = await readJson(path.join(opDir, "request.json"));
	if (raw === undefined) throw new WorkerError("request-missing", `no request file for operation ${operationId}`);
	const request = parseRunRequest(raw);
	if (request.operationId !== operationId) throw new WorkerError("invalid-request", "request.json names a different operation");
	let stored: StoredPlan | undefined;
	let planError: WorkerError | undefined;
	try {
		// The operation keeps its own copy so pruning the plan store cannot break a late recovery.
		stored = existsSync(path.join(opDir, `${request.planId}.json`))
			? await loadStoredPlan(opDir, request.planId)
			: await loadStoredPlan(plansDir(rt), request.planId);
		if (!existsSync(path.join(opDir, `${request.planId}.json`))) await writePrivateJson(path.join(opDir, `${request.planId}.json`), stored);
	} catch (error) {
		planError = error instanceof WorkerError ? error : new WorkerError("plan-missing", errorInfo(error).message);
	}
	const hub =
		rt.ctx.hub ??
		(request.hubUrl && request.token && request.renewalSecret
			? createHubClient({
					hubUrl: request.hubUrl,
					operationId,
					token: request.token,
					renewalSecret: request.renewalSecret,
					fetch: rt.ctx.fetch,
					log: rt.log,
				})
			: createNoopHubClient());
	return { rt, request, opDir, stored, planError, target: await loadDestination(rt, request.destination), hub };
}

const BEFORE_DEPARTURE: readonly TransferState[] = ["prepared", "source-stopping", "source-stopped", "staged", "publishing"];
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function clip(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) : text;
}

/** One operation's pipeline. All durable decisions go through the journal first, then the hub. */
class TransferRun {
	readonly #op: Operation;
	readonly #rt: Runtime;
	readonly #hub: HubTransferClient;
	readonly #target: Target;
	readonly #request: RunRequest;
	readonly #awaitRecovery: boolean;
	#progress: Progress = {};
	#state: TransferState = "prepared";
	#destinationStarted = false;
	#pollQueue: Promise<void> = Promise.resolve();
	#interrupt: AbortController | undefined;
	readonly #handled = new Set<number>();

	constructor(op: Operation) {
		this.#op = op;
		this.#rt = op.rt;
		this.#hub = op.hub;
		this.#target = op.target;
		this.#request = op.request;
		this.#awaitRecovery = op.rt.ctx.awaitRecovery ?? op.hub.enabled;
	}

	async init(): Promise<void> {
		this.#progress = await readProgress(this.#op.opDir);
		const record = await this.#rt.journal.load(this.#request.operationId);
		if (record) this.#adopt(record.state);
	}

	#adopt(state: TransferState): void {
		this.#state = state;
		this.#destinationStarted = state === "destination-starting" || state === "completed";
	}

	get #id(): string {
		return this.#request.operationId;
	}

	#bound(): BoundFacts {
		return this.#plan().bound;
	}

	#plan(): StoredPlan {
		if (!this.#op.stored) throw this.#op.planError ?? new WorkerError("plan-missing", "the stored plan is missing");
		return this.#op.stored;
	}

	// ----- durable state

	async #saveProgress(patch: Partial<Progress>): Promise<void> {
		this.#progress = { ...this.#progress, ...patch };
		await writePrivateJson(path.join(this.#op.opDir, "progress.json"), this.#progress);
	}

	async #load(): Promise<OperationRecord> {
		const record = await this.#rt.journal.load(this.#id);
		if (!record) throw new WorkerError("not-found", `operation ${this.#id} has no journal record`);
		this.#adopt(record.state);
		return record;
	}

	async #ensureRecord(): Promise<OperationRecord> {
		const existing = await this.#rt.journal.load(this.#id);
		if (existing) {
			this.#adopt(existing.state);
			return existing;
		}
		const bound = this.#op.stored?.bound;
		const record = await this.#rt.journal.create({
			operationId: this.#id,
			role: "source",
			sessionId: this.#request.session.sessionId,
			planDigest: this.#request.planDigest,
			projectMode: this.#request.projectMode,
			destinationName: this.#request.destination,
			...(bound && { sourceProject: bound.sourceProject, destinationProject: bound.destinationProject }),
			...(this.#request.session.title !== undefined && { sessionName: this.#request.session.title }),
		});
		await this.#hub.event({ state: "prepared", detail: "worker started" });
		return record;
	}

	async #transition(to: TransferState, detail?: string, error?: { code: string; message: string }, progress?: Record<string, unknown>): Promise<void> {
		await this.#rt.journal.transition(this.#id, to, detail);
		this.#adopt(to);
		this.#rt.log(`state ${to}${detail ? ` (${detail})` : ""}`);
		if (error) await this.#rt.journal.fail(this.#id, error);
		await this.#hub.event({
			state: to,
			...(detail !== undefined && { detail: clip(detail, 500) }),
			...(error && { error: { code: clip(error.code, 100), message: clip(error.message, 1000) } }),
			...(progress && { progress }),
		});
		const seam = this.#rt.ctx.afterTransition;
		if (seam) {
			try {
				await seam(to);
			} catch (hookError) {
				throw new CrashSignal(hookError instanceof Error ? hookError.message : String(hookError));
			}
		}
	}

	/** Records an error against the current state; the state and last confirmed state do not move. */
	async #recordError(error: { code: string; message: string }): Promise<void> {
		const record = await this.#rt.journal.fail(this.#id, { code: clip(error.code, 100), message: clip(error.message, 1000) });
		this.#adopt(record.state);
		this.#rt.log(`error ${error.code}: ${error.message}`);
		await this.#hub.event({ state: record.state, error: { code: clip(error.code, 100), message: clip(error.message, 1000) } });
	}

	async #phase(phase: string, extra: Record<string, unknown> = {}): Promise<void> {
		this.#rt.log(`phase ${phase}`);
		await this.#hub.event({ state: this.#state, progress: { phase, ...extra } });
	}

	// ----- hub commands and cancellation

	pollHub(): Promise<void> {
		const next = this.#pollQueue.then(() => this.#pollOnce());
		this.#pollQueue = next.catch(() => undefined);
		return next;
	}

	/** Commands are applied in order, one poll at a time. */
	async #pollOnce(): Promise<void> {
		const commands: HubCommand[] = await this.#hub.commands();
		for (const command of commands) {
			if (this.#handled.has(command.seq)) continue;
			this.#handled.add(command.seq);
			if (command.type === "cancel") {
				if (this.#destinationStarted) {
					this.#rt.log("cancel ignored: the destination already started; return the session with a reverse transfer");
				} else {
					await this.#saveProgress({ cancelRequested: true });
					this.#interrupt?.abort();
				}
			} else if (RECOVER_ACTIONS.includes(command.payload.action as RecoverAction)) {
				// Persisted before the hub is told it was received, so a crash cannot lose the request.
				const name = `hub-${String(command.seq).padStart(12, "0")}.json`;
				await writePrivateJson(path.join(this.#op.opDir, RECOVER_DIR, name), { action: command.payload.action, seq: command.seq });
			}
			await this.#hub.ack(command.seq);
		}
	}

	async #boundary(name: string): Promise<void> {
		await this.pollHub();
		if (this.#progress.cancelRequested) throw new CancelledError(name);
	}

	/** Runs `fn` with a signal that a cancel command aborts. */
	async #interruptible<T>(name: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
		await this.#boundary(name);
		const controller = new AbortController();
		this.#interrupt = controller;
		try {
			return await fn(controller.signal);
		} catch (error) {
			if (controller.signal.aborted && this.#progress.cancelRequested) throw new CancelledError(name);
			throw error;
		} finally {
			this.#interrupt = undefined;
		}
	}

	// ----- source side omp

	async #reserveSource(): Promise<void> {
		await runOmp(this.#rt, ["session", "reserve", "--operation", this.#id, "--role", "source", "--json", "--", this.#request.session.sessionId]);
		if (!this.#progress.sourceReserved) await this.#saveProgress({ sourceReserved: true });
	}

	async #releaseSource(): Promise<void> {
		await runOmp(this.#rt, ["session", "release", "--operation", this.#id, "--json", "--", this.#request.session.sessionId]);
	}

	// ----- the run

	async execute(): Promise<RunOutcome> {
		const timer = setInterval(() => void this.pollHub().catch(() => undefined), this.#rt.timing.commandPollMs);
		timer.unref?.();
		try {
			await this.#ensureRecord();
			await this.#drive();
			if (this.#awaitRecovery) await this.#waitForRecovery();
		} finally {
			clearInterval(timer);
		}
		return this.finish();
	}

	/** Reports the outcome; a terminal operation also revokes the hub renewal secret. */
	async finish(): Promise<RunOutcome> {
		const record = await this.#load();
		if (isTerminalState(record.state)) await this.#hub.finish();
		return {
			operationId: this.#id,
			state: record.state,
			...(record.error && { error: { code: record.error.code, message: record.error.message } }),
		};
	}

	async #drive(): Promise<void> {
		try {
			await this.#advance();
		} catch (error) {
			if (error instanceof CrashSignal) throw error;
			await this.#handleFailure(error);
		}
	}

	async #advance(): Promise<void> {
		for (;;) {
			const record = await this.#load();
			if (isTerminalState(record.state)) return;
			if (this.#progress.restored && (BEFORE_DEPARTURE.includes(record.state) || record.state === "source-departed")) {
				throw new WorkerError("project-restored", "the project change was restored; roll back the source session");
			}
			if (this.#progress.cancelRequested && record.state !== "destination-starting" && record.state !== "aborting") {
				throw new CancelledError("resume");
			}
			switch (record.state) {
				case "prepared":
					await this.#prepare();
					break;
				case "source-stopping":
					await this.#stopSource();
					break;
				case "source-stopped":
					await this.#stage();
					break;
				case "staged":
					await this.#boundary("before publication");
					await this.#transition("publishing", "publishing project and session");
					break;
				case "publishing":
					await this.#publish();
					break;
				case "source-departed":
					await this.#launch();
					break;
				case "destination-starting":
					await this.#awaitArrival();
					break;
				case "aborting":
					await this.#rollbackSource();
					return;
				default:
					throw new WorkerError("bad-state", `unexpected state ${record.state}`);
			}
		}
	}

	// ----- prepared: recheck the plan, reserve both sides

	async #prepare(): Promise<void> {
		await this.#boundary("before commit");
		const stored = this.#plan();
		const { bound } = stored;
		const request = this.#request;
		if (stored.digest !== request.planDigest) throw new WorkerError("plan-mismatch", "the stored plan does not match the confirmed digest");
		if (bound.projectMode !== request.projectMode) throw new WorkerError("plan-mismatch", "the project mode differs from the plan");
		if (bound.sessionId !== request.session.sessionId || bound.sessionFile !== request.session.sessionFile) {
			throw new WorkerError("plan-mismatch", "the plan was made for a different session");
		}
		if (stored.preflight.blockers.length > 0) throw new WorkerError("blocked", `the plan has blockers: ${stored.preflight.blockers.join("; ")}`);
		if (stored.plan.conflicts.length > 0) throw new WorkerError("conflicts", "the project plan has unresolved conflicts");
		if (stored.preflight.acceptIncompleteRequired && !request.acceptIncomplete) {
			throw new WorkerError("incomplete-not-accepted", "the archive is incomplete and the plan was not confirmed as incomplete");
		}
		await this.#recheckFacts(bound);
		const title = request.session.title;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
		const safeTitle = title !== undefined && !/[\x00-\x1f\x7f]/.test(title) ? title : undefined;
		await this.#reserveSource();
		// Recorded before the call: a lost reply must still lead to a rollback request.
		await this.#saveProgress({ destinationReserved: true });
		await this.#target.call(
			"reserve",
			{
				operationId: this.#id,
				sessionId: request.session.sessionId,
				planDigest: request.planDigest,
				projectMode: bound.projectMode,
				destinationProject: bound.destinationProject,
				policy: resolveDestinationPolicy(this.#target.config, bound.destinationHome),
				destinationName: request.destination,
				...(safeTitle !== undefined && { sessionName: safeTitle }),
			},
			{ retry: true },
		);
		const staging = this.#progress.staging ?? (await this.#target.stageDir(this.#id));
		const live = await sessionIsLive(this.#rt, request.session);
		await this.#saveProgress({ staging, live });
		await this.#transition("source-stopping", live ? "stopping the running session" : "session not running");
	}

	/** Fails when anything the confirmed plan depended on changed. */
	async #recheckFacts(bound: BoundFacts): Promise<void> {
		const hello = await this.#target.hello();
		if (hello.hostId !== bound.destinationHostId || hello.home !== bound.destinationHome || hello.transferProtocol !== TRANSFER_PROTOCOL) {
			throw new WorkerError("destination-changed", "the destination host identity changed since the plan");
		}
		const inspected = await this.#target.inspect(bound.destinationProject, hello.home, bound.sessionId);
		const held = inspected.session.reservation;
		const ours = isRecord(held) && held.operationId === this.#id;
		if (
			inspected.resolvedProject !== bound.destinationProject ||
			inspected.exists !== bound.destinationExists ||
			inspected.session.existsLocally !== bound.destinationSession.existsLocally ||
			inspected.session.sessionFile !== bound.destinationSession.sessionFile ||
			(inspected.stagingSameFilesystem === false && bound.projectMode !== "session-only")
		) {
			throw new WorkerError("destination-changed", "the destination project or session changed since the plan");
		}
		if (held !== null && !ours) throw new WorkerError("destination-reserved", "the destination session is reserved by another transfer");
		if (bound.projectMode === "update" && inspected.knownUsers.length > 0) {
			throw new WorkerError("destination-busy", `other processes use the destination project: ${inspected.knownUsers.join(", ")}`);
		}
		await this.#verifyProject(bound, inspected);
		if (bound.sourceHead !== null) {
			if (await sessionIsLive(this.#rt, this.#request.session)) throw new WorkerError("source-changed", "the session started running after the plan was made");
			if ((await sourceHead(bound.sessionFile)) !== bound.sourceHead) throw new WorkerError("source-changed", "the session changed after the plan was made");
		}
	}

	/** The source tree and the destination tree still produce the confirmed project plan. */
	async #verifyProject(bound: BoundFacts, inspected: HelperInspect): Promise<void> {
		if (bound.projectMode === "session-only") return;
		const source = await buildManifest(bound.sourceProject, { exclude: DEFAULT_EXCLUDES });
		const current = diffManifests(source, bound.projectMode === "update" ? inspected.manifest : undefined, bound.projectMode);
		if (current.digest !== bound.projectPlanDigest) throw new WorkerError("plan-stale", "the project changed since the plan was made; plan again");
	}

	// ----- source-stopping: stop handshake with the owner

	async #readAck(): Promise<{ ok: true } | { ok: false; reasons: string[] } | undefined> {
		const raw = await readJson(path.join(this.#op.opDir, "stop-ack.json"));
		if (!isRecord(raw)) return undefined;
		if (raw.ok === true) return { ok: true };
		if (raw.ok === false) {
			const reasons = Array.isArray(raw.reasons) ? raw.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, 10) : [];
			return { ok: false, reasons };
		}
		return undefined;
	}

	async #stopSource(): Promise<void> {
		const { session } = this.#request;
		if (!this.#progress.live) {
			await this.#saveProgress({ sourceStopped: true });
			await this.#transition("source-stopped", "session not running");
			return;
		}
		const pid = session.pid;
		if (pid === undefined) throw new WorkerError("no-owner-pid", "the session is running but its process id is unknown");
		if (!this.#progress.sourceStopped) {
			const requestFile = path.join(this.#op.opDir, "stop-request.json");
			const ackFile = path.join(this.#op.opDir, "stop-ack.json");
			if (!pidAlive(pid)) {
				await this.#saveProgress({ sourceStopped: true });
			} else {
				if (!existsSync(requestFile)) {
					await fs.rm(ackFile, { force: true });
					await writePrivateJson(requestFile, { operationId: this.#id, requestedAt: new Date().toISOString(), nonce: randomBytes(8).toString("hex") });
				}
				const deadline = Date.now() + this.#rt.timing.stopAckTimeoutMs;
				for (;;) {
					await this.pollHub();
					const ack = await this.#readAck();
					if (ack && !ack.ok) {
						await fs.rm(requestFile, { force: true });
						throw new WorkerError("stop-refused", `the session cannot stop now: ${ack.reasons.join("; ") || "no reason given"}`);
					}
					if (ack?.ok || !pidAlive(pid)) {
						await this.#saveProgress({ sourceStopped: true });
						break;
					}
					if (this.#progress.cancelRequested) {
						await fs.rm(requestFile, { force: true });
						throw new CancelledError("stop handshake");
					}
					if (Date.now() > deadline) {
						await fs.rm(requestFile, { force: true });
						throw new WorkerError("stop-timeout", "the session did not acknowledge the stop request");
					}
					await sleep(this.#rt.timing.pollMs);
				}
			}
		}
		const deadline = Date.now() + this.#rt.timing.pidExitTimeoutMs;
		for (;;) {
			if (!pidAlive(pid)) {
				const held = await leaseHeld(this.#rt, session.sessionId).catch(() => true);
				if (!held) break;
			}
			if (Date.now() > deadline) throw new WorkerError("stop-timeout", "the session process did not exit after the stop was acknowledged");
			await sleep(this.#rt.timing.pollMs);
		}
		await this.#transition("source-stopped", "owner exited");
	}

	// ----- source-stopped: pack and stage

	#projectFiles(): string[] {
		const { plan } = this.#plan();
		if (plan.mode === "create") return plan.entries.map((entry) => entry.path);
		if (plan.mode === "update") return plan.entries.filter((entry) => entry.action !== "mode-change" && entry.kind !== "dir").map((entry) => entry.path);
		return [];
	}

	async #stage(): Promise<void> {
		const bound = this.#bound();
		const { session } = this.#request;
		await this.#boundary("before staging");
		await this.#reserveSource();
		// Always asked again: the helper keeps this idempotent, and a cancel or cleanup may have removed the directories.
		const staging = await this.#target.stageDir(this.#id);
		await this.#saveProgress({ staging });
		if (this.#progress.live && bound.projectMode !== "session-only") {
			const hello = await this.#target.hello();
			await this.#verifyProject(bound, await this.#target.inspect(bound.destinationProject, hello.home, bound.sessionId));
		}

		const outDir = path.join(this.#op.opDir, "out");
		await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
		const archiveName = path.basename(staging.archivePath);
		const localArchive = path.join(outDir, archiveName);
		if (!this.#progress.archive || !existsSync(localArchive)) {
			await this.#phase("packing");
			let packed: Record<string, unknown> | undefined;
			for (let attempt = 1; !packed; attempt++) {
				try {
					packed = await runOmp(this.#rt, ["session", "pack", session.sessionFile, "-o", localArchive, "--operation", this.#id, "--json"]);
				} catch (error) {
					// The owner may still be releasing its lease right after exit.
					if (!(error instanceof WorkerError) || error.code !== "live-owner" || attempt >= 5) throw error;
					await sleep(this.#rt.timing.pollMs * 2);
				}
			}
			const facts = parsePackResult(packed, session.sessionId, true);
			await this.#saveProgress({
				archive: {
					missingBlobs: facts.missingBlobs,
					externalReferences: facts.externalReferences,
					skippedSymlinks: facts.skippedSymlinks,
					children: facts.children,
					bytes: facts.bytes,
				},
			});
		}
		const archive = this.#progress.archive;
		if (archive && (archive.missingBlobs.length > 0 || archive.externalReferences.length > 0) && !this.#request.acceptIncomplete) {
			throw new WorkerError(
				"incomplete-archive",
				`the archive lacks ${archive.missingBlobs.length} blob(s) and references ${archive.externalReferences.length} outside path(s); it was not accepted as incomplete`,
			);
		}

		const rsyncBase = {
			ssh: this.#target.config.ssh,
			env: this.#rt.env,
			retries: this.#rt.timing.rsyncRetries,
			// A retry after a timeout resumes from the partial files.
			timeoutMs: this.#rt.timing.helperLongTimeoutMs,
			backoffMs: this.#rt.timing.rsyncBackoffMs,
		};
		await this.#phase("transferring-archive", { bytes: archive?.bytes ?? 0 });
		const archiveList = path.join(this.#op.opDir, "archive.list");
		await fs.writeFile(archiveList, `${archiveName}\0`, { mode: 0o600 });
		await this.#interruptible("archive transfer", (signal) =>
			rsyncFiles({ ...rsyncBase, src: outDir, filesFrom: archiveList, dest: path.dirname(staging.archivePath), signal }),
		);

		const files = this.#projectFiles();
		if (files.length > 0) {
			await this.#phase("transferring-project", { files: files.length });
			const projectList = path.join(this.#op.opDir, "project.list");
			await fs.writeFile(projectList, `${files.join("\0")}\0`, { mode: 0o600 });
			await this.#interruptible("project transfer", (signal) =>
				rsyncFiles({ ...rsyncBase, src: bound.sourceProject, filesFrom: projectList, dest: staging.projectStaging, signal }),
			);
		}
		await this.#transition("staged", "archive and project data staged");
	}

	// ----- publishing: project, import, departure marker

	async #publish(): Promise<void> {
		const bound = this.#bound();
		const { session } = this.#request;
		// `omp session unpack` needs the destination directory, so a new project is published first. Otherwise
		// the import runs first: a divergent or prefix refusal then arrives before any project write.
		const importFirst = bound.projectMode !== "create";
		if (importFirst) {
			await this.#boundary("before session import");
			await this.#importSession();
		}
		await this.#boundary("before project publication");
		await this.#publishProject();
		if (!importFirst) {
			await this.#boundary("before session import");
			await this.#importSession();
		}
		await this.#boundary("before departure marker");
		if (!(await hasDepartureMarker(session.sessionFile, this.#id))) {
			await runOmp(this.#rt, ["session", "moved", session.sessionFile, "--label", this.#target.config.hostId, "--operation", this.#id, "--json"]);
		}
		if (!(await hasDepartureMarker(session.sessionFile, this.#id))) {
			throw new WorkerError("departure-unverified", "the departure marker was not found after recording it; the destination stays blocked");
		}
		await this.#transition("source-departed", "departure marker recorded");
	}

	async #publishProject(): Promise<void> {
		const bound = this.#bound();
		await this.#phase("publishing-project");
		await this.#target.call(
			"publish-project",
			{
				operationId: this.#id,
				mode: bound.projectMode,
				destRoot: bound.destinationProject,
				policy: resolveDestinationPolicy(this.#target.config, bound.destinationHome),
				planDigest: this.#request.planDigest,
				...(bound.projectMode !== "session-only" && { plan: this.#plan().plan }),
			},
			{ retry: true, mutating: true },
		);
	}

	async #importSession(): Promise<void> {
		if (this.#progress.imported) return;
		await this.#phase("importing-session");
		const reply = await this.#target.call(
			"import-session",
			{ operationId: this.#id, sessionId: this.#request.session.sessionId, cwd: this.#bound().destinationProject },
			{ retry: true, mutating: true },
		);
		const sessionFile = replyAbsolutePath(reply, "sessionFile");
		const mode = replyString(reply, "mode");
		if (!sessionFile.endsWith(".jsonl")) throw new HelperFailure("bad-reply", "the imported session file is not a journal");
		// A strict import without allowPrefixReplace only reports 'replaced' for the departed-marker exception of a return transfer.
		if (mode !== "created" && mode !== "replayed" && mode !== "replaced") throw new WorkerError("import-mode", `the import ended as '${mode}', not a plain create`);
		await this.#saveProgress({ imported: { sessionFile, mode } });
	}

	// ----- source-departed: launch; destination-starting: verify arrival

	/** The ompc session suffix for the destination; the helper requires a plain, non-empty name. */
	#launchName(): string {
		const { session } = this.#request;
		const base = path.basename(this.#bound().sourceProject);
		let name = session.launcherName ?? "";
		if (name.startsWith(`${base}.`)) name = name.slice(base.length + 1);
		else if (name === base) name = "";
		if (NAME_PATTERN.test(name)) return name;
		const fromTitle = (session.title ?? "").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
		return NAME_PATTERN.test(fromTitle) ? fromTitle : "sent";
	}

	async #launch(): Promise<void> {
		const bound = this.#bound();
		const imported = this.#progress.imported;
		if (!imported) throw new WorkerError("not-imported", "no imported session is recorded for this operation");
		let nonce = this.#progress.nonce;
		if (!nonce) {
			nonce = randomBytes(16).toString("hex");
			await this.#saveProgress({ nonce });
		}
		await this.#rt.journal.recordLaunchIntent(this.#id, nonce);
		await this.#boundary("before launch");
		const status = await this.#target.call("status", { operationId: this.#id }, { retry: true });
		const launch = isRecord(status.launch) ? status.launch : undefined;
		if (launch?.status === "cancelled") throw new WorkerError("launch-cancelled", "the destination launch intent was cancelled");
		// A consumed intent whose spawn the helper recorded as failed started nothing; the same nonce may launch again.
		let started = launch?.status === "consumed" && status.launchFailed !== true;
		if (!started) {
			await this.#phase("launching");
			try {
				await this.#target.call("launch", {
					operationId: this.#id,
					sessionFile: imported.sessionFile,
					cwd: bound.destinationProject,
					name: this.#launchName(),
					nonce,
				});
				started = true;
			} catch (error) {
				if (error instanceof HelperFailure && error.code === "project-restored") {
					await this.#saveProgress({ restored: true });
					throw new WorkerError("project-restored", "the destination refused the launch because the project change was restored; roll back the source session");
				}
				if (!(error instanceof TargetUnreachable)) throw error;
				// The reply may have been lost after the helper spawned; ask before deciding anything.
				const after = await this.#target.call("status", { operationId: this.#id }, { retry: true }).catch(() => undefined);
				if (isRecord(after?.launch) && after.launch.status === "consumed" && after.launchFailed !== true) started = true;
				else throw new WorkerError("launch-uncertain", `the launch reply was lost (${error.message}); the destination was not confirmed`);
			}
		}
		await this.#transition("destination-starting", "destination launch requested");
		await this.#rt.journal.consumeLaunchIntent(this.#id, nonce);
	}

	async #awaitArrival(): Promise<void> {
		const bound = this.#bound();
		const nonce = this.#progress.nonce;
		if (!nonce) throw new WorkerError("no-nonce", "no launch nonce is recorded for this operation");
		const deadline = Date.now() + this.#rt.timing.arrivalTimeoutMs;
		let arrival: Record<string, unknown> | undefined;
		let reason = "";
		while (!arrival) {
			const reply = await this.#target.call(
				"verify-arrival",
				{ operationId: this.#id, nonce, sessionId: this.#request.session.sessionId, cwd: bound.destinationProject },
				{ retry: true },
			);
			if (reply.arrived === true) {
				// The host that registered must be the destination this plan named (hello identity or its configured label).
				const claimed = typeof reply.hostId === "string" ? reply.hostId : null;
				if (claimed === bound.destinationHostId || claimed === this.#target.config.hostId) arrival = reply;
				else reason = "host-mismatch";
			} else {
				reason = typeof reply.reason === "string" ? reply.reason : "";
			}
			if (!arrival) {
				if (Date.now() > deadline) throw new WorkerError("arrival-timeout", `the destination did not register in time${reason ? ` (${reason})` : ""}`);
				await this.pollHub();
				await sleep(this.#rt.timing.arrivalPollMs);
			}
		}
		const label = typeof arrival.label === "string" ? clip(arrival.label, 200) : null;
		const hostId = typeof arrival.hostId === "string" ? clip(arrival.hostId, 200) : null;
		// The session may already have exited; it still arrived under this operation's nonce.
		const exited = arrival.exited === true;
		await this.#target.call("release", { operationId: this.#id }, { retry: true });
		if (!(await this.#releaseSourceOrPend())) {
			throw new WorkerError("source-release-pending", "the destination arrived but the source reservation could not be released; retry-launch repeats the release");
		}
		await this.#transition(
			"completed",
			`arrived on ${hostId ?? "the destination"}${label ? ` as ${label}` : ""}${exited ? " (the session had already exited)" : ""}`,
			undefined,
			{ label, hostId, ...(exited && { exited }) },
		);
		await this.#target.call("cleanup", { operationId: this.#id }, { retry: true }).catch((error) => this.#rt.log(`cleanup failed: ${errorInfo(error).message}`));
		await fs.rm(path.join(this.#op.opDir, "out"), { recursive: true, force: true }).catch(() => undefined);
	}

	// ----- failure, cancel, abort

	async #handleFailure(error: unknown): Promise<void> {
		const record = await this.#load();
		if (error instanceof CancelledError) {
			await this.#handleCancel(record, error);
			return;
		}
		const info = errorInfo(error);
		if (this.#neverStopped(record)) {
			await this.#abortBeforeStop(info);
			return;
		}
		await this.#recordError(info);
	}

	/** True while the source session can still simply continue: nothing was stopped. */
	#neverStopped(record: OperationRecord): boolean {
		return (record.state === "prepared" || record.state === "source-stopping") && !this.#progress.sourceStopped;
	}

	async #handleCancel(record: OperationRecord, error: CancelledError): Promise<void> {
		if (this.#neverStopped(record)) {
			await this.#abortBeforeStop({ code: "cancelled", message: "cancelled before the source stopped" });
			return;
		}
		if (record.state === "source-stopped" || record.state === "staged") {
			await this.#target.call("cleanup", { operationId: this.#id }, { retry: true }).catch((cleanupError) => this.#rt.log(`staging cleanup failed: ${errorInfo(cleanupError).message}`));
			await fs.rm(path.join(this.#op.opDir, "out"), { recursive: true, force: true }).catch(() => undefined);
			await this.#recordError({ code: "cancelled", message: "cancelled before publication; staging was removed. Roll back the source to resume it" });
			return;
		}
		await this.#recordError({
			code: "cancelled",
			message: `stopped at a safe boundary (${error.boundary}); recover with resume, retry-launch or rollback-source`,
		});
	}

	/** The source never stopped: unfence it, undo the destination reservation, end `rolled-back`. */
	async #abortBeforeStop(info: { code: string; message: string }): Promise<void> {
		this.#rt.log(`aborting before the source stopped: ${info.code}`);
		const released = await this.#releaseSourceOrPend();
		let destinationClean = true;
		if (this.#progress.destinationReserved) {
			try {
				await this.#target.call("rollback", { operationId: this.#id, sessionId: this.#request.session.sessionId }, { retry: true });
			} catch (error) {
				if (!(error instanceof HelperFailure && error.code === "operation-not-found")) {
					destinationClean = false;
					this.#rt.log(`destination rollback failed: ${errorInfo(error).message}`);
				}
			}
		}
		const record = await this.#load();
		if (record.state !== "aborting") await this.#transition("aborting", info.message);
		if (destinationClean && released) {
			await this.#transition("rolled-back", info.code, info);
		} else {
			const pending = [released ? "" : "the source reservation", destinationClean ? "" : "the destination reservation"].filter(Boolean).join(" and ");
			await this.#recordError({
				code: released ? "destination-rollback-pending" : "source-release-pending",
				message: `${info.message}; ${pending} could not be released yet. Repeat rollback-source`,
			});
		}
	}

	// ----- recovery

	async #waitForRecovery(): Promise<void> {
		const deadline = Date.now() + this.#rt.timing.recoveryWaitMs;
		while (Date.now() < deadline) {
			if (isTerminalState((await this.#load()).state)) return;
			await this.pollHub();
			const pending = await this.#pendingRecoveries();
			for (const { file, action } of pending) {
				await this.recover(action);
				// Removed only after the action ran, so a crash in between repeats it.
				await fs.rm(file, { force: true });
				if (isTerminalState((await this.#load()).state)) return;
			}
			if (pending.length === 0) await sleep(this.#rt.timing.recoveryPollMs);
		}
	}

	/** Runs one recovery action. A refused action leaves the recorded error alone; a failed one records its own. */
	async recover(action: RecoverAction): Promise<void> {
		this.#rt.log(`recover ${action}`);
		try {
			switch (action) {
				case "resume":
					await this.#resume();
					break;
				case "retry-launch":
					await this.#retryLaunch();
					break;
				case "rollback-source":
					await this.#rollbackSource();
					break;
				case "restore-project":
					await this.#restoreProject();
					break;
				case "cleanup":
					await this.#cleanup();
					break;
			}
		} catch (error) {
			if (error instanceof CrashSignal) throw error;
			const info = errorInfo(error);
			if (error instanceof Refused) {
				this.#rt.log(`recover ${action} refused: ${info.message}`);
				await this.#hub.event({ state: this.#state, progress: { recoveryRefused: { action, code: info.code, message: clip(info.message, 300) } } });
			} else {
				await this.#recordError(info);
			}
		}
	}

	/** Re-enters the launch and arrival steps. A consumed launch intent is never spawned again. */
	async #retryLaunch(): Promise<void> {
		const record = await this.#load();
		if (record.state !== "source-departed" && record.state !== "destination-starting") {
			throw new Refused("bad-state", `retry-launch needs source-departed or destination-starting, not ${record.state}`);
		}
		if (this.#progress.restored) {
			throw new Refused("project-restored", "the project change was restored; launching would run on a reverted project. Roll back the source session");
		}
		await this.#saveProgress({ cancelRequested: false });
		await this.#drive();
	}

	/** Re-enters the pipeline from any state before departure, for example after a transient copy or helper failure. */
	async #resume(): Promise<void> {
		const record = await this.#load();
		if (!BEFORE_DEPARTURE.includes(record.state)) {
			throw new Refused("bad-state", `resume needs a state before departure, not ${record.state}; use retry-launch after departure`);
		}
		if (this.#progress.restored) {
			throw new Refused("project-restored", "the project change was restored; roll back the source session instead of resuming");
		}
		await this.#saveProgress({ cancelRequested: false });
		await this.#drive();
	}

	/**
	 * Cancels the destination launch intent through the helper first; only then is the source
	 * released. An unreachable or already-started destination leaves the source blocked. The
	 * source reservation is released before the record becomes terminal; on a terminal record
	 * the holder-only release is simply repeated.
	 */
	async #rollbackSource(): Promise<void> {
		const record = await this.#load();
		if (record.state === "rolled-back" || (record.state === "completed" && this.#progress.sourceReleasePending)) {
			await this.#releaseSource();
			await this.#clearReleasePending();
			return;
		}
		if (record.state === "completed") throw new Refused("bad-state", "the transfer completed; return the session with a reverse transfer");
		if (this.#progress.destinationReserved) {
			try {
				await this.#target.call("rollback", { operationId: this.#id, sessionId: this.#request.session.sessionId }, { retry: true });
			} catch (error) {
				if (error instanceof HelperFailure && error.code === "launch-already-consumed") {
					throw new WorkerError("launch-already-consumed", "the destination already started this session; return it with a reverse transfer");
				}
				if (error instanceof TargetUnreachable) {
					throw new WorkerError("target-unreachable", `${error.message}; source recovery stays blocked until the destination answers`);
				}
				if (!(error instanceof HelperFailure && error.code === "operation-not-found")) throw error;
			}
		}
		await this.#rt.journal.cancelLaunchIntent(this.#id);
		if (record.state !== "aborting") await this.#transition("aborting", "rollback-source");
		if (!(await this.#releaseSourceOrPend())) {
			throw new WorkerError("source-release-pending", "the source reservation could not be released; repeat rollback-source");
		}
		const departed = await hasDepartureMarker(this.#request.session.sessionFile, this.#id).catch(() => false);
		await this.#transition(
			"rolled-back",
			departed ? "rolled back after the departure marker was written; resuming the source copy forks it" : "rolled back",
		);
		await this.#target.call("cleanup", { operationId: this.#id }).catch(() => undefined);
		await fs.rm(path.join(this.#op.opDir, "out"), { recursive: true, force: true }).catch(() => undefined);
	}

	async #restoreProject(): Promise<void> {
		const record = await this.#load();
		if (record.state === "destination-starting" || record.state === "completed") {
			throw new Refused("destination-started", "the destination started; project changes cannot be restored under it");
		}
		if (record.projectMode !== "update") throw new Refused("not-applicable", "only an update has an undo manifest");
		const reply = await this.#target.call("restore-project", { operationId: this.#id }, { retry: true });
		const restored = Array.isArray(reply.restored) ? reply.restored.length : 0;
		const conflicts = Array.isArray(reply.conflicts) ? reply.conflicts.filter((entry): entry is string => typeof entry === "string").slice(0, 50) : [];
		await this.#saveProgress({ restored: true });
		await this.#hub.event({ state: record.state, progress: { restore: { restored, conflicts } } });
		if (conflicts.length > 0) throw new WorkerError("restore-conflicts", `${conflicts.length} path(s) changed since the update and were left alone: ${conflicts.slice(0, 5).join(", ")}`);
	}

	async #cleanup(): Promise<void> {
		const record = await this.#load();
		if (isTerminalState(record.state)) {
			// A terminal record never keeps the source reservation; this repairs one that predates that rule.
			await this.#releaseSource();
			await this.#clearReleasePending();
		}
		const needed = (record.state === "staged" || record.state === "publishing") && !this.#progress.cancelRequested && !this.#progress.restored;
		if (needed) throw new Refused("bad-state", "staging is still needed to continue this transfer");
		const reply = await this.#target.call("cleanup", { operationId: this.#id }, { retry: true });
		await fs.rm(path.join(this.#op.opDir, "out"), { recursive: true, force: true }).catch(() => undefined);
		await this.#hub.event({ state: record.state, progress: { cleanup: { stagingRemoved: reply.stagingRemoved === true } } });
	}

	async #clearReleasePending(): Promise<void> {
		if (this.#progress.sourceReleasePending) await this.#saveProgress({ sourceReleasePending: false });
	}

	/** Releases the source reservation; on failure the flag keeps the operation from ending in a terminal state. */
	async #releaseSourceOrPend(): Promise<boolean> {
		try {
			await this.#releaseSource();
			await this.#clearReleasePending();
			return true;
		} catch (error) {
			this.#rt.log(`source reservation release failed: ${errorInfo(error).message}`);
			await this.#saveProgress({ sourceReleasePending: true });
			return false;
		}
	}

	// ----- queued recovery requests

	/** Requests from the hub and from handed-over CLI calls, oldest name first; unreadable files are dropped. */
	async #pendingRecoveries(): Promise<{ file: string; action: RecoverAction }[]> {
		const dir = path.join(this.#op.opDir, RECOVER_DIR);
		let names: string[];
		try {
			names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).sort();
		} catch {
			return [];
		}
		const pending: { file: string; action: RecoverAction }[] = [];
		for (const name of names) {
			const file = path.join(dir, name);
			const value = await readJson(file);
			if (isRecord(value) && RECOVER_ACTIONS.includes(value.action as RecoverAction)) pending.push({ file, action: value.action as RecoverAction });
			else await fs.rm(file, { force: true });
		}
		return pending;
	}
}

// ---------------------------------------------------------------------------
// Entry points

function appendLog(file: string): (line: string) => void {
	return (line) => {
		try {
			appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
		} catch {
			// logging must never fail the run
		}
	};
}

/** Drives one operation to a terminal state, or to a recorded failure that waits for recovery. */
export async function run(operationId: string, ctx: WorkerContext = {}): Promise<RunOutcome> {
	const rt = createRuntime(ctx);
	if (!OPERATION_ID_PATTERN.test(operationId)) throw new WorkerError("invalid-request", "invalid operation id");
	const lock = await rt.journal.acquireWorkerLock(operationId);
	try {
		const transfer = new TransferRun(await loadOperation(rt, operationId));
		await transfer.init();
		return await transfer.execute();
	} finally {
		await lock.release();
	}
}

/**
 * Runs one recovery action. While a worker holds the operation (it waits for recovery commands),
 * the request is queued as a file in `recover-requests/` and the worker runs it.
 */
export async function recover(
	operationId: string,
	action: RecoverAction,
	ctx: WorkerContext = {},
): Promise<RunOutcome & { handedOver?: boolean }> {
	const rt = createRuntime(ctx);
	if (!RECOVER_ACTIONS.includes(action)) throw new WorkerError("invalid-request", `unknown recovery action ${String(action)}`);
	let lock: { release(): Promise<void> };
	try {
		lock = await rt.journal.acquireWorkerLock(operationId);
	} catch (error) {
		if (!(error instanceof JournalError && error.code === "worker-active")) throw error;
		const name = `local-${String(Date.now()).padStart(15, "0")}-${randomBytes(4).toString("hex")}.json`;
		await writePrivateJson(path.join(rt.journalDir, operationId, RECOVER_DIR, name), { action, requestedAt: new Date().toISOString() });
		const record = await rt.journal.load(operationId);
		return { operationId, state: record?.state ?? "prepared", handedOver: true };
	}
	try {
		const transfer = new TransferRun(await loadOperation(rt, operationId));
		await transfer.init();
		await transfer.recover(action);
		return await transfer.finish();
	} finally {
		await lock.release();
	}
}

export interface StatusResult {
	operationId: string;
	record: OperationRecord;
	progress: Progress;
	workerActive: boolean;
	sourceReservation: unknown;
	destination?: unknown;
}

/** Local state of an operation; `remote` also asks the destination helper. */
export async function status(operationId: string, ctx: WorkerContext = {}, options: { remote?: boolean } = {}): Promise<StatusResult> {
	const rt = createRuntime(ctx);
	if (!OPERATION_ID_PATTERN.test(operationId)) throw new WorkerError("invalid-request", "invalid operation id");
	const record = await rt.journal.load(operationId);
	if (!record) throw new WorkerError("not-found", `operation ${operationId} not found`);
	const workerActive = await workerLockActive(rt.journalDir, operationId);
	const sourceReservation = await runOmp(rt, ["session", "reservation", "--json", "--", record.sessionId]).then(
		(reply) => reply.reservation ?? null,
		() => null,
	);
	const result: StatusResult = { operationId, record, progress: await readProgress(path.join(rt.journalDir, operationId)), workerActive, sourceReservation };
	if (options.remote) {
		try {
			const operation = await loadOperation(rt, operationId);
			result.destination = await operation.target.call("status", { operationId });
		} catch (error) {
			result.destination = { error: errorInfo(error) };
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Command line

export interface CliIo {
	out(text: string): void;
	err(text: string): void;
	/** Asks a yes/no question; undefined when there is no terminal to ask on. */
	confirm?: (question: string) => Promise<boolean>;
}

interface ParsedArgs {
	positionals: string[];
	values: Record<string, string>;
	flags: Set<string>;
}

function parseArgs(args: string[], valueFlags: readonly string[], boolFlags: readonly string[]): ParsedArgs {
	const parsed: ParsedArgs = { positionals: [], values: {}, flags: new Set() };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (!arg.startsWith("--")) {
			parsed.positionals.push(arg);
			continue;
		}
		const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
		if (boolFlags.includes(name) && inline === undefined) parsed.flags.add(name);
		else if (valueFlags.includes(name)) {
			const value = inline ?? args[++i];
			if (value === undefined) throw new WorkerError("usage", `--${name} needs a value`);
			parsed.values[name] = value;
		} else throw new WorkerError("usage", `unknown option --${name}`);
	}
	return parsed;
}

const USAGE = [
	"usage: ompc-send plan --request <file> --json",
	"       ompc-send run --operation <id>",
	"       ompc-send recover --operation <id> --action <resume|retry-launch|rollback-source|restore-project|cleanup>",
	"       ompc-send status --operation <id> [--remote]",
	"       ompc-send send-to-host <sessionId> <destination> [--update-project|--session-only] [--destination-path <path>] [--accept-incomplete] [--yes]",
].join("\n");

async function readSessionHeader(file: string): Promise<Record<string, unknown>> {
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
		const header: unknown = JSON.parse(firstLine);
		if (!isRecord(header)) throw new Error("not an object");
		return header;
	} catch {
		throw new WorkerError("session-missing", "the session journal has no readable header");
	} finally {
		await handle.close();
	}
}

function summarise(result: PlanResult, destination: string): string {
	const { preflight, plan: projectPlan } = result;
	const lines = [
		`Session ${preflight.sessionId}${preflight.title ? ` (${preflight.title})` : ""} to ${destination} (${preflight.destinationHostId})`,
		`  source project:      ${preflight.sourceProject}`,
		`  destination project: ${preflight.destinationProject}${preflight.destinationExists ? " (exists)" : " (new)"}`,
		`  project mode:        ${preflight.projectMode}`,
		`  session archive:     ${preflight.archiveBytes} bytes, ${preflight.children} nested history file(s)${preflight.archiveEstimated ? " (estimated)" : ""}`,
	];
	if (preflight.projectMode !== "session-only") {
		const count = (action: string): number => projectPlan.entries.filter((entry) => entry.action === action).length;
		lines.push(`  project changes:     ${count("add")} added, ${count("replace")} replaced, ${count("mode-change")} mode changes, ${projectPlan.destinationOnly} destination-only kept`);
	}
	for (const warning of preflight.warnings) lines.push(`  warning: ${warning}`);
	for (const blocker of preflight.blockers) lines.push(`  blocked: ${blocker}`);
	return `${lines.join("\n")}\n`;
}

/** `ompc send-to-host`: an inactive session only; a live owner is refused. */
export async function sendToHost(args: string[], ctx: WorkerContext, io: CliIo): Promise<number> {
	const parsed = parseArgs(args, ["destination-path"], ["update-project", "session-only", "accept-incomplete", "yes"]);
	const [sessionId, destination, extra] = parsed.positionals;
	if (!sessionId || !destination || extra !== undefined) throw new WorkerError("usage", "send-to-host needs <sessionId> <destination>");
	if (!SESSION_ID.test(sessionId)) throw new WorkerError("usage", "invalid session id");
	if (parsed.flags.has("update-project") && parsed.flags.has("session-only")) {
		throw new WorkerError("usage", "--update-project and --session-only cannot be combined");
	}
	const rt = createRuntime(ctx);
	const located = await runOmp(rt, ["session", "locate", "--cwd", process.cwd(), "--json", "--", sessionId]);
	if (typeof located.sessionFile !== "string") throw new WorkerError("session-missing", `session ${sessionId} was not found`);
	const sessionFile = located.sessionFile;
	if (await leaseHeld(rt, sessionId)) {
		io.err(`ompc: session ${sessionId} is running. Use Send to host in the dashboard to move a running session, or exit it first.\n`);
		return 75;
	}
	const header = await readSessionHeader(sessionFile);
	if (typeof header.cwd !== "string") throw new WorkerError("session-missing", "the session header has no working directory");
	const session: SessionFacts = {
		sessionId,
		sessionFile,
		cwd: absolutePath(header.cwd, "session cwd"),
		...(typeof header.title === "string" && header.title !== "" && { title: clip(header.title, 256) }),
	};
	const requestedMode: ProjectMode | undefined = parsed.flags.has("update-project") ? "update" : parsed.flags.has("session-only") ? "session-only" : undefined;
	const planned = await plan(
		{
			destination,
			...(requestedMode !== undefined && { projectMode: requestedMode }),
			...(parsed.values["destination-path"] !== undefined && { destinationPath: parsed.values["destination-path"] }),
			session,
		},
		ctx,
	);
	io.out(summarise(planned, destination));
	if (planned.preflight.blockers.length > 0) return 1;
	if (planned.preflight.acceptIncompleteRequired && !parsed.flags.has("accept-incomplete")) {
		io.err("ompc: the archive is incomplete (missing blobs or outside references). Repeat with --accept-incomplete to send it anyway.\n");
		return 1;
	}
	if (!parsed.flags.has("yes")) {
		if (!io.confirm) {
			io.err("ompc: no terminal to confirm on; repeat with --yes\n");
			return 1;
		}
		if (!(await io.confirm("Send this session now?"))) {
			io.err("ompc: cancelled; nothing was changed\n");
			return 1;
		}
	}
	const operationId = `cli-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
	const request: RunRequest = {
		operationId,
		planId: planned.planId,
		planDigest: planned.digest,
		projectMode: planned.preflight.projectMode,
		acceptIncomplete: parsed.flags.has("accept-incomplete"),
		destination,
		session,
	};
	await writePrivateJson(path.join(rt.journalDir, operationId, "request.json"), request);
	const outcome = await run(operationId, { ...ctx, awaitRecovery: false, log: (line) => io.err(`ompc: ${line}\n`) });
	if (outcome.state === "completed") {
		io.out(`Sent. Operation ${operationId} completed.\n`);
		return 0;
	}
	io.err(
		`ompc: operation ${operationId} ended in state ${outcome.state}${outcome.error ? ` (${outcome.error.code}: ${outcome.error.message})` : ""}.\n` +
			`ompc: inspect it with: ompc-send status --operation ${operationId}\n` +
			`ompc: recover with: ompc-send recover --operation ${operationId} --action <resume|retry-launch|rollback-source|restore-project|cleanup>\n`,
	);
	return 1;
}

/** The `ompc-send` entry point; returns the process exit code. */
export async function main(argv: string[], ctx: WorkerContext = {}, io?: CliIo): Promise<number> {
	const stdio: CliIo = io ?? {
		out: (text) => void process.stdout.write(text),
		err: (text) => void process.stderr.write(text),
		confirm:
			process.stdin.isTTY && process.stderr.isTTY
				? async (question) => {
						process.stderr.write(`${question} [y/N] `);
						for await (const line of console) return /^y(es)?$/i.test(line.trim());
						return false;
					}
				: undefined,
	};
	const [command, ...rest] = argv;
	let json = false;
	try {
		switch (command) {
			case "plan": {
				const parsed = parseArgs(rest, ["request"], ["json"]);
				json = parsed.flags.has("json");
				if (!parsed.values.request) throw new WorkerError("usage", "plan needs --request <file>");
				const request = parsePlanRequest(await readJson(parsed.values.request));
				const result = await plan(request, ctx);
				stdio.out(json ? `${JSON.stringify(result)}\n` : summarise(result, request.destination));
				return 0;
			}
			case "run": {
				const parsed = parseArgs(rest, ["operation"], []);
				if (!parsed.values.operation) throw new WorkerError("usage", "run needs --operation <id>");
				const rt = createRuntime(ctx);
				const log = ctx.log ?? appendLog(path.join(rt.journalDir, parsed.values.operation, "worker.log"));
				const outcome = await run(parsed.values.operation, { ...ctx, log });
				return outcome.state === "completed" || outcome.state === "rolled-back" ? 0 : 1;
			}
			case "recover": {
				const parsed = parseArgs(rest, ["operation", "action"], []);
				if (!parsed.values.operation || !parsed.values.action) throw new WorkerError("usage", "recover needs --operation and --action");
				const outcome = await recover(parsed.values.operation, parsed.values.action as RecoverAction, ctx);
				stdio.out(`${JSON.stringify({ ok: !outcome.error, ...outcome })}\n`);
				return outcome.error ? 1 : 0;
			}
			case "status": {
				const parsed = parseArgs(rest, ["operation"], ["remote"]);
				if (!parsed.values.operation) throw new WorkerError("usage", "status needs --operation <id>");
				stdio.out(`${JSON.stringify(await status(parsed.values.operation, ctx, { remote: parsed.flags.has("remote") }))}\n`);
				return 0;
			}
			case "send-to-host":
				return await sendToHost(rest, ctx, stdio);
			default:
				stdio.err(`${USAGE}\n`);
				return 64;
		}
	} catch (error) {
		const info = errorInfo(error);
		if (json) stdio.out(`${JSON.stringify({ ok: false, ...info })}\n`);
		else stdio.err(`ompc-send: ${info.message}\n`);
		if (info.code === "usage") stdio.err(`${USAGE}\n`);
		return info.code === "usage" ? 64 : info.code === "worker-active" ? 75 : 1;
	}
}
