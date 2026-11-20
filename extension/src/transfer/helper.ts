// Destination helper for send-to-host. Reached over SSH as one fixed command:
// one JSON request on stdin, one JSON reply on stdout, diagnostics on stderr.
// `runHelper` never throws; every failure becomes `{ ok: false, code, message }`.
// User data only ever travels inside the JSON request, never as shell syntax:
// the OMP binary and `ompc` are spawned with argv arrays.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, constants as fsc, statSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, hostname as osHostname, userInfo } from "node:os";
import * as path from "node:path";
import { DEFAULT_ALLOWED_ROOTS, DEFAULT_PROTECTED_PATHS } from "./config.js";
import {
	defaultJournalDir,
	JournalError,
	OPERATION_ID_PATTERN,
	OperationJournal,
	type OperationRecord,
	type ProjectMode,
	type TransferState,
} from "./journal.js";
import {
	applyProjectUpdate,
	buildManifest,
	computePlanDigest,
	ProjectSyncError,
	publishNewProject,
	restoreProjectUpdate,
	validateDestinationPath,
	type ProjectPlan,
	type TreeManifest,
} from "./project-sync.js";

export const HELPER_PROTOCOL = 1;
export const MAX_REQUEST_BYTES = 1024 * 1024;

const STDIN_TIMEOUT_MS = 60_000;
const OMP_TIMEOUT_MS = 10 * 60_000;
const MAX_OMP_OUTPUT_BYTES = 4 * 1024 * 1024;
const SPAWN_SETTLE_MS = 15_000;
const MAX_PATH_LENGTH = 4096;
const MAX_LIST_ENTRIES = 256;
const MAX_KNOWN_USERS = 50;
const MAX_ARRIVAL_BYTES = 64 * 1024;
/** An undo manifest lists every touched path, so it can be much larger than the small marker files. */
const MAX_UNDO_BYTES = 64 * 1024 * 1024;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DIGEST_PATTERN = /^[\x21-\x7e]{1,256}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

const FORWARD: readonly TransferState[] = [
	"prepared",
	"source-stopping",
	"source-stopped",
	"staged",
	"publishing",
	"source-departed",
	"destination-starting",
	"completed",
];

export type HelperReply =
	| ({ ok: true } & Record<string, unknown>)
	| ({ ok: false; code: string; message: string } & Record<string, unknown>);

/** A failure with a protocol error code; becomes the `{ ok: false }` reply. */
export class HelperError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "HelperError";
	}
}

export interface SpawnResult {
	pid: number | undefined;
	/** Exit code when the child ended within the settle window; null while it still runs. */
	exitCode: number | null;
	stderr?: string;
}

export interface KnownUser {
	pid: number;
	cwd: string;
	command: string;
}

export interface HelperDeps {
	env: NodeJS.ProcessEnv;
	home: string;
	journalDir: string;
	hostname(): string;
	user(): string;
	/** Absolute OMP binary (or `OMP_BIN` value), or null when none is installed. */
	resolveOmpBin(): string | null;
	resolveOmpc(): string | null;
	hasRsync(): boolean;
	ompVersion(bin: string): Promise<string | null>;
	/** Runs `omp <args>` and returns the single JSON object it prints, including `{ ok: false }` objects. */
	runOmp(args: string[]): Promise<Record<string, unknown>>;
	spawnDetached(
		command: string,
		args: string[],
		options: { cwd: string; env: NodeJS.ProcessEnv },
	): Promise<SpawnResult>;
	gitDirty(dir: string): Promise<boolean | null>;
	knownUsers(dir: string): Promise<KnownUser[]>;
	pidAlive(pid: number): boolean;
	freeBytes(target: string): Promise<number | null>;
	log(line: string): void;
}

// ------------------------------------------------------------ default deps

function isExecutableFile(file: string): boolean {
	try {
		if (!statSync(file).isFile()) return false;
		accessSync(file, fsc.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** `envVar`, then PATH, then `$HOME/.bun/bin`, then `$HOME/.local/bin`. Relative PATH entries are ignored. */
function resolveBinary(name: string, env: NodeJS.ProcessEnv, home: string, envVar?: string): string | null {
	if (envVar && env[envVar]) return env[envVar] as string;
	for (const dir of (env.PATH ?? "").split(":")) {
		if (dir === "" || !path.isAbsolute(dir)) continue;
		const candidate = path.join(dir, name);
		if (isExecutableFile(candidate)) return candidate;
	}
	for (const dir of [path.join(home, ".bun", "bin"), path.join(home, ".local", "bin")]) {
		const candidate = path.join(dir, name);
		if (isExecutableFile(candidate)) return candidate;
	}
	return null;
}

function runOmpProcess(
	bin: string | null,
	args: string[],
	env: NodeJS.ProcessEnv,
	log: (line: string) => void,
): Promise<Record<string, unknown>> {
	if (!bin) return Promise.reject(new HelperError("omp-missing", "OMP binary not found"));
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
		} catch (error) {
			reject(spawnFailure(error));
			return;
		}
		const chunks: Buffer[] = [];
		let outBytes = 0;
		let errText = "";
		let timedOut = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			outBytes += chunk.length;
			if (outBytes <= MAX_OMP_OUTPUT_BYTES) chunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (errText.length < 8192) errText += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, OMP_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(spawnFailure(error));
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (errText.trim() !== "") log(`omp ${args[0] ?? ""} ${args[1] ?? ""}: ${errText.trim().slice(0, 2000)}`);
			if (timedOut) {
				reject(new HelperError("omp-failed", `omp ${args.slice(0, 2).join(" ")} timed out`));
				return;
			}
			if (outBytes > MAX_OMP_OUTPUT_BYTES) {
				reject(new HelperError("omp-bad-output", "omp output too large"));
				return;
			}
			const text = Buffer.concat(chunks).toString("utf8").trim();
			const parsed = parseSingleJsonObject(text);
			if (!parsed) {
				reject(
					new HelperError(
						text === "" ? "omp-failed" : "omp-bad-output",
						`omp ${args.slice(0, 2).join(" ")} exited ${code ?? "by signal"} without a JSON object`,
					),
				);
				return;
			}
			resolve(parsed);
		});
	});
}

function spawnFailure(error: unknown): HelperError {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT" || code === "EACCES" || code === "ENOEXEC") {
		return new HelperError("omp-missing", "OMP binary cannot be executed");
	}
	return new HelperError("omp-failed", `cannot start omp: ${(error as Error).message}`);
}

function parseSingleJsonObject(text: string): Record<string, unknown> | undefined {
	const candidates = [text];
	const lastLine = text.split("\n").at(-1);
	if (lastLine !== undefined && lastLine !== text) candidates.push(lastLine);
	for (const candidate of candidates) {
		try {
			const value: unknown = JSON.parse(candidate);
			if (isObject(value)) return value;
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

function defaultSpawnDetached(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<SpawnResult> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				env: options.env,
				detached: true,
				stdio: ["ignore", "ignore", "pipe"],
			});
		} catch (error) {
			reject(new HelperError("launch-failed", `cannot start ompc: ${(error as Error).message}`));
			return;
		}
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString("utf8");
		});
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stderr?.destroy();
			child.unref();
			fn();
		};
		const timer = setTimeout(() => settle(() => resolve({ pid: child.pid, exitCode: null, stderr })), SPAWN_SETTLE_MS);
		child.once("error", (error) => settle(() => reject(new HelperError("launch-failed", `cannot start ompc: ${error.message}`))));
		child.once("exit", (code, signal) =>
			settle(() => resolve({ pid: child.pid, exitCode: code ?? (signal ? 128 : 0), stderr })),
		);
	});
}

