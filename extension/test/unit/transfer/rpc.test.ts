import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcCode } from "../../../src/protocol.js";
import type { TransferConfig } from "../../../src/transfer/config.js";
import { OperationJournal } from "../../../src/transfer/journal.js";
import {
	type RunResult,
	type TransferContext,
	type TransferRpc,
	type TransferRpcDeps,
	type TransferSpawner,
	clearArrivalEnv,
	createTransferRpc,
	isTransferAvailable,
	writeArrivalRecord,
} from "../../../src/transfer/rpc.js";

const WORKER = "/opt/omp-connected/bin/ompc-send";
const TOKEN = "worker-token-secret";
const RENEWAL = "renewal-secret-value";

const destination = {
	hostId: "user@worker-host",
	ssh: { target: "user@worker-host", port: 22 },
	helperPath: ".local/bin/ompc-transfer-helper",
	allowedRoots: ["~"],
	protectedPaths: ["~/.ssh"],
};

function config(enabled: boolean): TransferConfig {
	return { enabled, destinations: { "worker-a": destination, "worker-b": { ...destination, hostId: "user@other-host" } } };
}

let journalDir: string;
let rpcs: TransferRpc[];

beforeEach(async () => {
	journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-transfer-rpc-"));
	rpcs = [];
});

afterEach(async () => {
	for (const rpc of rpcs) rpc.dispose();
	await fs.rm(journalDir, { recursive: true, force: true });
});

interface SpawnerState {
	runs: string[][];
	detached: string[][];
	/** Parsed plan request file, read while `run` is in flight. */
	planRequest?: unknown;
	planRequestMode?: number;
	runResult: RunResult;
	detachError?: Error;
}

const PLAN_OUTPUT = JSON.stringify({ planId: "plan-1", digest: "digest-1", plan: { entries: [] }, preflight: {} });

function fakeSpawner(): { spawner: TransferSpawner; state: SpawnerState } {
	const state: SpawnerState = {
		runs: [],
		detached: [],
		runResult: { code: 0, stdout: PLAN_OUTPUT, stderr: "", timedOut: false },
	};
	const spawner: TransferSpawner = {
		async run(argv) {
			state.runs.push([...argv]);
			const file = argv[3];
			state.planRequest = JSON.parse(await fs.readFile(file, "utf8"));
			state.planRequestMode = (await fs.stat(file)).mode & 0o777;
			return state.runResult;
		},
		async detach(argv) {
			state.detached.push([...argv]);
			if (state.detachError) throw state.detachError;
		},
	};
	return { spawner, state };
}

interface ContextState {
	idle: boolean;
	pending: boolean;
	jobs: number;
	sessionId: string;
}

function harness(
	options: {
		enabled?: boolean;
		extraBlockers?: () => string[];
		shutdown?: () => void;
		pollIntervalMs?: number;
		hubUrl?: () => string | undefined;
	} = {},
) {
	const { spawner, state } = fakeSpawner();
	const ctxState: ContextState = { idle: true, pending: false, jobs: 0, sessionId: "session-1" };
	const ctx = {
		isIdle: () => ctxState.idle,
		hasPendingMessages: () => ctxState.pending,
		getAsyncJobSnapshot: () => ({ running: Array.from({ length: ctxState.jobs }, () => ({})), recent: [], delivery: {} }),
		sessionManager: {
			getSessionId: () => ctxState.sessionId,
			getSessionFile: () => "/home/user/.omp/sessions/session-1.jsonl",
			getCwd: () => "/home/user/project",
		},
	} as unknown as TransferContext;
	const enabled = { value: options.enabled ?? true };
	const shutdowns: number[] = [];
	const deps: TransferRpcDeps = {
		context: () => ctx,
		sessionName: () => "My title",
		hostId: "user@source-host",
		instanceId: () => "instance-1",
		launcherName: "project.a",
		shutdown:
			options.shutdown ??
			(() => {
				shutdowns.push(Date.now());
			}),
		extraBlockers: options.extraBlockers,
		hubUrl: options.hubUrl,
		loadConfig: async () => config(enabled.value),
		journalDir,
		workerPath: WORKER,
		spawner,
		// Tests drive the poller with `pollNow`; the timer never fires first.
		pollIntervalMs: options.pollIntervalMs ?? 3_600_000,
	};
	const rpc = createTransferRpc(deps);
	rpcs.push(rpc);
	return { rpc, state, ctxState, enabled, shutdowns };
}

