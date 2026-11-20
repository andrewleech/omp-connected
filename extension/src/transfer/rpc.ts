// Extension half of send-to-host: `transfer.*` RPC methods, the stop handshake
// polled on behalf of the detached source worker, and the destination arrival
// record. The extension never transfers anything itself; it spawns `ompc-send`.

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { RpcCode, RpcError, paramsRecord } from "../protocol.js";
import { type TransferConfig, TransferConfigError, getDestination, loadTransferConfig } from "./config.js";
import {
	OPERATION_ID_PATTERN,
	OperationJournal,
	type ProjectMode,
	defaultJournalDir,
	isTerminalState,
} from "./journal.js";

/** Advertised only when transfer is enabled in config and the worker binary exists. */
export const TRANSFER_FEATURE = "session.transfer.v1";

/** Stop-request poll period. */
export const STOP_POLL_INTERVAL_MS = 500;
/** `transfer.plan` deadline; the hub's RPC deadline is 30 s. */
export const PLAN_TIMEOUT_MS = 25_000;

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PLANS = 16;
const PLAN_REQUESTS_DIR = "plan-requests";
/** Names under the journal directory that are not operation directories. */
const RESERVED_OPERATION_IDS: readonly string[] = ["plans", PLAN_REQUESTS_DIR];
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9:_.-]{1,256}$/;
const PROJECT_MODES: readonly ProjectMode[] = ["create", "session-only", "update"];
const MAX_SECRET_LENGTH = 4096;
const MAX_PATH_LENGTH = 4096;

export interface RunResult {
	/** Exit code, or null when the process was killed or never started. */
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Set when the process could not be started. */
	error?: string;
}

/** Process launching, injectable so tests need no worker binary. */
export interface TransferSpawner {
	/** Runs `argv` to completion, killing it after `timeoutMs`. Never rejects. */
	run(argv: readonly string[], options: { timeoutMs: number }): Promise<RunResult>;
	/** Starts `argv` detached with stdio ignored; rejects when it cannot start. */
	detach(argv: readonly string[]): Promise<void>;
}

export const nodeSpawner: TransferSpawner = {
	run(argv, { timeoutMs }) {
		const { promise, resolve } = Promise.withResolvers<RunResult>();
		const [command, ...args] = argv;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let child: ChildProcess | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			child?.kill("SIGKILL");
		}, timeoutMs);
		const finish = (result: RunResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			finish({ code: null, stdout, stderr, timedOut, error: errorCode(error) });
			return promise;
		}
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
		});
		child.once("error", (error) => finish({ code: null, stdout, stderr, timedOut, error: errorCode(error) }));
		child.once("close", (code) => finish({ code, stdout, stderr, timedOut }));
		return promise;
	},
	detach(argv) {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const [command, ...args] = argv;
		try {
			const child = spawn(command, args, { detached: true, stdio: "ignore" });
			// Stays attached after `spawn` so a late error never goes unhandled.
			child.on("error", reject);
			child.once("spawn", () => {
				child.unref();
				resolve();
			});
		} catch (error) {
			reject(error);
		}
		return promise;
	},
};

function errorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" ? code : "spawn failed";
}

/** The `ompc-send` launcher shipped next to `ompc`. */
export function defaultWorkerPath(): string {
	return fileURLToPath(new URL("../../bin/ompc-send", import.meta.url));
}

/** True when transfer is enabled in config and the worker binary exists. */
export async function isTransferAvailable(
	options: { loadConfig?: () => Promise<TransferConfig>; workerPath?: string } = {},
): Promise<boolean> {
	const config = await (options.loadConfig ?? (() => loadTransferConfig()))();
	return config.enabled && existsSync(options.workerPath ?? defaultWorkerPath());
}

/** The URL when `value` is a string holding an http(s) URL. */
function httpUrl(value: unknown): URL | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