function defaultGitDirty(dir: string): Promise<boolean | null> {
	return fs.lstat(path.join(dir, ".git")).then(
		() =>
			new Promise<boolean | null>((resolve) => {
				execFile(
					"git",
					["-c", "core.fsmonitor=false", "-C", dir, "status", "--porcelain"],
					{
						timeout: 20_000,
						maxBuffer: 1024 * 1024,
						env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
					},
					(error, stdout) => resolve(error ? null : String(stdout).trim().length > 0),
				);
			}),
		() => null,
	);
}

async function defaultKnownUsers(dir: string): Promise<KnownUser[]> {
	let names: string[];
	try {
		names = await fs.readdir("/proc");
	} catch {
		return [];
	}
	const users: KnownUser[] = [];
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		if (pid === process.pid) continue;
		let cwd: string;
		try {
			cwd = await fs.readlink(`/proc/${name}/cwd`);
		} catch {
			continue;
		}
		if (cwd !== dir && !cwd.startsWith(`${dir}/`)) continue;
		let command = "";
		try {
			command = (await fs.readFile(`/proc/${name}/comm`, "utf8")).trim();
		} catch {
			// process ended or is not readable
		}
		users.push({ pid, cwd, command });
		if (users.length >= MAX_KNOWN_USERS) break;
	}
	return users;
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function defaultOmpVersion(bin: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(bin, ["--version"], { timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => {
			const line = String(stdout).split("\n").find((l) => l.trim() !== "");
			resolve(error || !line ? null : line.trim().slice(0, 200));
		});
	});
}

async function defaultFreeBytes(target: string): Promise<number | null> {
	try {
		const stats = await fs.statfs(target);
		return Number(stats.bavail) * Number(stats.bsize);
	} catch {
		return null;
	}
}

export function createDeps(overrides: Partial<HelperDeps> = {}): HelperDeps {
	const env = overrides.env ?? process.env;
	const home = overrides.home ?? homedir();
	const deps = {} as HelperDeps;
	Object.assign(
		deps,
		{
			env,
			home,
			journalDir: defaultJournalDir(env, home),
			hostname: () => osHostname(),
			user: () => {
				try {
					return userInfo().username;
				} catch {
					return env.USER ?? "unknown";
				}
			},
			resolveOmpBin: () => resolveBinary("omp", env, home, "OMP_BIN"),
			resolveOmpc: () => resolveBinary("ompc", env, home),
			hasRsync: () => resolveBinary("rsync", env, home) !== null,
			ompVersion: defaultOmpVersion,
			runOmp: (args: string[]) => runOmpProcess(deps.resolveOmpBin(), args, deps.env, deps.log),
			spawnDetached: defaultSpawnDetached,
			gitDirty: defaultGitDirty,
			knownUsers: defaultKnownUsers,
			pidAlive: defaultPidAlive,
			freeBytes: defaultFreeBytes,
			log: (line: string) => {
				process.stderr.write(`ompc-transfer-helper: ${line}\n`);
			},
		} satisfies HelperDeps,
		overrides,
	);
	return deps;
}

// -------------------------------------------------------------- validation

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): HelperError {
	return new HelperError("invalid-request", message);
}

function reqPattern(req: Record<string, unknown>, key: string, pattern: RegExp): string {
	const value = req[key];
	if (typeof value !== "string" || !pattern.test(value)) throw invalid(`${key} is missing or malformed`);
	return value;
}

const reqOperationId = (req: Record<string, unknown>) => reqPattern(req, "operationId", OPERATION_ID_PATTERN);
const reqSessionId = (req: Record<string, unknown>) => reqPattern(req, "sessionId", SESSION_ID_PATTERN);
const reqNonce = (req: Record<string, unknown>) => reqPattern(req, "nonce", NONCE_PATTERN);

/** An absolute, normalised path without control characters or `..` segments. */
function checkPath(value: unknown, label: string): string {
	if (typeof value !== "string" || value === "" || value.length > MAX_PATH_LENGTH) {
		throw invalid(`${label} must be a path string`);
	}
	if (CONTROL_PATTERN.test(value)) throw invalid(`${label} contains control characters`);
	if (!path.isAbsolute(value)) throw invalid(`${label} must be absolute`);
	if (value.split("/").includes("..")) throw invalid(`${label} must not contain '..' segments`);
	if (path.resolve(value) !== value) throw invalid(`${label} must be normalised`);
	return value;
}

function optionalBool(req: Record<string, unknown>, key: string): boolean {
	const value = req[key];
	if (value === undefined) return false;
	if (typeof value !== "boolean") throw invalid(`${key} must be a boolean`);
	return value;
}

function optionalText(req: Record<string, unknown>, key: string): string | undefined {
	const value = req[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > 256 || CONTROL_PATTERN.test(value)) {
		throw invalid(`${key} must be a short plain string`);
	}
	return value;
}

function stringList(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) throw invalid(`${label} must be an array of at most ${MAX_LIST_ENTRIES} strings`);
	for (const entry of value) {
		if (typeof entry !== "string" || entry === "" || entry.length > MAX_PATH_LENGTH || entry.includes("\0")) {
			throw invalid(`${label} entries must be non-empty strings`);
		}
	}
	return value as string[];
}

interface PathPolicy {
	home: string;
	allowedRoots: string[];
	protectedPaths: string[];
}

/** Request policy unioned with the built-in protected paths and the journal directory. */
function readPolicy(deps: HelperDeps, raw: unknown): PathPolicy {
	if (raw !== undefined && !isObject(raw)) throw invalid("policy must be an object");
	const policy = (raw ?? {}) as Record<string, unknown>;
	const allowedRoots = stringList(policy.allowedRoots, "policy.allowedRoots") ?? [...DEFAULT_ALLOWED_ROOTS];
	const requested = stringList(policy.protectedPaths, "policy.protectedPaths") ?? [];
	return {
		home: deps.home,
		allowedRoots,
		protectedPaths: [...new Set([...DEFAULT_PROTECTED_PATHS, ...requested, deps.journalDir])],
	};
}

/** Only the built-in protections; used for paths the request cannot attach a policy to. */
function builtinPolicy(deps: HelperDeps): PathPolicy {
	return { home: deps.home, allowedRoots: ["/"], protectedPaths: [...DEFAULT_PROTECTED_PATHS, deps.journalDir] };
}

function nonceEquals(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

// ---------------------------------------------------------------- context

interface Ctx {
	deps: HelperDeps;
	journal: OperationJournal;
	req: Record<string, unknown>;
}

const opDir = (ctx: Ctx, id: string) => path.join(ctx.deps.journalDir, id);
const stageRoot = (ctx: Ctx, id: string) => path.join(opDir(ctx, id), "stage");
const archivePathOf = (ctx: Ctx, id: string) => path.join(stageRoot(ctx, id), "archive", "session.tar");
const projectStagingOf = (ctx: Ctx, id: string) => path.join(stageRoot(ctx, id), "project");
const undoDirOf = (ctx: Ctx, id: string) => path.join(opDir(ctx, id), "undo");

async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(dir);
	if (!stat.isDirectory()) throw new HelperError("stage-unsafe", `${dir} is not a directory`);
	if ((stat.mode & 0o077) !== 0) await fs.chmod(dir, 0o700);
}

async function writeJsonPrivate(file: string, value: unknown): Promise<void> {
	const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	await fs.rename(tmp, file);
}