function commitParams(overrides: Record<string, unknown> = {}) {
	return {
		planId: "plan-1",
		planDigest: "digest-1",
		projectMode: "session-only",
		acceptIncomplete: false,
		operation: { id: "op-1", token: TOKEN, renewalSecret: RENEWAL, hubUrl: "http://hub-host:8787" },
		...overrides,
	};
}

async function rpcCode(promise: Promise<unknown>): Promise<number | undefined> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: number }).code;
	}
	return undefined;
}

async function rpcError(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected a rejection");
}

async function committed(options: Parameters<typeof harness>[0] = {}) {
	const h = harness(options);
	await h.rpc.plan({ destination: "worker-a" });
	const result = await h.rpc.commit(commitParams());
	return { ...h, result };
}

const opDir = (id = "op-1") => path.join(journalDir, id);
const writeStopRequest = (body: unknown = { requestedAt: "2026-11-21T00:00:00Z" }, id = "op-1") =>
	fs.writeFile(path.join(opDir(id), "stop-request.json"), JSON.stringify(body));
const readAck = async (id = "op-1") => JSON.parse(await fs.readFile(path.join(opDir(id), "stop-ack.json"), "utf8"));

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await Bun.sleep(5);
	}
}

test("destinations lists configured names and host labels only", async () => {
	const { rpc } = harness();
	const result = await rpc.destinations({});
	expect(result).toEqual({
		enabled: true,
		destinations: [
			{ name: "worker-a", hostId: "user@worker-host" },
			{ name: "worker-b", hostId: "user@other-host" },
		],
	});
	expect(JSON.stringify(result)).not.toContain("ssh");
});

test("destinations reports disabled with no destinations when transfer is off", async () => {
	const { rpc } = harness({ enabled: false });
	expect(await rpc.destinations({})).toEqual({ enabled: false, destinations: [] });
});

test("plan writes the session facts to a private request file and returns the worker's JSON", async () => {
	const { rpc, state } = harness();
	const result = await rpc.plan({ destination: "worker-a", projectMode: "update", destinationPath: "/home/user/other" });
	expect(result).toEqual({ planId: "plan-1", digest: "digest-1", plan: { entries: [] }, preflight: {} });
	expect(state.runs).toHaveLength(1);
	const argv = state.runs[0];
	expect(argv.slice(0, 3)).toEqual([WORKER, "plan", "--request"]);
	expect(argv[4]).toBe("--json");
	expect(argv.join(" ")).not.toContain(TOKEN);
	expect(state.planRequestMode).toBe(0o600);
	expect(state.planRequest).toEqual({
		destination: "worker-a",
		projectMode: "update",
		destinationPath: "/home/user/other",
		session: {
			sessionId: "session-1",
			sessionFile: "/home/user/.omp/sessions/session-1.jsonl",
			cwd: "/home/user/project",
			title: "My title",
			launcherName: "project.a",
			pid: process.pid,
			hostId: "user@source-host",
			instanceId: "instance-1",
		},
	});
	// The request file does not outlive the call.
	expect(existsSync(argv[3])).toBe(false);
});

test("plan rejects bad input and a disabled config before spawning", async () => {
	const { rpc, state, enabled } = harness();
	expect(await rpcCode(rpc.plan({ destination: "nope" }))).toBe(RpcCode.NotFound);
	expect(await rpcCode(rpc.plan({}))).toBe(RpcCode.Invalid);
	expect(await rpcCode(rpc.plan({ destination: "worker-a", projectMode: "overwrite" }))).toBe(RpcCode.Invalid);
	expect(await rpcCode(rpc.plan({ destination: "worker-a", destinationPath: "" }))).toBe(RpcCode.Invalid);
	enabled.value = false;
	expect(await rpcCode(rpc.plan({ destination: "worker-a" }))).toBe(RpcCode.Forbidden);
	expect(state.runs).toHaveLength(0);
});