export type TransferContext = Pick<
	ExtensionContext,
	"isIdle" | "hasPendingMessages" | "getAsyncJobSnapshot" | "sessionManager"
>;

export interface TransferRpcDeps {
	/** The owner session's current context; undefined before it starts or after it ends. */
	context: () => TransferContext | undefined;
	sessionName: () => string | undefined;
	/** `user@host` of this machine, as registered with the hub. */
	hostId: string;
	/** This session's Collab instance id once discovered. */
	instanceId: () => string | undefined;
	/** The `OMPC_SESSION` launcher name, when valid. */
	launcherName?: string;
	/** Gracefully ends the owner session. Called only after `stop-ack.json` is on disk. */
	shutdown: () => void;
	/** Extra reasons the session cannot stop (scheduled prompts, open asks). */
	extraBlockers?: () => string[];
	/**
	 * The hub URL this extension connects to. The worker gets it, and with it the operation
	 * credentials, in preference to the URL the hub puts in the commit request.
	 */
	hubUrl?: () => string | undefined;
	loadConfig?: () => Promise<TransferConfig>;
	journalDir?: string;
	workerPath?: string;
	spawner?: TransferSpawner;
	pollIntervalMs?: number;
	planTimeoutMs?: number;
	logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

export interface TransferRpc {
	destinations(params: unknown): Promise<{ enabled: boolean; destinations: { name: string; hostId: string }[] }>;
	plan(params: unknown): Promise<unknown>;
	commit(params: unknown): Promise<{ operationId: string }>;
	/** Runs one stop-request check now; the timer calls this every poll interval. */
	pollNow(): Promise<void>;
	/** Stops polling. */
	dispose(): void;
}

/** The RPC-facing subset, wired into `createSessionRpc`. */
export type TransferHandlers = Pick<TransferRpc, "destinations" | "plan" | "commit">;

interface PlanMemo {
	destination: string;
	projectMode: ProjectMode | undefined;
	digest: string;
}

interface ActiveOperation {
	id: string;
	sessionId: string;
	timer: NodeJS.Timeout | undefined;
	ticking: boolean;
	/** Fingerprint of the last stop request that received an answer. */
	answered: string | undefined;
	stopped: boolean;
}

function isNonEmptyString(value: unknown, max: number): value is string {
	return typeof value === "string" && value !== "" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function checkedId(value: unknown, what: string): string {
	if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value) || RESERVED_OPERATION_IDS.includes(value)) {
		throw new RpcError(RpcCode.Invalid, `${what} is not a valid identifier`);
	}
	return value;
}