/** Missing file gives undefined; anything unreadable or oversize throws. */
async function readJsonFile(file: string, limit: number): Promise<unknown> {
	let stat: Stats;
	try {
		stat = await fs.lstat(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
	if (!stat.isFile() || stat.size > limit) throw new HelperError("invalid-record", `${path.basename(file)} is not a small regular file`);
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		throw new HelperError("invalid-record", `${path.basename(file)} is not valid JSON`);
	}
}

async function loadRecord(ctx: Ctx, id: string): Promise<OperationRecord> {
	const record = await ctx.journal.load(id);
	if (!record) throw new HelperError("operation-not-found", `Operation ${id} not found`);
	if (record.role !== "destination") throw new HelperError("bad-record", `Operation ${id} is not a destination record`);
	return record;
}

function isAbortState(state: TransferState): boolean {
	return state === "aborting" || state === "rolled-back";
}

function assertStateAtMost(record: OperationRecord, limit: TransferState): void {
	if (isAbortState(record.state) || FORWARD.indexOf(record.state) > FORWARD.indexOf(limit)) {
		throw new HelperError("bad-state", `Operation ${record.operationId} is ${record.state}; ${limit} or earlier is required`);
	}
}

/**
 * Walks the strict single-step journal forward to `target`, one transition at a
 * time. A record already at or beyond `target` is unchanged; an aborting or
 * rolled-back record is refused.
 */
export async function advanceTo(
	journal: OperationJournal,
	operationId: string,
	target: TransferState,
	detail = "helper",
): Promise<OperationRecord> {
	const targetIndex = FORWARD.indexOf(target);
	if (targetIndex < 0) throw new HelperError("bad-state", `${target} is not a forward state`);
	return journal.withOperationLock(operationId, async () => {
		let record = await journal.load(operationId);
		if (!record) throw new HelperError("operation-not-found", `Operation ${operationId} not found`);
		if (isAbortState(record.state)) {
			throw new HelperError("bad-state", `Operation ${operationId} is ${record.state}`);
		}
		for (let i = FORWARD.indexOf(record.state) + 1; i <= targetIndex; i++) {
			record = await journal.transition(operationId, FORWARD[i] as TransferState, detail);
		}
		return record;
	});
}

async function recordFailure(ctx: Ctx, id: string, error: unknown): Promise<void> {
	const known = error instanceof HelperError || error instanceof ProjectSyncError || error instanceof JournalError;
	const code = known ? (error as { code: string }).code : "internal";
	const message = error instanceof Error ? error.message : String(error);
	await ctx.journal.fail(id, { code, message: message.slice(0, 500) }).catch(() => {});
}

async function ompOk(ctx: Ctx, args: string[]): Promise<Record<string, unknown>> {
	const result = await ctx.deps.runOmp(args);
	if (!isObject(result)) throw new HelperError("omp-bad-output", "omp returned no JSON object");
	if (result.ok !== true) {
		throw new HelperError(
			typeof result.code === "string" ? result.code : "omp-failed",
			typeof result.message === "string" ? result.message : "omp command failed",
		);
	}
	return result;
}

/**
 * Canonical path for a session working directory. The built-in protected paths
 * always apply; a destination project recorded at reserve time bounds it too.
 */
async function checkCwd(ctx: Ctx, record: OperationRecord, raw: unknown, mustExist: boolean): Promise<string> {
	const cwd = await validateDestinationPath(checkPath(raw, "cwd"), builtinPolicy(ctx.deps));
	if (record.destinationProject !== undefined) {
		const project = await validateDestinationPath(record.destinationProject, builtinPolicy(ctx.deps));
		if (cwd !== project && !cwd.startsWith(`${project}${path.sep}`)) {
			throw new HelperError("cwd-mismatch", "cwd is outside the operation's destination project");
		}
	}
	if (mustExist) {
		const stat = await fs.stat(cwd).catch(() => undefined);
		if (!stat?.isDirectory()) throw new HelperError("cwd-missing", "cwd is not an existing directory");
	}
	return cwd;
}

// --------------------------------------------------------------------- ops

type Handler = (ctx: Ctx) => Promise<Record<string, unknown>>;

async function opHello(ctx: Ctx): Promise<Record<string, unknown>> {
	const { deps } = ctx;
	const ompBin = deps.resolveOmpBin();
	return {
		home: deps.home,
		hostname: deps.hostname(),
		user: deps.user(),
		hostId: `${deps.user()}@${deps.hostname()}`,
		ompBin,
		ompVersion: ompBin ? await deps.ompVersion(ompBin) : null,
		ompc: deps.resolveOmpc(),
		rsync: deps.hasRsync(),
		freeBytes: await deps.freeBytes(deps.home),
		transferProtocol: HELPER_PROTOCOL,
	};
}

/** `st_dev` of the deepest existing ancestor of `target`. */
async function deviceOf(target: string): Promise<number> {
	let current = target;
	for (;;) {
		try {
			return (await fs.stat(current)).dev;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) throw new HelperError("stage-unsafe", `no existing ancestor for ${target}`);
		current = parent;
	}
}

/**
 * True when the request's operation already imported this exact journal file, so a strict unpack
 * by the same operation replays instead of conflicting. Other local copies are not compared and
 * report false, as does a request without `operationId`.
 */
async function isReplayableImport(ctx: Ctx, sessionId: string, sessionFile: string | null): Promise<boolean> {
	const raw = ctx.req.operationId;
	if (raw === undefined) return false;
	if (typeof raw !== "string" || !OPERATION_ID_PATTERN.test(raw)) throw invalid("operationId is malformed");
	if (sessionFile === null) return false;
	const imported = await readJsonFile(path.join(opDir(ctx, raw), "import.json"), MAX_ARRIVAL_BYTES).catch(() => undefined);
	return isObject(imported) && imported.removed !== true && imported.id === sessionId && imported.sessionFile === sessionFile;
}

async function opInspect(ctx: Ctx): Promise<Record<string, unknown>> {
	const { deps, req } = ctx;
	const sessionId = reqSessionId(req);
	const projectPath = checkPath(req.projectPath, "projectPath");
	const policy = readPolicy(deps, req.policy);
	const exclude = stringList(req.exclude, "exclude") ?? [];
	const resolvedProject = await validateDestinationPath(projectPath, policy);

	const stat = await fs.lstat(resolvedProject).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
		throw error;
	});
	const isDirectory = stat?.isDirectory() ?? false;
	let manifest: TreeManifest | undefined;
	if (isDirectory) manifest = await buildManifest(resolvedProject, { exclude });

	const located = await ompOk(ctx, ["session", "locate", sessionId, "--cwd", resolvedProject, "--json"]);
	const reservation = await ompOk(ctx, ["session", "reservation", sessionId, "--json"]);
	const sessionFile = typeof located.sessionFile === "string" ? located.sessionFile : null;
	// A created project is renamed out of staging, which only works within one filesystem.
	const stagingSameFilesystem = (await deviceOf(deps.journalDir)) === (await deviceOf(resolvedProject));

	return {
		resolvedProject,
		exists: stat !== undefined,
		isDirectory,
		stagingSameFilesystem,
		...(manifest && { manifest }),
		gitDirty: isDirectory ? await deps.gitDirty(resolvedProject) : null,
		knownUsers: isDirectory ? await deps.knownUsers(resolvedProject) : [],
		session: {
			existsLocally: sessionFile !== null,
			replayable: await isReplayableImport(ctx, sessionId, sessionFile),
			sessionFile,
			reservation: reservation.reservation ?? null,
		},
	};
}

/** The destination reservation must be held by this operation before anything mutates. */
async function requireReservation(ctx: Ctx, record: OperationRecord): Promise<void> {
	const result = await ompOk(ctx, ["session", "reservation", record.sessionId, "--json"]);
	const held = result.reservation;
	if (!isObject(held) || held.operationId !== record.operationId || held.role !== "destination") {
		throw new HelperError("reservation-missing", "this operation does not hold the destination reservation");
	}
}