test("plan maps worker failures, timeouts and unreadable output to internal errors", async () => {
	const { rpc, state } = harness();
	state.runResult = { code: 2, stdout: JSON.stringify({ ok: false, code: "x", message: "destination unreachable" }), stderr: "", timedOut: false };
	const failure = await rpcError(rpc.plan({ destination: "worker-a" }));
	expect((failure as { code?: number }).code).toBe(RpcCode.Internal);
	expect(failure.message).toBe("destination unreachable");

	state.runResult = { code: null, stdout: "", stderr: "", timedOut: true };
	expect(await rpcCode(rpc.plan({ destination: "worker-a" }))).toBe(RpcCode.Internal);

	state.runResult = { code: null, stdout: "", stderr: "", timedOut: false, error: "ENOENT" };
	expect((await rpcError(rpc.plan({ destination: "worker-a" }))).message).toContain("ENOENT");

	state.runResult = { code: 0, stdout: "not json", stderr: "", timedOut: false };
	expect(await rpcCode(rpc.plan({ destination: "worker-a" }))).toBe(RpcCode.Internal);

	state.runResult = { code: 0, stdout: JSON.stringify({ planId: "../x", digest: "d" }), stderr: "", timedOut: false };
	expect(await rpcCode(rpc.plan({ destination: "worker-a" }))).toBe(RpcCode.Internal);
});

test("commit writes request.json with mode 0600 and spawns the worker without secrets in argv", async () => {
	const { state, result } = await committed();
	expect(result).toEqual({ operationId: "op-1" });
	expect(state.detached).toEqual([[WORKER, "run", "--operation", "op-1"]]);
	expect(state.detached.flat().join(" ")).not.toContain(TOKEN);
	expect(state.detached.flat().join(" ")).not.toContain(RENEWAL);

	const file = path.join(opDir(), "request.json");
	expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	expect((await fs.stat(opDir())).mode & 0o777).toBe(0o700);
	expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
		operationId: "op-1",
		hubUrl: "http://hub-host:8787/",
		token: TOKEN,
		renewalSecret: RENEWAL,
		planId: "plan-1",
		planDigest: "digest-1",
		projectMode: "session-only",
		acceptIncomplete: false,
		destination: "worker-a",
		session: {
			sessionId: "session-1",
			sessionFile: "/home/user/.omp/sessions/session-1.jsonl",
			cwd: "/home/user/project",
			title: "My title",
			launcherName: "project.a",
			pid: process.pid,
			hostId: "user@source-host",
			instanceId: "instance-1",
		},
	});
});

test("commit refuses while transfer is disabled", async () => {
	const { rpc, state, enabled } = harness();
	await rpc.plan({ destination: "worker-a" });
	enabled.value = false;
	expect(await rpcCode(rpc.commit(commitParams()))).toBe(RpcCode.Forbidden);
	expect(state.detached).toHaveLength(0);
	expect(existsSync(opDir())).toBe(false);
});

test("commit validates ids, digest, mode, credentials and plan identity before touching disk", async () => {
	const { rpc, state } = harness();
	await rpc.plan({ destination: "worker-a" });
	const op = (over: Record<string, unknown>) => ({ ...commitParams().operation, ...over });
	const invalid: Record<string, unknown>[] = [
		commitParams({ planId: "../plan" }),
		commitParams({ planId: 5 }),
		commitParams({ planDigest: "bad digest;" }),
		commitParams({ projectMode: "overwrite" }),
		commitParams({ acceptIncomplete: "yes" }),
		commitParams({ operation: "op-1" }),
		commitParams({ operation: op({ id: "../escape" }) }),
		commitParams({ operation: op({ id: "plans" }) }),
		commitParams({ operation: op({ id: "plan-requests" }) }),
		commitParams({ operation: op({ id: "a/b" }) }),
		commitParams({ operation: op({ token: "" }) }),
		commitParams({ operation: op({ renewalSecret: "line\nbreak" }) }),
		commitParams({ operation: op({ hubUrl: "file:///etc/passwd" }) }),
		commitParams({ operation: op({ hubUrl: "not a url" }) }),
	];
	for (const params of invalid) expect(await rpcCode(rpc.commit(params))).toBe(RpcCode.Invalid);
	expect(await rpcCode(rpc.commit(commitParams({ planId: "plan-unknown" })))).toBe(RpcCode.NotFound);
	expect(await rpcCode(rpc.commit(commitParams({ planDigest: "digest-2" })))).toBe(RpcCode.Changed);
	expect(state.detached).toHaveLength(0);
	expect(await fs.readdir(journalDir)).not.toContain("op-1");
});