/** Writes `data` as `dir/name` through a 0600 temp file, fsync and rename. */
async function writePrivateAtomic(dir: string, name: string, data: string): Promise<void> {
	const path = join(dir, name);
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.chmod(0o600);
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
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

/** Reasons the session cannot stop now; empty when it can. */
function stopBlockers(
	ctx: TransferContext,
	operationSessionId: string,
	extra: (() => string[]) | undefined,
): string[] {
	const reasons: string[] = [];
	const check = (label: string, run: () => void): void => {
		try {
			run();
		} catch {
			reasons.push(`could not check ${label}`);
		}
	};
	check("the session identity", () => {
		if (ctx.sessionManager.getSessionId() !== operationSessionId) reasons.push("the active session changed");
	});
	check("whether the session is idle", () => {
		if (!ctx.isIdle()) reasons.push("the session is working");
	});
	check("queued messages", () => {
		if (ctx.hasPendingMessages()) reasons.push("the session has queued messages");
	});
	check("background jobs", () => {
		const running = ctx.getAsyncJobSnapshot()?.running.length ?? 0;
		if (running > 0) reasons.push(`${running} background job${running === 1 ? " is" : "s are"} running`);
	});
	check("other pending work", () => {
		reasons.push(...(extra?.() ?? []));
	});
	return reasons;
}

export function createTransferRpc(deps: TransferRpcDeps): TransferRpc {
	const journalDir = deps.journalDir ?? defaultJournalDir();
	const journal = new OperationJournal(journalDir);
	const spawner = deps.spawner ?? nodeSpawner;
	const workerPath = deps.workerPath ?? defaultWorkerPath();
	const loadConfig = deps.loadConfig ?? (() => loadTransferConfig());
	const pollIntervalMs = deps.pollIntervalMs ?? STOP_POLL_INTERVAL_MS;
	const planTimeoutMs = deps.planTimeoutMs ?? PLAN_TIMEOUT_MS;
	const plans = new Map<string, PlanMemo>();
	let active: ActiveOperation | undefined;

	function warn(message: string, fields?: Record<string, unknown>): void {
		deps.logger?.warn(message, fields);
	}

	function requireContext(): TransferContext {
		const ctx = deps.context();
		if (!ctx) throw new Error("the session is not ready");
		return ctx;
	}

	async function requireConfig(): Promise<TransferConfig> {
		let config: TransferConfig;
		try {
			config = await loadConfig();
		} catch (error) {
			if (error instanceof TransferConfigError) throw new RpcError(RpcCode.Internal, error.message);
			throw error;
		}
		if (!config.enabled) throw new RpcError(RpcCode.Forbidden, "transfer is not enabled on this host");
		return config;
	}

	function destinationName(config: TransferConfig, value: unknown): string {
		if (typeof value !== "string") throw new RpcError(RpcCode.Invalid, "destination must be a string");
		try {
			getDestination(config, value);
		} catch (error) {
			if (error instanceof TransferConfigError) {
				throw new RpcError(error.code === "disabled" ? RpcCode.Forbidden : RpcCode.NotFound, error.message);
			}
			throw error;
		}
		return value;
	}

	function projectMode(value: unknown): ProjectMode {
		if (typeof value !== "string" || !PROJECT_MODES.includes(value as ProjectMode)) {
			throw new RpcError(RpcCode.Invalid, `projectMode must be one of: ${PROJECT_MODES.join(", ")}`);
		}
		return value as ProjectMode;
	}

	function sessionFacts(ctx: TransferContext) {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) throw new RpcError(RpcCode.Invalid, "the current session is not persisted");
		const instanceId = deps.instanceId();
		if (!instanceId) throw new RpcError(RpcCode.Internal, "the session has no instance id yet");
		return {
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile,
			cwd: ctx.sessionManager.getCwd(),
			title: deps.sessionName() ?? null,
			launcherName: deps.launcherName ?? null,
			pid: process.pid,
			hostId: deps.hostId,
			instanceId,
		};
	}

	function remember(planId: string, memo: PlanMemo): void {
		plans.delete(planId);
		plans.set(planId, memo);
		while (plans.size > MAX_PLANS) {
			const oldest = plans.keys().next().value;
			if (oldest === undefined) break;
			plans.delete(oldest);
		}
	}

	function workerFailure(action: string, result: RunResult): RpcError {
		if (result.timedOut) return new RpcError(RpcCode.Internal, `the transfer worker timed out while ${action}`);
		if (result.error) return new RpcError(RpcCode.Internal, `could not start the transfer worker (${result.error})`);
		// The worker prints `{ ok: false, code, message }` on stdout when it can.
		try {
			const parsed = JSON.parse(result.stdout) as { message?: unknown };
			if (typeof parsed.message === "string" && parsed.message !== "") {
				return new RpcError(RpcCode.Internal, parsed.message.slice(0, 500));
			}
		} catch {}
		return new RpcError(RpcCode.Internal, `the transfer worker failed while ${action} (exit ${result.code})`);
	}

	async function destinations(): Promise<{ enabled: boolean; destinations: { name: string; hostId: string }[] }> {
		let config: TransferConfig;
		try {
			config = await loadConfig();
		} catch (error) {
			if (error instanceof TransferConfigError) throw new RpcError(RpcCode.Internal, error.message);
			throw error;
		}
		if (!config.enabled) return { enabled: false, destinations: [] };
		return {
			enabled: true,
			destinations: Object.entries(config.destinations).map(([name, destination]) => ({
				name,
				hostId: destination.hostId,
			})),
		};
	}

	async function plan(params: unknown): Promise<unknown> {
		const { destination, projectMode: mode, destinationPath } = paramsRecord(params);
		const config = await requireConfig();
		const name = destinationName(config, destination);
		const requestedMode = mode === undefined ? undefined : projectMode(mode);
		if (destinationPath !== undefined && !isNonEmptyString(destinationPath, MAX_PATH_LENGTH)) {
			throw new RpcError(RpcCode.Invalid, "destinationPath must be a non-empty string");
		}
		const session = sessionFacts(requireContext());
		const dir = join(journalDir, PLAN_REQUESTS_DIR);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const fileName = `${randomUUID()}.json`;
		const requestPath = join(dir, fileName);
		try {
			await writePrivateAtomic(
				dir,
				fileName,
				JSON.stringify({
					destination: name,
					...(requestedMode ? { projectMode: requestedMode } : {}),
					...(destinationPath === undefined ? {} : { destinationPath }),
					session,
				}),
			);
			const result = await spawner.run([workerPath, "plan", "--request", requestPath, "--json"], {
				timeoutMs: planTimeoutMs,
			});
			if (result.code !== 0 || result.timedOut || result.error) throw workerFailure("planning", result);
			let parsed: unknown;
			try {
				parsed = JSON.parse(result.stdout);
			} catch {
				throw new RpcError(RpcCode.Internal, "the transfer worker returned an unreadable plan");
			}
			const planned = parsed as { planId?: unknown; digest?: unknown } | null;
			if (
				typeof planned !== "object" ||
				planned === null ||
				typeof planned.planId !== "string" ||
				!OPERATION_ID_PATTERN.test(planned.planId) ||
				typeof planned.digest !== "string" ||
				!DIGEST_PATTERN.test(planned.digest)
			) {
				throw new RpcError(RpcCode.Internal, "the transfer worker returned an invalid plan");
			}
			remember(planned.planId, { destination: name, projectMode: requestedMode, digest: planned.digest });
			return parsed;
		} finally {
			await rm(requestPath, { force: true }).catch(() => undefined);
		}
	}

	/** Set while a commit is starting its worker, so two commits cannot both pass the active check. */
	let starting = false;

	async function commit(params: unknown): Promise<{ operationId: string }> {
		if (starting) throw new RpcError(RpcCode.Exists, "a transfer is already starting for this session");
		starting = true;
		try {
			return await startOperation(params);
		} finally {
			starting = false;
		}
	}

	async function startOperation(params: unknown): Promise<{ operationId: string }> {
		const { planId, planDigest, projectMode: mode, acceptIncomplete, operation } = paramsRecord(params);
		const config = await requireConfig();
		const validPlanId = checkedId(planId, "planId");
		if (typeof planDigest !== "string" || !DIGEST_PATTERN.test(planDigest)) {
			throw new RpcError(RpcCode.Invalid, "planDigest is invalid");
		}
		const chosenMode = projectMode(mode);
		if (typeof acceptIncomplete !== "boolean") throw new RpcError(RpcCode.Invalid, "acceptIncomplete must be a boolean");
		if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
			throw new RpcError(RpcCode.Invalid, "operation must be an object");
		}
		const { id, token, renewalSecret, hubUrl: suppliedHubUrl } = operation as Record<string, unknown>;
		const operationId = checkedId(id, "operation.id");
		if (!isNonEmptyString(token, MAX_SECRET_LENGTH) || !isNonEmptyString(renewalSecret, MAX_SECRET_LENGTH)) {
			throw new RpcError(RpcCode.Invalid, "operation.token and operation.renewalSecret must be non-empty strings");
		}
		const hubOrigin = httpUrl(deps.hubUrl?.()) ?? httpUrl(suppliedHubUrl);
		if (!hubOrigin) throw new RpcError(RpcCode.Invalid, "operation.hubUrl must be an http or https URL");

		const memo = plans.get(validPlanId);
		if (!memo) throw new RpcError(RpcCode.NotFound, "no such plan; plan again");
		if (memo.digest !== planDigest) throw new RpcError(RpcCode.Changed, "the plan changed; plan again");
		if (memo.projectMode !== undefined && memo.projectMode !== chosenMode) {
			throw new RpcError(RpcCode.Changed, "the project mode differs from the plan; plan again");
		}
		const destination = destinationName(config, memo.destination);

		const ctx = requireContext();
		const reasons = stopBlockers(ctx, ctx.sessionManager.getSessionId(), deps.extraBlockers);
		if (reasons.length > 0) throw new RpcError(RpcCode.Busy, `the session cannot be sent now: ${reasons.join("; ")}`);
		if (active && !active.stopped) {
			throw new RpcError(RpcCode.Exists, "a transfer is already running for this session");
		}
		const session = sessionFacts(ctx);

		await mkdir(journalDir, { recursive: true, mode: 0o700 });
		const operationDir = join(journalDir, operationId);
		try {
			await mkdir(operationDir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new RpcError(RpcCode.Exists, "this operation already exists");
			}
			throw error;
		}
		try {
			await writePrivateAtomic(
				operationDir,
				"request.json",
				JSON.stringify({
					operationId,
					hubUrl: hubOrigin.toString(),
					token,
					renewalSecret,
					planId: validPlanId,
					planDigest,
					projectMode: chosenMode,
					acceptIncomplete,
					destination,
					session,
				}),
			);
			await spawner.detach([workerPath, "run", "--operation", operationId]);
		} catch (error) {
			await rm(operationDir, { recursive: true, force: true }).catch(() => undefined);
			warn("omp-connected: could not start the transfer worker", { operationId, err: errorCode(error) });
			throw new RpcError(RpcCode.Internal, `could not start the transfer worker (${errorCode(error)})`);
		}
		startPolling(operationId, session.sessionId);
		return { operationId };
	}

	function startPolling(operationId: string, sessionId: string): void {
		stopActive();
		const op: ActiveOperation = {
			id: operationId,
			sessionId,
			timer: undefined,
			ticking: false,
			answered: undefined,
			stopped: false,
		};
		active = op;
		const schedule = (): void => {
			if (op.stopped) return;
			op.timer = setTimeout(() => {
				void pollOperation(op).finally(schedule);
			}, pollIntervalMs);
			op.timer.unref?.();
		};
		schedule();
	}

	function stopOperation(op: ActiveOperation): void {
		op.stopped = true;
		clearTimeout(op.timer);
		op.timer = undefined;
	}

	function stopActive(): void {
		if (active) stopOperation(active);
	}

	async function readStopRequest(op: ActiveOperation): Promise<string | undefined> {
		const path = join(journalDir, op.id, "stop-request.json");
		let text: string;
		let mtimeMs: number;
		try {
			[text, mtimeMs] = [await readFile(path, "utf8"), (await stat(path)).mtimeMs];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		// The worker writes it atomically; unparseable content is a write in flight.
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		} catch {
			return undefined;
		}
		return `${mtimeMs}:${text}`;
	}

	/** Reasons not to shut down after an ok ack: request withdrawn, operation cancelled, or work arrived. */
	async function lateStopBlockers(op: ActiveOperation, ctx: TransferContext): Promise<string[]> {
		const reasons: string[] = [];
		if ((await readStopRequest(op)) === undefined) reasons.push("the stop request was withdrawn");
		const record = await journal.load(op.id).catch(() => undefined);
		if (record && (record.state === "aborting" || isTerminalState(record.state))) {
			reasons.push("the transfer is being cancelled");
		}
		reasons.push(...stopBlockers(ctx, op.sessionId, deps.extraBlockers));
		return reasons;
	}

	async function pollOperation(op: ActiveOperation): Promise<void> {
		if (op.stopped || op.ticking) return;
		op.ticking = true;
		try {
			const ctx = deps.context();
			if (!ctx) {
				stopOperation(op);
				return;
			}
			const record = await journal.load(op.id).catch(() => undefined);
			if (record && isTerminalState(record.state)) {
				stopOperation(op);
				return;
			}
			const fingerprint = await readStopRequest(op);
			if (fingerprint === undefined || fingerprint === op.answered || op.stopped) return;
			const reasons = stopBlockers(ctx, op.sessionId, deps.extraBlockers);
			const dir = join(journalDir, op.id);
			if (reasons.length > 0) {
				await writePrivateAtomic(dir, "stop-ack.json", JSON.stringify({ ok: false, reasons }));
				op.answered = fingerprint;
				return;
			}
			await writePrivateAtomic(dir, "stop-ack.json", JSON.stringify({ ok: true }));
			op.answered = fingerprint;
			// The worker may have cancelled, or the session may have changed, since the ack was written.
			const late = await lateStopBlockers(op, ctx);
			if (late.length > 0) {
				await writePrivateAtomic(dir, "stop-ack.json", JSON.stringify({ ok: false, reasons: late }));
				return;
			}
			stopOperation(op);
			// The ack is on disk; the worker now waits for this process to exit.
			try {
				deps.shutdown();
			} catch (error) {
				warn("omp-connected: shutdown for a transfer failed after the stop was acknowledged", {
					operationId: op.id,
					err: error instanceof Error ? error.message : String(error),
				});
			}
		} catch (error) {
			warn("omp-connected: transfer stop check failed", {
				operationId: op.id,
				err: error instanceof Error ? error.message : String(error),
			});
		} finally {
			op.ticking = false;
		}
	}

	return {
		destinations,
		plan,
		commit,
		pollNow: async () => {
			if (active) await pollOperation(active);
		},
		dispose: stopActive,
	};
}