/** A reserve that failed: a record created by this call is rolled back so no record exists without a reservation. */
async function abandonReserve(ctx: Ctx, operationId: string, created: boolean, error: unknown): Promise<void> {
	if (created) {
		try {
			await ctx.journal.transition(operationId, "aborting", "reserve-failed");
			await ctx.journal.transition(operationId, "rolled-back", "reserve-failed");
		} catch {
			// the error below still reaches the caller
		}
	}
	await recordFailure(ctx, operationId, error);
}

async function opReserve(ctx: Ctx): Promise<Record<string, unknown>> {
	const { req, deps, journal } = ctx;
	const operationId = reqOperationId(req);
	const sessionId = reqSessionId(req);
	const planDigest = reqPattern(req, "planDigest", DIGEST_PATTERN);
	const projectMode = (req.projectMode ?? "session-only") as ProjectMode;
	if (projectMode !== "create" && projectMode !== "session-only" && projectMode !== "update") {
		throw invalid("projectMode is malformed");
	}
	let destinationProject: string | undefined;
	if (req.destinationProject !== undefined) {
		destinationProject = await validateDestinationPath(
			checkPath(req.destinationProject, "destinationProject"),
			readPolicy(deps, req.policy),
		);
	}
	const destinationName = optionalText(req, "destinationName");
	const sessionName = optionalText(req, "sessionName");

	const matches = (record: OperationRecord) => {
		if (record.role !== "destination" || record.sessionId !== sessionId || record.planDigest !== planDigest) {
			throw new HelperError("operation-exists", `Operation ${operationId} exists with different parameters`);
		}
		if (isAbortState(record.state) || record.state === "completed") {
			throw new HelperError("bad-state", `Operation ${operationId} is ${record.state}`);
		}
	};
	const existing = await journal.load(operationId);
	if (existing) matches(existing);

	let record = existing;
	let created = false;
	if (!record) {
		try {
			record = await journal.create({
				operationId,
				role: "destination",
				sessionId,
				planDigest,
				projectMode,
				...(destinationName !== undefined && { destinationName }),
				...(destinationProject !== undefined && { destinationProject }),
				...(sessionName !== undefined && { sessionName }),
			});
			created = true;
		} catch (error) {
			if (!(error instanceof JournalError && error.code === "exists")) throw error;
			record = await journal.load(operationId);
			if (!record) throw error;
			matches(record);
		}
	}
	let reserved: Record<string, unknown>;
	try {
		reserved = await ompOk(ctx, [
			"session",
			"reserve",
			sessionId,
			"--operation",
			operationId,
			"--role",
			"destination",
			"--json",
		]);
	} catch (error) {
		await abandonReserve(ctx, operationId, created, error);
		throw error;
	}
	return { state: record.state, resumed: existing !== undefined, reservation: reserved.reservation ?? null };
}

async function opStageDir(ctx: Ctx): Promise<Record<string, unknown>> {
	const operationId = reqOperationId(ctx.req);
	const record = await loadRecord(ctx, operationId);
	assertStateAtMost(record, "publishing");
	const archivePath = archivePathOf(ctx, operationId);
	const projectStaging = projectStagingOf(ctx, operationId);
	const undoDir = undoDirOf(ctx, operationId);
	const root = stageRoot(ctx, operationId);
	for (const dir of [opDir(ctx, operationId), root, path.dirname(archivePath), projectStaging, undoDir]) {
		await ensurePrivateDir(dir);
	}
	return { stagingRoot: root, archivePath, projectStaging, undoDir };
}

async function opImportSession(ctx: Ctx): Promise<Record<string, unknown>> {
	const { req } = ctx;
	const operationId = reqOperationId(req);
	const sessionId = reqSessionId(req);
	const allowPrefixReplace = optionalBool(req, "allowPrefixReplace");
	const record = await loadRecord(ctx, operationId);
	if (record.sessionId !== sessionId) throw new HelperError("session-mismatch", "sessionId does not match the operation");
	assertStateAtMost(record, "publishing");
	const cwd = await checkCwd(ctx, record, req.cwd, false);
	const archive = archivePathOf(ctx, operationId);
	const archiveStat = await fs.lstat(archive).catch(() => undefined);
	if (!archiveStat?.isFile()) throw new HelperError("archive-missing", "no staged archive for this operation");

	await requireReservation(ctx, record);
	await advanceTo(ctx.journal, operationId, "publishing", "import-session");
	try {
		const result = await ompOk(ctx, [
			"session",
			"unpack",
			archive,
			"--cwd",
			cwd,
			"--strict",
			...(allowPrefixReplace ? ["--allow-prefix-replace"] : []),
			"--operation",
			operationId,
			"--json",
		]);
		if (typeof result.sessionFile !== "string" || typeof result.mode !== "string") {
			throw new HelperError("omp-bad-output", "unpack reply lacks sessionFile or mode");
		}
		if (result.id !== sessionId) throw new HelperError("session-mismatch", "unpacked session id differs from the operation");
		const importFile = path.join(opDir(ctx, operationId), "import.json");
		const prior = await readJsonFile(importFile, MAX_ARRIVAL_BYTES).catch(() => undefined);
		// A replay reports "replayed"; the first import's mode says whether a local copy pre-existed.
		const origin =
			result.mode === "replayed" && isObject(prior) && prior.sessionFile === result.sessionFile && typeof prior.mode === "string"
				? prior.mode
				: result.mode;
		const stem = result.sessionFile.endsWith(".jsonl") ? result.sessionFile.slice(0, -".jsonl".length) : undefined;
		const artifactsDir = stem !== undefined && (await fs.lstat(stem).then((s) => s.isDirectory(), () => false)) ? stem : null;
		await writeJsonPrivate(importFile, {
			sessionFile: result.sessionFile,
			id: sessionId,
			mode: origin,
			lastMode: result.mode,
			cwd,
			artifactsDir,
		});
		return { sessionFile: result.sessionFile, id: sessionId, mode: result.mode, state: "publishing" };
	} catch (error) {
		await recordFailure(ctx, operationId, error);
		throw error;
	}
}

function summarisePlan(plan: ProjectPlan | undefined, backupDir: string | null): Record<string, unknown> {
	const entries = plan?.entries ?? [];
	const count = (action: string) => entries.filter((entry) => entry.action === action).length;
	return {
		entries: entries.length,
		created: count("add"),
		replaced: count("replace"),
		modeChanged: count("mode-change"),
		backupDir,
	};
}

function checkPlan(plan: unknown, mode: "create" | "update", record: OperationRecord, req: Record<string, unknown>): ProjectPlan {
	if (!isObject(plan) || !Array.isArray(plan.entries) || typeof plan.digest !== "string") {
		throw new ProjectSyncError("invalid-plan", "plan is missing or malformed");
	}
	const typed = plan as unknown as ProjectPlan;
	if (typed.mode !== mode) throw new ProjectSyncError("invalid-plan", `plan mode ${String(typed.mode)} does not match ${mode}`);
	let digest: string;
	try {
		digest = computePlanDigest(typed);
	} catch {
		throw new ProjectSyncError("invalid-plan", "plan cannot be hashed");
	}
	if (digest !== typed.digest) throw new ProjectSyncError("invalid-plan", "plan digest does not match its content");
	if (Array.isArray(typed.conflicts) && typed.conflicts.length > 0) {
		throw new ProjectSyncError("conflicts", "plan has unresolved conflicts", typed.conflicts.map((c) => c.path));
	}
	const bound = req.planDigest === undefined ? typed.digest : reqPattern(req, "planDigest", DIGEST_PATTERN);
	if (bound !== record.planDigest) throw new HelperError("plan-mismatch", "plan is not the plan this operation reserved");
	return typed;
}