test("commit refuses a project mode that differs from an explicitly planned one", async () => {
	const { rpc } = harness();
	await rpc.plan({ destination: "worker-a", projectMode: "update" });
	expect(await rpcCode(rpc.commit(commitParams({ projectMode: "session-only" })))).toBe(RpcCode.Changed);
	expect((await rpc.commit(commitParams({ projectMode: "update" }))).operationId).toBe("op-1");
});

test("a second commit is refused while the first operation is active, and for an existing operation id", async () => {
	const { rpc, state } = await committed();
	const second = commitParams({ operation: { ...commitParams().operation, id: "op-2" } });
	expect(await rpcCode(rpc.commit(second))).toBe(RpcCode.Exists);
	expect(await rpcCode(rpc.commit(commitParams()))).toBe(RpcCode.Exists);
	expect(state.detached).toHaveLength(1);
	expect(existsSync(opDir("op-2"))).toBe(false);
});

test("concurrent commits start exactly one worker", async () => {
	const { rpc, state } = harness();
	await rpc.plan({ destination: "worker-a" });
	const results = await Promise.allSettled([
		rpc.commit(commitParams()),
		rpc.commit(commitParams({ operation: { ...commitParams().operation, id: "op-2" } })),
	]);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(state.detached).toHaveLength(1);
});

test("commit refuses a busy session with the reasons and writes nothing", async () => {
	const { rpc, state, ctxState } = harness();
	await rpc.plan({ destination: "worker-a" });
	ctxState.idle = false;
	ctxState.pending = true;
	const error = await rpcError(rpc.commit(commitParams()));
	expect((error as { code?: number }).code).toBe(RpcCode.Busy);
	expect(error.message).toContain("working");
	expect(error.message).toContain("queued");
	expect(state.detached).toHaveLength(0);
	expect(existsSync(opDir())).toBe(false);
});

test("a spawner failure removes the request file, leaks no credentials and allows a retry", async () => {
	const { rpc, state } = harness();
	await rpc.plan({ destination: "worker-a" });
	state.detachError = Object.assign(new Error(`failed with ${TOKEN}`), { code: "ENOENT" });
	const error = await rpcError(rpc.commit(commitParams()));
	expect((error as { code?: number }).code).toBe(RpcCode.Internal);
	expect(error.message).toContain("ENOENT");
	expect(error.message).not.toContain(TOKEN);
	expect(existsSync(opDir())).toBe(false);

	state.detachError = undefined;
	expect((await rpc.commit(commitParams())).operationId).toBe("op-1");
});

test("a stop request on an idle session is acknowledged on disk before the session shuts down", async () => {
	const order: string[] = [];
	const { rpc } = await committed({
		shutdown: () => order.push(existsSync(path.join(opDir(), "stop-ack.json")) ? "ack-then-shutdown" : "shutdown-first"),
	});
	await rpc.pollNow();
	expect(existsSync(path.join(opDir(), "stop-ack.json"))).toBe(false);

	await writeStopRequest();
	await rpc.pollNow();
	expect(await readAck()).toEqual({ ok: true });
	expect((await fs.stat(path.join(opDir(), "stop-ack.json"))).mode & 0o777).toBe(0o600);
	expect(order).toEqual(["ack-then-shutdown"]);

	// Polling ended with the acknowledgement.
	await rpc.pollNow();
	expect(order).toHaveLength(1);
});

test("the ack stays on disk when the shutdown hook throws", async () => {
	const { rpc } = await committed({
		shutdown: () => {
			throw new Error("shutdown failed");
		},
	});
	await writeStopRequest();
	await rpc.pollNow();
	expect(await readAck()).toEqual({ ok: true });
});