export interface ArrivalOptions {
	env?: NodeJS.ProcessEnv;
	journalDir?: string;
	sessionId: string;
	cwd: string;
	hostId: string;
	label: string | undefined;
	pid?: number;
}

/**
 * Writes `<journalDir>/<operationId>/arrival.json` when both `OMPC_TRANSFER_OPERATION`
 * and `OMPC_TRANSFER_NONCE` are set and well formed. Returns whether it wrote.
 */
export async function writeArrivalRecord(options: ArrivalOptions): Promise<boolean> {
	const env = options.env ?? process.env;
	const operationId = env.OMPC_TRANSFER_OPERATION;
	const nonce = env.OMPC_TRANSFER_NONCE;
	if (!operationId || !nonce) return false;
	if (!OPERATION_ID_PATTERN.test(operationId) || RESERVED_OPERATION_IDS.includes(operationId)) return false;
	if (!NONCE_PATTERN.test(nonce)) return false;
	const dir = join(options.journalDir ?? defaultJournalDir(), operationId);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writePrivateAtomic(
		dir,
		"arrival.json",
		JSON.stringify({
			nonce,
			sessionId: options.sessionId,
			cwd: options.cwd,
			pid: options.pid ?? process.pid,
			hostId: options.hostId,
			label: options.label ?? null,
		}),
	);
	return true;
}

/** Removes the arrival variables so child processes of the session cannot rewrite the record. */
export function clearArrivalEnv(env: NodeJS.ProcessEnv = process.env): void {
	delete env.OMPC_TRANSFER_OPERATION;
	delete env.OMPC_TRANSFER_NONCE;
}