/** A created tree is published only when it is exactly what the plan lists. */
async function verifyStaging(stagingDir: string, plan: ProjectPlan): Promise<void> {
	const manifest = await buildManifest(stagingDir);
	const got = new Map(manifest.entries.map((entry) => [entry.path, entry]));
	const want = new Map(plan.entries.map((entry) => [entry.path, entry]));
	const bad: string[] = [];
	for (const [rel, entry] of want) {
		const seen = got.get(rel);
		if (
			!seen ||
			seen.kind !== entry.kind ||
			(entry.kind === "file" && seen.sha256 !== entry.sha256) ||
			(entry.kind === "symlink" && seen.target !== entry.target)
		) {
			bad.push(rel);
		}
	}
	for (const rel of got.keys()) if (!want.has(rel)) bad.push(rel);
	if (bad.length > 0) {
		throw new ProjectSyncError("staging-mismatch", `staged tree does not match the plan: ${bad.slice(0, 20).join(", ")}`, bad.slice(0, 50));
	}
}

/** True when a create was already renamed into place and holds exactly the planned tree. */
async function createAlreadyApplied(destRoot: string, plan: ProjectPlan): Promise<boolean> {
	const stat = await fs.lstat(destRoot).catch(() => undefined);
	if (!stat?.isDirectory()) return false;
	return verifyStaging(destRoot, plan).then(() => true, () => false);
}

/** True when the undo manifest records a finished apply of exactly this plan. */
async function updateAlreadyApplied(undoDir: string, plan: ProjectPlan): Promise<boolean> {
	// "undo.json" is the manifest file name written by applyProjectUpdate.
	const undo = await readJsonFile(path.join(undoDir, "undo.json"), MAX_UNDO_BYTES).catch(() => undefined);
	return isObject(undo) && undo.status === "applied" && undo.planDigest === plan.digest;
}

async function opPublishProject(ctx: Ctx): Promise<Record<string, unknown>> {
	const { req, deps } = ctx;
	const operationId = reqOperationId(req);
	const mode = req.mode;
	if (mode !== "create" && mode !== "update" && mode !== "session-only") throw invalid("mode is malformed");
	const policy = readPolicy(deps, req.policy);
	const record = await loadRecord(ctx, operationId);
	const destRoot = await validateDestinationPath(checkPath(req.destRoot, "destRoot"), policy);
	if (record.destinationProject !== undefined) {
		const project = await validateDestinationPath(record.destinationProject, builtinPolicy(deps));
		if (project !== destRoot) throw new HelperError("destination-mismatch", "destRoot is not the operation's destination project");
	}

	const markerFile = path.join(opDir(ctx, operationId), "project-published.json");
	const applyingFile = path.join(opDir(ctx, operationId), "project-applying.json");
	const marker = await readJsonFile(markerFile, MAX_ARRIVAL_BYTES);
	if (marker !== undefined) {
		if (isObject(marker) && marker.restored === true) {
			throw new HelperError("project-restored", "the project change was restored; this operation cannot publish or launch it again");
		}
		if (isObject(marker) && marker.mode === mode && marker.destRoot === destRoot) {
			return { mode, destRoot, undo: marker.undo ?? null, replayed: true };
		}
		throw new HelperError("already-published", "this operation already published a different project change");
	}

	if (mode === "session-only") {
		const stat = await fs.stat(destRoot).catch(() => undefined);
		if (!stat?.isDirectory()) throw new HelperError("destination-missing", "session-only requires an existing project directory");
		return { mode, destRoot, undo: summarisePlan(undefined, null) };
	}

	assertStateAtMost(record, "publishing");
	const plan = checkPlan(req.plan, mode, record, req);
	const undoDir = undoDirOf(ctx, operationId);
	const finish = async (undo: Record<string, unknown>, replayed: boolean): Promise<Record<string, unknown>> => {
		await writeJsonPrivate(markerFile, { mode, destRoot, undo, planDigest: plan.digest, at: new Date().toISOString() });
		return { mode, destRoot, undo, ...(replayed && { replayed: true }) };
	};

	// A previous call that wrote the applying marker may have finished before it could write the final one.
	const applying = await readJsonFile(applyingFile, MAX_ARRIVAL_BYTES).catch(() => undefined);
	if (isObject(applying) && applying.mode === mode && applying.destRoot === destRoot && applying.planDigest === plan.digest) {
		const done = mode === "create" ? await createAlreadyApplied(destRoot, plan) : await updateAlreadyApplied(undoDir, plan);
		if (done) return finish(summarisePlan(plan, mode === "create" ? null : undoDir), true);
	}

	const staging = projectStagingOf(ctx, operationId);
	const stagingStat = await fs.lstat(staging).catch(() => undefined);
	if (!stagingStat?.isDirectory()) throw new HelperError("staging-missing", "no project staging directory; run stage-dir first");
	await requireReservation(ctx, record);

	const writeApplying = () =>
		writeJsonPrivate(applyingFile, { mode, destRoot, planDigest: plan.digest, at: new Date().toISOString() });
	let undo: Record<string, unknown>;
	if (mode === "create") {
		if (await fs.lstat(destRoot).then(() => true, () => false)) {
			throw new ProjectSyncError("destination-exists", `destination already exists: ${destRoot}`);
		}
		await verifyStaging(staging, plan);
		await advanceTo(ctx.journal, operationId, "publishing", "publish-project");
		try {
			await writeApplying();
			await fs.chmod(staging, 0o777 & ~process.umask());
			await publishNewProject(staging, destRoot);
		} catch (error) {
			await recordFailure(ctx, operationId, error);
			throw error;
		}
		undo = summarisePlan(plan, null);
	} else {
		const rootStat = await fs.stat(destRoot).catch(() => undefined);
		if (!rootStat?.isDirectory()) throw new HelperError("destination-missing", "update requires an existing project directory");
		await advanceTo(ctx.journal, operationId, "publishing", "publish-project");
		try {
			await ensurePrivateDir(undoDir);
			await writeApplying();
			await applyProjectUpdate({ stagingDir: staging, destRoot, plan, undoDir });
		} catch (error) {
			await recordFailure(ctx, operationId, error);
			throw error;
		}
		undo = summarisePlan(plan, undoDir);
	}
	return finish(undo, false);
}

type LaunchPhase = "attempt" | "spawning" | "spawned" | "failed";
const LAUNCH_PHASES: readonly string[] = ["attempt", "spawning", "spawned", "failed"];

/**
 * `launch.json` tracks one launch attempt: "attempt" (intent about to be consumed), "spawning" (written
 * immediately before ompc starts; a spawn may exist from here on), "spawned" or "failed" (nothing started).
 */
interface LaunchMarker {
	nonce: string;
	pid: number | null;
	phase: LaunchPhase;
	/** Same as `phase === "failed"`. */
	failed: boolean;
}

/** Undefined only when there is no marker; a damaged marker throws. */
async function readLaunchMarker(ctx: Ctx, operationId: string): Promise<LaunchMarker | undefined> {
	const value = await readJsonFile(path.join(opDir(ctx, operationId), "launch.json"), MAX_ARRIVAL_BYTES);
	if (value === undefined) return undefined;
	if (!isObject(value) || typeof value.nonce !== "string") throw new HelperError("invalid-record", "launch.json is malformed");
	// A marker without a phase predates the phases and was written after a successful spawn.
	const phase: LaunchPhase =
		value.failed === true ? "failed" : typeof value.phase === "string" && LAUNCH_PHASES.includes(value.phase) ? (value.phase as LaunchPhase) : "spawned";
	return { nonce: value.nonce, pid: typeof value.pid === "number" ? value.pid : null, phase, failed: phase === "failed" };
}

/**
 * "failed" or "not-started" when the consumed launch intent provably never reached the spawn
 * (no `spawning` marker was written); false when a spawn may exist or the marker is unreadable.
 */