test("a busy session answers not-ok with a reason and keeps running", async () => {
	const { rpc, ctxState, shutdowns } = await committed();
	ctxState.idle = false;
	await writeStopRequest();
	await rpc.pollNow();
	const ack = await readAck();
	expect(ack.ok).toBe(false);
	expect(ack.reasons).toEqual(["the session is working"]);
	expect(shutdowns).toHaveLength(0);
});

test("pending messages, background jobs and extra blockers are reported together", async () => {
	let blockers: string[] = [];
	const { rpc, ctxState, shutdowns } = await committed({ extraBlockers: () => blockers });
	blockers = ["scheduled prompts are waiting"];
	ctxState.pending = true;
	ctxState.jobs = 2;
	await writeStopRequest();
	await rpc.pollNow();
	const ack = await readAck();
	expect(ack.ok).toBe(false);
	expect(ack.reasons).toEqual([
		"the session has queued messages",
		"2 background jobs are running",
		"scheduled prompts are waiting",
	]);
	expect(shutdowns).toHaveLength(0);
});

test("a changed session id blocks the stop", async () => {
	const { rpc, ctxState, shutdowns } = await committed();
	ctxState.sessionId = "session-2";
	await writeStopRequest();
	await rpc.pollNow();
	expect((await readAck()).reasons).toEqual(["the active session changed"]);
	expect(shutdowns).toHaveLength(0);
});

test("an answered request is not answered again, but a new request is re-evaluated", async () => {
	const { rpc, ctxState, shutdowns } = await committed();
	ctxState.idle = false;
	await writeStopRequest({ attempt: 1 });
	await rpc.pollNow();
	const ackPath = path.join(opDir(), "stop-ack.json");
	await fs.rm(ackPath);

	// Same request, now idle: the earlier answer stands and nothing is rewritten.
	ctxState.idle = true;
	await rpc.pollNow();
	expect(existsSync(ackPath)).toBe(false);
	expect(shutdowns).toHaveLength(0);

	await writeStopRequest({ attempt: 2 });
	await rpc.pollNow();
	expect(await readAck()).toEqual({ ok: true });
	expect(shutdowns).toHaveLength(1);
});

test("a half-written stop request is ignored until it parses", async () => {
	const { rpc, shutdowns } = await committed();
	await fs.writeFile(path.join(opDir(), "stop-request.json"), '{"requested');
	await rpc.pollNow();
	expect(existsSync(path.join(opDir(), "stop-ack.json"))).toBe(false);
	await writeStopRequest();
	await rpc.pollNow();
	expect(await readAck()).toEqual({ ok: true });
	expect(shutdowns).toHaveLength(1);
});

test("polling stops once the operation record is terminal", async () => {
	const { rpc, shutdowns } = await committed();
	const journal = new OperationJournal(journalDir);
	await journal.create({
		operationId: "op-1",
		role: "source",
		sessionId: "session-1",
		planDigest: "digest-1",
		projectMode: "session-only",
	});
	await journal.transition("op-1", "aborting");
	await journal.transition("op-1", "rolled-back");
	await writeStopRequest();
	await rpc.pollNow();
	expect(existsSync(path.join(opDir(), "stop-ack.json"))).toBe(false);
	expect(shutdowns).toHaveLength(0);
});

test("a non-terminal operation record does not stop polling", async () => {
	const { rpc, shutdowns } = await committed();
	const journal = new OperationJournal(journalDir);
	await journal.create({
		operationId: "op-1",
		role: "source",
		sessionId: "session-1",
		planDigest: "digest-1",
		projectMode: "session-only",
	});
	await writeStopRequest();
	await rpc.pollNow();
	expect(await readAck()).toEqual({ ok: true });
	expect(shutdowns).toHaveLength(1);
});

// Real timers on purpose: this test covers the poll timer itself, which `pollNow` bypasses.
test("the timer polls on its own and dispose ends it", async () => {
	const { shutdowns } = await committed({ pollIntervalMs: 10 });
	await writeStopRequest({ attempt: 1 });
	await waitFor(() => existsSync(path.join(opDir(), "stop-ack.json")));
	expect(await readAck()).toEqual({ ok: true });
	await waitFor(() => shutdowns.length === 1);

	const second = harness({ pollIntervalMs: 10 });
	await second.rpc.plan({ destination: "worker-a" });
	await second.rpc.commit(commitParams({ operation: { ...commitParams().operation, id: "op-9" } }));
	second.rpc.dispose();
	await writeStopRequest({ attempt: 1 }, "op-9");
	await Bun.sleep(80);
	expect(existsSync(path.join(opDir("op-9"), "stop-ack.json"))).toBe(false);
});