async function launchNotStarted(ctx: Ctx, operationId: string, record: OperationRecord): Promise<"failed" | "not-started" | false> {
	const launch = record.launch;
	if (launch?.status !== "consumed") return false;
	let marker: LaunchMarker | undefined;
	try {
		marker = await readLaunchMarker(ctx, operationId);
	} catch {
		return false;
	}
	if (!marker) return "not-started";
	if (!nonceEquals(marker.nonce, launch.nonce)) return false;
	if (marker.phase === "failed") return "failed";
	return marker.phase === "attempt" ? "not-started" : false;
}

async function opLaunch(ctx: Ctx): Promise<Record<string, unknown>> {
	const { req, deps, journal } = ctx;
	const operationId = reqOperationId(req);
	const nonce = reqNonce(req);
	const name = reqPattern(req, "name", NAME_PATTERN);
	const sessionFileRaw = checkPath(req.sessionFile, "sessionFile");
	if (!sessionFileRaw.endsWith(".jsonl")) throw invalid("sessionFile must be a .jsonl journal");

	return journal.withOperationLock(operationId, async () => {
		const record = await loadRecord(ctx, operationId);
		const launch = record.launch;
		if (launch?.status === "cancelled") {
			throw new HelperError("launch-cancelled", "the launch intent was cancelled; this launch is refused");
		}
		if (launch && !nonceEquals(launch.nonce, nonce)) {
			throw new HelperError("launch-intent-exists", "the operation has a launch intent with a different nonce");
		}
		let retrying = false;
		if (launch?.status === "consumed") {
			const marker = await readLaunchMarker(ctx, operationId);
			if (marker && !nonceEquals(marker.nonce, nonce)) {
				throw new HelperError("launch-already-consumed", "the launch marker belongs to a different launch; reconcile with verify-arrival");
			}
			if (marker?.phase === "spawned") return { launched: true, replayed: true, pid: marker.pid, state: record.state };
			if (marker?.phase === "spawning") {
				throw new HelperError("launch-already-consumed", "a spawn may have started; reconcile with verify-arrival");
			}
			// "attempt", "failed" or no marker: no spawn was recorded, so the same launch may run again.
			retrying = true;
		}
		if (isAbortState(record.state) || record.state === "completed" || FORWARD.indexOf(record.state) < FORWARD.indexOf("publishing")) {
			throw new HelperError("bad-state", `Operation ${operationId} is ${record.state}; nothing has been imported to launch`);
		}
		const imported = await readJsonFile(path.join(opDir(ctx, operationId), "import.json"), MAX_ARRIVAL_BYTES);
		if (!isObject(imported) || typeof imported.sessionFile !== "string") {
			throw new HelperError("not-imported", "no imported session recorded for this operation");
		}
		if (imported.sessionFile !== sessionFileRaw) throw new HelperError("session-mismatch", "sessionFile is not the imported session");
		const sessionFileStat = await fs.lstat(sessionFileRaw).catch(() => undefined);
		if (!sessionFileStat?.isFile()) throw new HelperError("session-file-missing", "imported session file does not exist");
		if (record.projectMode !== "session-only") {
			const published = await readJsonFile(path.join(opDir(ctx, operationId), "project-published.json"), MAX_ARRIVAL_BYTES);
			if (published === undefined) throw new HelperError("project-not-published", "the project has not been published");
			if (isObject(published) && published.restored === true) {
				throw new HelperError("project-restored", "the project change was restored; launching would run against a reverted project");
			}
		}
		const cwd = await checkCwd(ctx, record, req.cwd, true);
		const ompc = deps.resolveOmpc();
		if (!ompc) throw new HelperError("ompc-missing", "ompc is not installed on the destination");

		await ensurePrivateDir(opDir(ctx, operationId));
		const markerFile = path.join(opDir(ctx, operationId), "launch.json");
		const writeMarker = (phase: LaunchPhase, extra: Record<string, unknown> = {}) =>
			writeJsonPrivate(markerFile, {
				nonce,
				phase,
				...(phase === "failed" && { failed: true }),
				...extra,
				at: new Date().toISOString(),
			});

		if (!retrying) {
			try {
				await journal.recordLaunchIntent(operationId, nonce);
			} catch (error) {
				if (error instanceof JournalError && error.code === "launch-intent-settled") {
					throw new HelperError("launch-cancelled", "the launch intent is already settled");
				}
				throw error;
			}
		}
		// The attempt is recorded before the intent is consumed, so a consumed intent always has a marker.
		await writeMarker("attempt");
		if (!retrying && !(await journal.consumeLaunchIntent(operationId, nonce))) {
			throw new HelperError("launch-cancelled", "the launch intent was cancelled; this launch is refused");
		}
		let spawnStarted = false;
		try {
			await advanceTo(journal, operationId, "destination-starting", "launch");
			await ompOk(ctx, ["session", "release", record.sessionId, "--operation", operationId, "--json"]);
			const ompBin = deps.resolveOmpBin();
			await writeMarker("spawning");
			spawnStarted = true;
			const spawned = await deps.spawnDetached(ompc, ["--detach", "--new", name, "--resume", sessionFileRaw], {
				cwd,
				env: {
					...deps.env,
					...(ompBin ? { OMP_BIN: ompBin } : {}),
					OMPC_TRANSFER_OPERATION: operationId,
					OMPC_TRANSFER_NONCE: nonce,
				},
			});
			if (spawned.exitCode !== null && spawned.exitCode !== 0) {
				throw new HelperError(
					"launch-failed",
					`ompc exited ${spawned.exitCode}${spawned.stderr ? `: ${spawned.stderr.trim().slice(0, 500)}` : ""}`,
				);
			}
			await writeMarker("spawned", { pid: spawned.pid ?? null });
			return { launched: true, pid: spawned.pid ?? null, state: "destination-starting" };
		} catch (error) {
			// Any failure before the spawn call, or a spawn that definitely did not start, leaves a retryable marker.
			// Any other failure after "spawning" keeps that marker: a spawn may exist, so no second one is allowed.
			if (!spawnStarted || (error instanceof HelperError && error.code === "launch-failed")) {
				const message = error instanceof Error ? error.message : String(error);
				await writeMarker("failed", { error: message.slice(0, 500) }).catch(() => {});
			}
			await recordFailure(ctx, operationId, error);
			throw error;
		}
	});
}

/** Cancels the launch intent; with none recorded, a cancelled tombstone is written so a late launch is refused. */
async function cancelIntent(
	ctx: Ctx,
	operationId: string,
): Promise<{ result: "cancelled" | "already-consumed" | "none"; tombstoned: boolean }> {
	const { journal } = ctx;
	return journal.withOperationLock(operationId, async () => {
		const record = await journal.load(operationId);
		if (!record) return { result: "none", tombstoned: false };
		let result = await journal.cancelLaunchIntent(operationId);
		if (result !== "none" || record.state === "completed") return { result, tombstoned: false };
		await journal.recordLaunchIntent(operationId, `cancelled-${randomBytes(12).toString("hex")}`);
		result = await journal.cancelLaunchIntent(operationId);
		return { result, tombstoned: true };
	});
}

async function opCancelLaunch(ctx: Ctx): Promise<Record<string, unknown>> {
	const operationId = reqOperationId(ctx.req);
	const { result, tombstoned } = await cancelIntent(ctx, operationId);
	return { result, tombstoned };
}

async function opVerifyArrival(ctx: Ctx): Promise<Record<string, unknown>> {
	const { req, deps } = ctx;
	const operationId = reqOperationId(req);
	const nonce = reqNonce(req);
	const sessionId = reqSessionId(req);
	const cwd = checkPath(req.cwd, "cwd");
	const record = await loadRecord(ctx, operationId);
	const notArrived = (reason: string): Record<string, unknown> => ({
		arrived: false,
		reason,
		hostId: null,
		label: null,
		pid: null,
	});
	if (record.sessionId !== sessionId) throw new HelperError("session-mismatch", "sessionId does not match the operation");
	if (record.launch?.status !== "consumed") return notArrived("launch-not-consumed");
	if (!nonceEquals(record.launch.nonce, nonce)) return notArrived("nonce-mismatch");

	let arrival: unknown;
	try {
		arrival = await readJsonFile(path.join(opDir(ctx, operationId), "arrival.json"), MAX_ARRIVAL_BYTES);
	} catch (error) {
		return notArrived(error instanceof HelperError ? "arrival-unreadable" : "arrival-error");
	}
	if (arrival === undefined) return notArrived("no-arrival-record");
	if (!isObject(arrival)) return notArrived("arrival-malformed");
	if (typeof arrival.nonce !== "string" || !nonceEquals(arrival.nonce, nonce)) return notArrived("nonce-mismatch");
	if (arrival.sessionId !== sessionId) return notArrived("session-mismatch");
	if (typeof arrival.cwd !== "string") return notArrived("arrival-malformed");
	const canonical = async (p: string) => fs.realpath(p).catch(() => path.resolve(p));
	if ((await canonical(arrival.cwd)) !== (await canonical(cwd))) return notArrived("cwd-mismatch");
	if (typeof arrival.pid !== "number" || !Number.isInteger(arrival.pid) || arrival.pid <= 0) return notArrived("arrival-malformed");
	const exited = !deps.pidAlive(arrival.pid);
	return {
		arrived: true,
		exited,
		hostId: typeof arrival.hostId === "string" ? arrival.hostId : null,
		label: typeof arrival.label === "string" ? arrival.label : null,
		pid: arrival.pid,
	};
}

async function opStatus(ctx: Ctx): Promise<Record<string, unknown>> {
	const operationId = reqOperationId(ctx.req);
	const record = await ctx.journal.load(operationId);
	if (!record) return { record: null, reservation: null, launch: null, launched: null };
	let reservation: unknown = null;
	let reservationError: string | undefined;
	try {
		reservation = (await ompOk(ctx, ["session", "reservation", record.sessionId, "--json"])).reservation ?? null;
	} catch (error) {
		reservationError = error instanceof HelperError ? error.code : "internal";
	}
	const marker = await readLaunchMarker(ctx, operationId).catch(() => undefined);
	return {
		record,
		reservation,
		...(reservationError !== undefined && { reservationError }),
		launch: record.launch ?? null,
		launched: marker?.phase === "spawned" ? { pid: marker.pid } : null,
		launchFailed: marker?.phase === "failed",
		launchPhase: marker?.phase ?? null,
	};
}

async function opRestoreProject(ctx: Ctx): Promise<Record<string, unknown>> {
	const operationId = reqOperationId(ctx.req);
	await loadRecord(ctx, operationId);
	const { restored, conflicts } = await restoreProjectUpdate(undoDirOf(ctx, operationId));
	// Any restore attempt invalidates the published marker: the project no longer matches what was imported for.
	const markerFile = path.join(opDir(ctx, operationId), "project-published.json");
	const marker = await readJsonFile(markerFile, MAX_ARRIVAL_BYTES).catch(() => undefined);
	const flagged = isObject(marker);
	if (flagged) await writeJsonPrivate(markerFile, { ...marker, restored: true, restoredAt: new Date().toISOString() });
	return { restored, conflicts, publishedMarkerFlagged: flagged };
}

/** A reservation held by `operationId` for a session whose operation record does not exist. */
async function releaseOrphan(ctx: Ctx, operationId: string, sessionId: string): Promise<Record<string, unknown>> {
	const held = (await ompOk(ctx, ["session", "reservation", sessionId, "--json"])).reservation;
	let released = false;
	if (isObject(held) && held.operationId === operationId && held.role === "destination") {
		await ompOk(ctx, ["session", "release", sessionId, "--operation", operationId, "--json"]);
		released = true;
	}
	return { state: "no-record", released };
}

interface ImportedRemoval {
	removed: string[];
	kept: boolean;
	reason?: string;
}

/**
 * Removes the session journal and artifact directory this operation imported, never touching anything
 * else: only paths recorded in import.json, only when the import created them, and only when they
 * resolve directly inside the destination's session directory. A pre-existing or unknown copy is kept.
 */
async function removeImported(ctx: Ctx, record: OperationRecord): Promise<ImportedRemoval> {
	const importFile = path.join(opDir(ctx, record.operationId), "import.json");
	let imported: unknown;
	try {
		imported = await readJsonFile(importFile, MAX_ARRIVAL_BYTES);
	} catch {
		return { removed: [], kept: true, reason: "import-record-unreadable" };
	}
	if (imported === undefined) return { removed: [], kept: false };
	if (!isObject(imported) || typeof imported.sessionFile !== "string" || typeof imported.cwd !== "string") {
		return { removed: [], kept: true, reason: "import-record-unreadable" };
	}
	if (imported.removed === true) return { removed: [], kept: false };
	if (imported.mode !== "created") {
		return { removed: [], kept: true, reason: imported.mode === "replaced" ? "replaced-existing-copy" : "pre-existing-copy-unknown" };
	}
	const sessionFile = imported.sessionFile;
	const stem = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : undefined;
	if (
		!path.isAbsolute(sessionFile) ||
		stem === undefined ||
		!path.basename(sessionFile).endsWith(`_${record.sessionId}.jsonl`) ||
		(imported.artifactsDir !== null && imported.artifactsDir !== stem)
	) {
		return { removed: [], kept: true, reason: "unexpected-import-paths" };
	}
	const located = await ompOk(ctx, ["session", "locate", record.sessionId, "--cwd", imported.cwd, "--json"]);
	if (typeof located.sessionDir !== "string") return { removed: [], kept: true, reason: "sessions-dir-unknown" };
	const sessionDir = await fs.realpath(located.sessionDir).catch(() => undefined);
	if (sessionDir === undefined) return { removed: [], kept: true, reason: "sessions-dir-unknown" };

	const targets: { target: string; kind: "file" | "dir" }[] = [{ target: sessionFile, kind: "file" }];
	if (imported.artifactsDir !== null) targets.push({ target: stem, kind: "dir" });
	const present: string[] = [];
	for (const { target, kind } of targets) {
		const stat = await fs.lstat(target).catch(() => undefined);
		if (!stat) continue;
		const expected = kind === "file" ? stat.isFile() : stat.isDirectory();
		const real = expected ? await fs.realpath(target).catch(() => undefined) : undefined;
		if (!expected || real === undefined || path.dirname(real) !== sessionDir || path.basename(real) !== path.basename(target)) {
			return { removed: [], kept: true, reason: "outside-sessions-dir" };
		}
		present.push(target);
	}
	for (const target of present) await fs.rm(target, { recursive: true, force: true });
	await writeJsonPrivate(importFile, { ...imported, removed: true, removedAt: new Date().toISOString() });
	return { removed: present, kept: false };
}