test("polling stops when the session context is gone", async () => {
	const { spawner } = fakeSpawner();
	let live = true;
	const ctx = {
		isIdle: () => true,
		hasPendingMessages: () => false,
		getAsyncJobSnapshot: () => null,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/home/user/.omp/sessions/session-1.jsonl",
			getCwd: () => "/home/user/project",
		},
	} as unknown as TransferContext;
	let shutdowns = 0;
	const rpc = createTransferRpc({
		context: () => (live ? ctx : undefined),
		sessionName: () => undefined,
		hostId: "user@source-host",
		instanceId: () => "instance-1",
		shutdown: () => {
			shutdowns += 1;
		},
		loadConfig: async () => config(true),
		journalDir,
		workerPath: WORKER,
		spawner,
		pollIntervalMs: 3_600_000,
	});
	rpcs.push(rpc);
	await rpc.plan({ destination: "worker-a" });
	await rpc.commit(commitParams());
	live = false;
	await writeStopRequest();
	await rpc.pollNow();
	expect(existsSync(path.join(opDir(), "stop-ack.json"))).toBe(false);
	expect(shutdowns).toBe(0);
});

test("arrival.json is written only when both environment variables are set", async () => {
	const base = { journalDir, sessionId: "session-1", cwd: "/home/user/project", hostId: "user@worker-host", label: "project.a" };
	expect(await writeArrivalRecord({ ...base, env: {} })).toBe(false);
	expect(await writeArrivalRecord({ ...base, env: { OMPC_TRANSFER_OPERATION: "op-1" } })).toBe(false);
	expect(await writeArrivalRecord({ ...base, env: { OMPC_TRANSFER_NONCE: "nonce-1" } })).toBe(false);
	expect(existsSync(opDir())).toBe(false);

	expect(await writeArrivalRecord({ ...base, pid: 4242, env: { OMPC_TRANSFER_OPERATION: "op-1", OMPC_TRANSFER_NONCE: "nonce-1" } })).toBe(true);
	const file = path.join(opDir(), "arrival.json");
	expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
		nonce: "nonce-1",
		sessionId: "session-1",
		cwd: "/home/user/project",
		pid: 4242,
		hostId: "user@worker-host",
		label: "project.a",
	});
	expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	expect((await fs.readdir(opDir())).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("arrival.json refuses ids that could escape the journal directory", async () => {
	const base = { journalDir, sessionId: "session-1", cwd: "/home/user/project", hostId: "user@worker-host", label: undefined };
	for (const [operation, nonce] of [
		["../escape", "nonce-1"],
		["plans", "nonce-1"],
		["op-1", "bad nonce"],
	]) {
		expect(
			await writeArrivalRecord({ ...base, env: { OMPC_TRANSFER_OPERATION: operation, OMPC_TRANSFER_NONCE: nonce } }),
		).toBe(false);
	}
	expect(await fs.readdir(journalDir)).toEqual([]);
});

test("a missing label is recorded as null", async () => {
	await writeArrivalRecord({
		journalDir,
		sessionId: "session-1",
		cwd: "/home/user/project",
		hostId: "user@worker-host",
		label: undefined,
		env: { OMPC_TRANSFER_OPERATION: "op-1", OMPC_TRANSFER_NONCE: "nonce-1" },
	});
	expect(JSON.parse(await fs.readFile(path.join(opDir(), "arrival.json"), "utf8")).label).toBeNull();
});

test("transfer is available only when enabled in config and the worker exists", async () => {
	const worker = path.join(journalDir, "ompc-send");
	expect(await isTransferAvailable({ loadConfig: async () => config(true), workerPath: worker })).toBe(false);
	await fs.writeFile(worker, "#!/bin/sh\n");
	expect(await isTransferAvailable({ loadConfig: async () => config(true), workerPath: worker })).toBe(true);
	expect(await isTransferAvailable({ loadConfig: async () => config(false), workerPath: worker })).toBe(false);
});

test("a stop request withdrawn after the ok ack turns the ack into a nack and does not shut down", async () => {
	let hook: (() => void) | undefined;
	const { rpc, shutdowns } = await committed({
		extraBlockers: () => {
			hook?.();
			return [];
		},
	});
	await writeStopRequest();
	hook = () => rmSync(path.join(opDir(), "stop-request.json"), { force: true });
	await rpc.pollNow();
	expect(await readAck()).toEqual({ ok: false, reasons: ["the stop request was withdrawn"] });
	expect(shutdowns).toHaveLength(0);
});

test("an operation that is aborting turns the ok ack into a nack and does not shut down", async () => {
	const { rpc, shutdowns } = await committed();
	const journal = new OperationJournal(journalDir);
	await journal.create({
		operationId: "op-1",
		role: "source",
		sessionId: "session-1",
		planDigest: "digest-1",
		projectMode: "session-only",
	});
	await journal.transition("op-1", "aborting");
	await writeStopRequest();
	await rpc.pollNow();
	expect(await readAck()).toEqual({ ok: false, reasons: ["the transfer is being cancelled"] });
	expect(shutdowns).toHaveLength(0);
});

test("work that arrives between the ok ack and the shutdown is reported and blocks the shutdown", async () => {
	let evaluations = 0;
	const { rpc, shutdowns } = await committed({ extraBlockers: () => (evaluations++ === 0 ? [] : ["late work"]) });
	evaluations = 0;
	await writeStopRequest();
	await rpc.pollNow();
	expect(await readAck()).toEqual({ ok: false, reasons: ["late work"] });
	expect(shutdowns).toHaveLength(0);
});

test("commit gives the worker the extension's own hub URL, not the one in the request", async () => {
	const { rpc } = harness({ hubUrl: () => "http://own-hub:9000" });
	await rpc.plan({ destination: "worker-a" });
	await rpc.commit(commitParams());
	const request = JSON.parse(await fs.readFile(path.join(opDir(), "request.json"), "utf8"));
	expect(request.hubUrl).toBe("http://own-hub:9000/");
	expect(request.token).toBe(TOKEN);
});

test("commit uses its own hub URL even when the request carries none or an unusable one", async () => {
	const { rpc } = harness({ hubUrl: () => "https://own-hub" });
	await rpc.plan({ destination: "worker-a" });
	const operation = { id: "op-1", token: TOKEN, renewalSecret: RENEWAL, hubUrl: "file:///etc/passwd" };
	await rpc.commit(commitParams({ operation }));
	const request = JSON.parse(await fs.readFile(path.join(opDir(), "request.json"), "utf8"));
	expect(request.hubUrl).toBe("https://own-hub/");
});

test("commit falls back to the request's hub URL when the extension has none or an unusable one", async () => {
	for (const [id, own] of [
		["op-a", undefined],
		["op-b", "ws://own-hub:9000"],
	] as const) {
		const { rpc } = harness({ hubUrl: () => own });
		await rpc.plan({ destination: "worker-a" });
		await rpc.commit(commitParams({ operation: { ...commitParams().operation, id } }));
		const request = JSON.parse(await fs.readFile(path.join(opDir(id), "request.json"), "utf8"));
		expect(request.hubUrl).toBe("http://hub-host:8787/");
	}
});

test("commit refuses when neither the extension nor the request has a usable hub URL", async () => {
	const { rpc, state } = harness({ hubUrl: () => undefined });
	await rpc.plan({ destination: "worker-a" });
	const operation = { id: "op-1", token: TOKEN, renewalSecret: RENEWAL };
	expect(await rpcCode(rpc.commit(commitParams({ operation })))).toBe(RpcCode.Invalid);
	expect(state.detached).toHaveLength(0);
	expect(existsSync(opDir())).toBe(false);
});

test("clearArrivalEnv removes both arrival variables and leaves others", () => {
	const env: NodeJS.ProcessEnv = { OMPC_TRANSFER_OPERATION: "op-1", OMPC_TRANSFER_NONCE: "nonce-1", KEEP: "1" };
	clearArrivalEnv(env);
	expect(env).toEqual({ KEEP: "1" });
});