async function opRollback(ctx: Ctx): Promise<Record<string, unknown>> {
	const { journal } = ctx;
	const operationId = reqOperationId(ctx.req);
	const sessionId = ctx.req.sessionId === undefined ? undefined : reqSessionId(ctx.req);
	return journal.withOperationLock(operationId, async () => {
		const record = await journal.load(operationId);
		if (!record) {
			if (sessionId === undefined) throw new HelperError("operation-not-found", `Operation ${operationId} not found`);
			return releaseOrphan(ctx, operationId, sessionId);
		}
		if (record.role !== "destination") throw new HelperError("bad-record", `Operation ${operationId} is not a destination record`);
		if (sessionId !== undefined && record.sessionId !== sessionId) {
			throw new HelperError("session-mismatch", "sessionId does not match the operation");
		}
		if (record.state === "rolled-back") return { state: "rolled-back", replayed: true };
		if (record.state === "completed") {
			throw new HelperError("bad-state", `Operation ${operationId} is completed and cannot be rolled back`);
		}
		const notStarted = await launchNotStarted(ctx, operationId, record);
		let result: string;
		if (notStarted) {
			result = notStarted === "failed" ? "launch-failed" : "launch-not-started";
		} else {
			result = (await cancelIntent(ctx, operationId)).result;
			if (result === "already-consumed") {
				throw new HelperError("launch-already-consumed", "the destination launch already started; roll back by reverse transfer");
			}
		}
		const imported = await removeImported(ctx, record);
		await ompOk(ctx, ["session", "release", record.sessionId, "--operation", operationId, "--json"]);
		if (record.state !== "aborting") await journal.transition(operationId, "aborting", "rollback");
		await journal.transition(operationId, "rolled-back", "rollback");
		return {
			state: "rolled-back",
			cancelled: result,
			importedRemoved: imported.removed,
			importedCopyKept: imported.kept,
			...(imported.reason !== undefined && { importedKeptReason: imported.reason }),
		};
	});
}

async function opRelease(ctx: Ctx): Promise<Record<string, unknown>> {
	const { journal } = ctx;
	const operationId = reqOperationId(ctx.req);
	return journal.withOperationLock(operationId, async () => {
		const record = await loadRecord(ctx, operationId);
		if (record.state === "completed") return { state: "completed", replayed: true };
		if (record.state !== "destination-starting") {
			throw new HelperError("bad-state", `Operation ${operationId} is ${record.state}; destination-starting is required`);
		}
		await ompOk(ctx, ["session", "release", record.sessionId, "--operation", operationId, "--json"]);
		await journal.transition(operationId, "completed", "release");
		return { state: "completed" };
	});
}

async function removeTree(ctx: Ctx, target: string): Promise<boolean> {
	const stat = await fs.lstat(target).catch(() => undefined);
	if (!stat) return false;
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new HelperError("stage-unsafe", `${target} is not a directory`);
	if (!target.startsWith(`${ctx.deps.journalDir}${path.sep}`)) throw new HelperError("stage-unsafe", "refusing to remove outside the journal directory");
	await fs.rm(target, { recursive: true, force: true });
	return true;
}

async function opCleanup(ctx: Ctx): Promise<Record<string, unknown>> {
	const operationId = reqOperationId(ctx.req);
	const removeBackups = optionalBool(ctx.req, "removeBackups");
	const record = await loadRecord(ctx, operationId);
	if (removeBackups && record.state !== "completed" && record.state !== "rolled-back") {
		throw new HelperError("bad-state", "backups are removed only after the operation completed or rolled back");
	}
	const stagingRemoved = await removeTree(ctx, stageRoot(ctx, operationId));
	const backupsRemoved = removeBackups ? await removeTree(ctx, undoDirOf(ctx, operationId)) : false;
	return { stagingRemoved, backupsRemoved };
}

/**
 * Runs `handler` under an exclusive per-operation lock. A second call for the same operation while
 * one runs gets the retryable `op-busy` instead of waiting.
 */
function locked(handler: Handler): Handler {
	return async (ctx) => {
		const operationId = reqOperationId(ctx.req);
		let lock: { release(): Promise<void> };
		try {
			lock = await ctx.journal.acquireWorkerLock(operationId);
		} catch (error) {
			if (error instanceof JournalError && error.code === "worker-active") {
				throw new HelperError("op-busy", `Operation ${operationId} has another call in progress; retry`, { retryable: true });
			}
			throw error;
		}
		try {
			return await handler(ctx);
		} finally {
			await lock.release().catch(() => {});
		}
	};
}

const HANDLERS = new Map<string, Handler>([
	["hello", opHello],
	["inspect", opInspect],
	["reserve", opReserve],
	["stage-dir", opStageDir],
	["import-session", locked(opImportSession)],
	["publish-project", locked(opPublishProject)],
	["launch", locked(opLaunch)],
	["cancel-launch", opCancelLaunch],
	["verify-arrival", opVerifyArrival],
	["status", opStatus],
	["restore-project", locked(opRestoreProject)],
	["rollback", locked(opRollback)],
	["release", opRelease],
	["cleanup", locked(opCleanup)],
]);

// -------------------------------------------------------------- entry points

function failureReply(error: unknown, log: (line: string) => void): HelperReply {
	if (error instanceof HelperError) return { ok: false, code: error.code, message: error.message, ...error.extra };
	if (error instanceof ProjectSyncError) {
		return { ok: false, code: error.code, message: error.message, ...(error.paths.length > 0 && { paths: error.paths }) };
	}
	if (error instanceof JournalError) {
		return { ok: false, code: error.code === "not-found" ? "operation-not-found" : error.code, message: error.message };
	}
	const message = error instanceof Error ? error.message : String(error);
	log(`internal error: ${error instanceof Error ? (error.stack ?? message) : message}`);
	return { ok: false, code: "internal", message };
}

/** Handles one request. Never throws. */
export async function runHelper(request: unknown, overrides: Partial<HelperDeps> = {}): Promise<HelperReply> {
	const deps = createDeps(overrides);
	try {
		if (!isObject(request)) throw invalid("request must be a JSON object");
		if (request.protocol !== HELPER_PROTOCOL) {
			throw new HelperError("protocol", `helper speaks protocol ${HELPER_PROTOCOL}, request used ${JSON.stringify(request.protocol) ?? "none"}`);
		}
		const handler = typeof request.op === "string" ? HANDLERS.get(request.op) : undefined;
		if (!handler) throw new HelperError("unknown-op", "unknown op");
		const reply = await handler({ deps, journal: new OperationJournal(deps.journalDir), req: request });
		return { ok: true, ...reply };
	} catch (error) {
		const reply = failureReply(error, deps.log);
		if (!reply.ok) deps.log(`${isObject(request) && typeof request.op === "string" ? request.op : "request"} failed: ${reply.code}`);
		return reply;
	}
}

async function readRequest(stdin: AsyncIterable<Uint8Array | string>, maxBytes: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const read = (async () => {
		for await (const chunk of stdin) {
			const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
			total += buffer.length;
			if (total > maxBytes) throw new HelperError("request-too-large", `request exceeds ${maxBytes} bytes`);
			chunks.push(buffer);
		}
	})();
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(invalid("timed out reading the request")), STDIN_TIMEOUT_MS);
	});
	try {
		await Promise.race([read, timeout]);
	} finally {
		clearTimeout(timer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") throw invalid("empty request");
	try {
		return JSON.parse(text);
	} catch {
		throw invalid("request is not valid JSON");
	}
}

export interface MainOptions {
	stdin?: AsyncIterable<Uint8Array | string>;
	write?: (text: string) => void;
	maxBytes?: number;
	deps?: Partial<HelperDeps>;
}

/** Reads one JSON request, writes exactly one JSON line, returns the reply. */
export async function main(options: MainOptions = {}): Promise<HelperReply> {
	if (!options.write) {
		// Nothing but the reply may reach stdout.
		const toStderr = (...args: unknown[]) => {
			process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
		};
		console.log = toStderr;
		console.info = toStderr;
		console.debug = toStderr;
	}
	const write = options.write ?? ((text: string) => void process.stdout.write(text));
	let reply: HelperReply;
	try {
		const request = await readRequest(options.stdin ?? process.stdin, options.maxBytes ?? MAX_REQUEST_BYTES);
		reply = await runHelper(request, options.deps);
	} catch (error) {
		reply = failureReply(error, (line) => process.stderr.write(`ompc-transfer-helper: ${line}\n`));
	}
	write(`${JSON.stringify(reply)}\n`);
	return reply;
}
