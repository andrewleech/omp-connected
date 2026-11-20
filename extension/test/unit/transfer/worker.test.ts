import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { createHubClient, createNoopHubClient } from "../../../src/transfer/hub-client.js";
import { OperationJournal, type OperationRecord, type TransferState } from "../../../src/transfer/journal.js";
import { buildHelperArgv, buildRsyncArgv, SSH_FIXED_OPTIONS, SshError } from "../../../src/transfer/ssh.js";
import {
	DEFAULT_TIMING,
	main,
	parsePlanRequest,
	RECOVER_ACTIONS,
	status,
	type PlanResult,
	plan,
	recover,
	run,
	type SessionFacts,
	type WorkerContext,
	type WorkerTiming,
} from "../../../src/transfer/worker.js";

const HELPER_MODULE = resolve(import.meta.dir, "../../../src/transfer/helper.ts");
const OMPC_LAUNCHER = resolve(import.meta.dir, "../../../bin/ompc");
const BUN = process.execPath;
const SESSION_ID = "11111111-aaaa-bbbb-cccc-222222222222";
const FORWARD: TransferState[] = [
	"prepared",
	"source-stopping",
	"source-stopped",
	"staged",
	"publishing",
	"source-departed",
	"destination-starting",
	"completed",
];

const FAST: Partial<WorkerTiming> = {
	pollMs: 20,
	commandPollMs: 40,
	arrivalPollMs: 40,
	arrivalTimeoutMs: 6000,
	stopAckTimeoutMs: 4000,
	pidExitTimeoutMs: 4000,
	helperBackoffMs: 10,
	rsyncBackoffMs: 10,
	recoveryPollMs: 40,
	recoveryWaitMs: 8000,
	helperTimeoutMs: 40_000,
};

// ---------------------------------------------------------------------------
// Fake executables. The omp stub keeps its state under $HOME/.fake-omp so the
// source and the destination (a different HOME) never share anything.

const FAKE_OMP = `#!${BUN}
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const state = join(process.env.HOME, ".fake-omp");
mkdirSync(state, { recursive: true });
const args = process.argv.slice(2);
appendFileSync(join(state, "calls.jsonl"), JSON.stringify(args) + "\\n");
const faults = process.env.FAKE_FAULTS && existsSync(process.env.FAKE_FAULTS) ? JSON.parse(readFileSync(process.env.FAKE_FAULTS, "utf8")) : {};
const out = (value, code = 0) => { process.stdout.write(JSON.stringify(value) + "\\n"); process.exit(code); };
const fail = (code, message) => out({ ok: false, code, message }, 2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args[0] === "--version") { console.log("fake-omp 1.0.0"); process.exit(0); }
if (args[0] !== "session") fail("other", "unsupported command");
const action = args[1];
const dashes = args.indexOf("--");
const target = dashes >= 0 ? args[dashes + 1] : args[2];
const op = flag("--operation");
const resFile = (id) => join(state, "reservations", id + ".json");
const reservation = (id) => (existsSync(resFile(id)) ? JSON.parse(readFileSync(resFile(id), "utf8")) : null);
const guard = (id) => { const held = reservation(id); if (held && held.operationId !== op) fail("reserved", "reserved by " + held.operationId); };
const liveFile = (id) => join(state, "live", id);
const isLive = (id) => { if (!existsSync(liveFile(id))) return false; try { process.kill(Number(readFileSync(liveFile(id), "utf8")), 0); return true; } catch { return false; } };
const header = (file) => JSON.parse(readFileSync(file, "utf8").split("\\n")[0]);
const marker = (details) => JSON.stringify({ type: "custom_message", customType: "session-transfer", details }) + "\\n";
switch (action) {
	case "reserve": {
		guard(target);
		mkdirSync(dirname(resFile(target)), { recursive: true });
		writeFileSync(resFile(target), JSON.stringify({ sessionId: target, operationId: op, role: flag("--role"), createdAt: new Date().toISOString() }));
		out({ ok: true, reservation: reservation(target) });
	}
	case "release": {
		if (faults.releaseFailSource && process.env.HOME !== process.env.FAKE_DST_HOME) fail("other", "simulated release failure");
		const held = reservation(target);
		const released = Boolean(held && held.operationId === op);
		if (released) rmSync(resFile(target));
		out({ ok: true, released, reservation: reservation(target) });
	}
	case "reservation": out({ ok: true, reservation: reservation(target) });
	case "lease": {
		const ids = args.slice(args.indexOf("--") + 1);
		process.stdout.write(JSON.stringify({ held: ids.filter(isLive), unknown: [] }) + "\\n");
		process.exit(0);
	}
	case "locate": {
		const index = join(state, "sessions", target);
		out({ ok: true, sessionFile: existsSync(index) ? readFileSync(index, "utf8") : null, sessionDir: state });
	}
	case "pack": {
		const id = header(target).id;
		guard(id);
		if (isLive(id)) fail("live-owner", "the session is running");
		const pack = faults.pack ?? {};
		const text = readFileSync(target, "utf8");
		const output = flag("-o");
		writeFileSync(output, JSON.stringify({ id, journal: text }));
		out({ ok: true, archivePath: output, id, missingBlobs: pack.missingBlobs ?? [], children: 2, bytes: text.length, skippedSymlinks: [], externalReferences: pack.externalReferences ?? [] });
	}
	case "moved": {
		const id = header(target).id;
		guard(id);
		appendFileSync(target, marker({ kind: "departed", to: flag("--label"), operationId: op }));
		out({ ok: true });
	}
	case "unpack": {
		const archive = JSON.parse(readFileSync(target, "utf8"));
		guard(archive.id);
		mkdirSync(join(state, "store"), { recursive: true });
		mkdirSync(join(state, "sessions"), { recursive: true });
		const file = join(state, "store", archive.id + ".jsonl");
		const full = archive.journal + marker({ kind: "arrived", operationId: op });
		let mode = "created";
		if (existsSync(file)) {
			const old = readFileSync(file, "utf8");
			const kept = old.split("\\n").filter((line) => line && !line.includes('"departed"')).join("\\n") + "\\n";
			if (old === full) mode = "replayed";
			else if (archive.journal.startsWith(kept)) mode = "replaced";
			else fail("diverged", "a different copy exists");
		}
		writeFileSync(file, full);
		writeFileSync(join(state, "sessions", archive.id), file);
		out({ ok: true, sessionFile: file, id: archive.id, mode });
	}
	default: fail("other", "unsupported action " + action);
}
`;

const FAKE_OMPC = `#!${BUN}
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
const home = process.env.HOME;
const args = process.argv.slice(2);
const faults = process.env.FAKE_FAULTS && existsSync(process.env.FAKE_FAULTS) ? JSON.parse(readFileSync(process.env.FAKE_FAULTS, "utf8")) : {};
appendFileSync(join(home, "ompc-calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), op: process.env.OMPC_TRANSFER_OPERATION }) + "\\n");
if (faults.ompcFail) { console.error("simulated ompc failure"); process.exit(3); }
if (faults.ompcNoArrival) process.exit(0);
const file = args[args.indexOf("--resume") + 1];
const name = args[args.indexOf("--new") + 1];
const id = JSON.parse(readFileSync(file, "utf8").split("\\n")[0]).id;
const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
child.unref();
const dir = join(home, ".local", "state", "omp-connected", "transfers", process.env.OMPC_TRANSFER_OPERATION);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "arrival.json"), JSON.stringify({ nonce: process.env.OMPC_TRANSFER_NONCE, sessionId: id, cwd: process.cwd(), pid: child.pid, hostId: "user@worker-host", label: basename(process.cwd()) + "." + name }));
appendFileSync(join(home, "spawned.pids"), child.pid + "\\n");
process.exit(0);
`;

/** Stands in for ssh: runs the real helper in-process under an isolated destination HOME. */
const FAKE_SSH = `#!${BUN}
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const log = (entry) => appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(entry) + "\\n");
const faultsFile = process.env.FAKE_FAULTS;
const faults = faultsFile && existsSync(faultsFile) ? JSON.parse(readFileSync(faultsFile, "utf8")) : {};
const take = (key, times) => {
	if (!times) return false;
	const file = faultsFile + ".counters";
	const counters = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	if ((counters[key] ?? 0) >= times) return false;
	counters[key] = (counters[key] ?? 0) + 1;
	writeFileSync(file, JSON.stringify(counters));
	return true;
};
let i = 0;
while (i < argv.length) {
	const a = argv[i];
	if (a === "--") { i++; break; }
	if (a === "-o" || a === "-p" || a === "-i" || a === "-l") { i += 2; continue; }
	if (a.startsWith("-")) { console.error("fake-ssh: unexpected option " + a); process.exit(250); }
	break;
}
const remote = argv.slice(i + 1);
log({ ssh: argv, remote });
if (faults.sshDown) process.exit(255);
const dstHome = process.env.FAKE_DST_HOME;
const env = { ...process.env, HOME: dstHome, PATH: join(dstHome, "bin") + ":" + process.env.PATH, OMP_BIN: join(dstHome, "bin", "omp") };
delete env.XDG_STATE_HOME;
delete env.XDG_CONFIG_HOME;
if (remote[0] === "rsync") {
	if (take("rsyncDrop", faults.rsyncDrop)) process.exit(255);
	if (faults.rsyncDelayMs) await new Promise((resolve) => setTimeout(resolve, faults.rsyncDelayMs));
	process.exit(spawnSync(remote[0], remote.slice(1), { stdio: "inherit", env }).status ?? 255);
}
const request = JSON.parse(readFileSync(0, "utf8"));
const { plan: _plan, ...loggable } = request;
const source = process.env.FAKE_SRC_SESSION_FILE;
log({ helper: request.op, request: loggable, srcDeparted: Boolean(source && readFileSync(source, "utf8").includes('"departed"')) });
if (faults.sshDrop && faults.sshDrop.op === request.op && take("sshDrop", faults.sshDrop.times)) process.exit(255);
if (faults.busy && faults.busy.op === request.op && take("busy", faults.busy.times)) {
	process.stdout.write(JSON.stringify({ ok: false, code: "op-busy", message: "the operation is busy" }) + "\\n");
	process.exit(0);
}
if (faults.override && faults.override[request.op]) {
	process.stdout.write(JSON.stringify(faults.override[request.op]) + "\\n");
	process.exit(0);
}
const { runHelper } = await import(${JSON.stringify(HELPER_MODULE)});
const reply = await runHelper(request, {
	env,
	home: dstHome,
	hostname: () => "worker-host",
	user: () => "user",
	knownUsers: async () => [],
	gitDirty: async () => null,
	log: () => {},
});
process.stdout.write(JSON.stringify(reply) + "\\n");
process.exit(0);
`;

// ---------------------------------------------------------------------------
// Fake hub

interface FakeCommand {
	seq: number;
	type: "cancel" | "recover";
	payload: Record<string, unknown>;
	acked: boolean;
}

interface HubEvent {
	state: TransferState;
	detail?: string;
	error?: { code: string; message: string };
	progress?: Record<string, unknown>;
}

interface FakeHub {
	url: string;
	port: number;
	token: string;
	renewalSecret: string;
	events: HubEvent[];
	commands: FakeCommand[];
	commandQueries: string[];
	finished: boolean;
	renewals: number;
	renewalRevoked: boolean;
	onEvent?: (event: HubEvent) => void;
	addCommand(type: "cancel" | "recover", payload?: Record<string, unknown>): void;
	rotateToken(): void;
	stop(): void;
}

const hubs: FakeHub[] = [];

function startHub(port = 0): FakeHub {
	const hub: FakeHub = {
		url: "",
		port: 0,
		token: "token-1",
		renewalSecret: "renewal-secret",
		events: [],
		commands: [],
		commandQueries: [],
		finished: false,
		renewals: 0,
		renewalRevoked: false,
		addCommand(type, payload = {}) {
			hub.commands.push({ seq: hub.commands.length + 1, type, payload, acked: false });
		},
		rotateToken() {
			hub.token = `rotated-${Math.random().toString(36).slice(2)}`;
		},
		stop: () => undefined,
	};
	const json = (status: number, body: unknown): Response => Response.json(body, { status });
	const server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			const match = /^\/api\/transfers\/[^/]+\/worker\/(.+)$/.exec(url.pathname);
			if (!match) return json(404, { error: "not found" });
			const rest = match[1] as string;
			const auth = request.headers.get("authorization") ?? "";
			if (rest === "renew") {
				if (hub.renewalRevoked || auth !== `Bearer ${hub.renewalSecret}`) return json(401, { error: "renewal", code: "renewal-invalid" });
				hub.renewals++;
				hub.token = `renewed-${hub.renewals}`;
				return json(200, { token: hub.token, expiresAt: Date.now() + 600_000 });
			}
			if (auth !== `Bearer ${hub.token}`) return json(401, { error: "token expired", code: "token-expired" });
			if (rest === "events") {
				const event = (await request.json()) as HubEvent;
				hub.events.push(event);
				hub.onEvent?.(event);
				return json(200, { ok: true, applied: true });
			}
			if (rest === "commands") {
				hub.commandQueries.push(url.search);
				const after = Number(url.searchParams.get("after") ?? "0");
				return json(200, {
					commands: hub.commands
						.filter((command) => command.seq > after && !command.acked)
						.map(({ seq, type, payload }) => ({ seq, type, payload })),
				});
			}
			const ack = /^commands\/(\d+)\/ack$/.exec(rest);
			if (ack) {
				const command = hub.commands.find((candidate) => candidate.seq === Number(ack[1]));
				if (command) command.acked = true;
				return json(200, { ok: true });
			}
			if (rest === "finish") {
				hub.finished = true;
				hub.renewalRevoked = true;
				return json(200, { ok: true });
			}
			return json(404, { error: "not found" });
		},
	});
	hub.port = server.port as number;
	hub.url = `http://127.0.0.1:${hub.port}`;
	hub.stop = () => void server.stop(true);
	hubs.push(hub);
	return hub;
}

// ---------------------------------------------------------------------------
// Test environment

interface Env {
	root: string;
	srcHome: string;
	dstHome: string;
	journalDir: string;
	dstJournalDir: string;
	sshLog: string;
	faultsFile: string;
	sessionFile: string;
	project: string;
	destProject: string;
	title: string;
	env: NodeJS.ProcessEnv;
	ctx(extra?: WorkerContext): WorkerContext;
}

const roots: string[] = [];
const processes: Subprocess[] = [];
let opCounter = 0;

async function script(file: string, body: string): Promise<void> {
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, body);
	await chmod(file, 0o755);
}

async function setup(options: { projectName?: string; title?: string } = {}): Promise<Env> {
	const root = await mkdtemp(join(tmpdir(), "ompc-send-"));
	roots.push(root);
	const srcHome = join(root, "src-home");
	const dstHome = join(root, "dst-home");
	const projectName = options.projectName ?? "proj";
	const project = join(srcHome, "work", projectName);
	const sessionFile = join(srcHome, ".fake-omp", "store", `${SESSION_ID}.jsonl`);
	const sshLog = join(root, "ssh-log.jsonl");
	const faultsFile = join(root, "faults.json");

	await script(join(srcHome, "bin", "omp"), FAKE_OMP);
	await script(join(dstHome, "bin", "omp"), FAKE_OMP);
	await script(join(dstHome, "bin", "ompc"), FAKE_OMPC);
	await script(join(root, "fake-ssh"), FAKE_SSH);
	await writeFile(faultsFile, "{}");
	await writeFile(sshLog, "");

	await mkdir(join(project, "sub"), { recursive: true });
	await writeFile(join(project, "a.txt"), "alpha from source\n");
	await writeFile(join(project, "sub", "b.txt"), "bravo\n");
	await writeFile(join(project, ".hidden"), "hidden\n");
	await mkdir(join(srcHome, ".fake-omp", "store"), { recursive: true });
	await mkdir(join(srcHome, ".fake-omp", "sessions"), { recursive: true });
	await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: SESSION_ID, cwd: project })}\n${JSON.stringify({ type: "message", id: "m1", text: "hello" })}\n`);
	await writeFile(join(srcHome, ".fake-omp", "sessions", SESSION_ID), sessionFile);
	await mkdir(join(dstHome, ".fake-omp"), { recursive: true });

	await mkdir(join(srcHome, ".config", "omp-connected"), { recursive: true });
	await writeFile(
		join(srcHome, ".config", "omp-connected", "transfer.json"),
		JSON.stringify({
			enabled: true,
			destinations: {
				"worker-host": {
					hostId: "user@worker-host",
					ssh: { target: "user@worker-host" },
					helperPath: ".local/bin/ompc-transfer-helper",
					allowedRoots: ["~"],
				},
			},
		}),
	);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: srcHome,
		OMP_BIN: join(srcHome, "bin", "omp"),
		OMPC_TRANSFER_SSH: join(root, "fake-ssh"),
		FAKE_DST_HOME: dstHome,
		FAKE_SSH_LOG: sshLog,
		FAKE_FAULTS: faultsFile,
		FAKE_SRC_SESSION_FILE: sessionFile,
	};
	delete env.XDG_STATE_HOME;
	delete env.XDG_CONFIG_HOME;

	return {
		root,
		srcHome,
		dstHome,
		journalDir: join(srcHome, ".local", "state", "omp-connected", "transfers"),
		dstJournalDir: join(dstHome, ".local", "state", "omp-connected", "transfers"),
		sshLog,
		faultsFile,
		sessionFile,
		project,
		destProject: join(dstHome, "work", projectName),
		title: options.title ?? "My chat",
		env,
		ctx: (extra = {}) => ({ env, home: srcHome, timing: FAST, awaitRecovery: false, ...extra }),
	};
}

afterEach(async () => {
	for (const hub of hubs.splice(0)) hub.stop();
	for (const proc of processes.splice(0)) {
		try {
			proc.kill();
		} catch {
			// already gone
		}
	}
	for (const root of roots.splice(0)) {
		const pids = join(root, "dst-home", "spawned.pids");
		if (existsSync(pids)) {
			for (const pid of readFileSync(pids, "utf8").split("\n").filter(Boolean)) {
				try {
					process.kill(Number(pid));
				} catch {
					// already gone
				}
			}
		}
		await rm(root, { recursive: true, force: true });
	}
});

async function setFaults(env: Env, faults: Record<string, unknown>): Promise<void> {
	await rm(`${env.faultsFile}.counters`, { force: true });
	await writeFile(env.faultsFile, JSON.stringify(faults));
}

function facts(env: Env, pid?: number): SessionFacts {
	return {
		sessionId: SESSION_ID,
		sessionFile: env.sessionFile,
		cwd: env.project,
		title: env.title,
		launcherName: "proj.chat",
		...(pid !== undefined && { pid }),
		hostId: "user@worker-host",
		instanceId: "instance-1",
	};
}

interface CommitOptions {
	hub?: FakeHub;
	acceptIncomplete?: boolean;
	pid?: number;
	digest?: string;
	mode?: "create" | "session-only" | "update";
}

async function commit(env: Env, planned: PlanResult, options: CommitOptions = {}): Promise<string> {
	const operationId = `op-${process.pid}-${++opCounter}`;
	const dir = join(env.journalDir, operationId);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(
		join(dir, "request.json"),
		JSON.stringify({
			operationId,
			...(options.hub && { hubUrl: options.hub.url, token: options.hub.token, renewalSecret: options.hub.renewalSecret }),
			planId: planned.planId,
			planDigest: options.digest ?? planned.digest,
			projectMode: options.mode ?? planned.preflight.projectMode,
			acceptIncomplete: options.acceptIncomplete ?? false,
			destination: "worker-host",
			session: facts(env, options.pid),
		}),
	);
	return operationId;
}

async function planFor(env: Env, extra: { projectMode?: "create" | "session-only" | "update"; pid?: number } = {}): Promise<PlanResult> {
	return plan(
		{ destination: "worker-host", ...(extra.projectMode && { projectMode: extra.projectMode }), session: facts(env, extra.pid) },
		env.ctx(),
	);
}

function sshLogEntries(env: Env): Record<string, any>[] {
	return readFileSync(env.sshLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

const helperOps = (env: Env): string[] => sshLogEntries(env).flatMap((entry) => (entry.helper ? [entry.helper as string] : []));
const rsyncCalls = (env: Env): Record<string, any>[] => sshLogEntries(env).filter((entry) => entry.remote?.[0] === "rsync");
const reservationFile = (home: string): string => join(home, ".fake-omp", "reservations", `${SESSION_ID}.json`);

async function sourceRecord(env: Env, operationId: string): Promise<OperationRecord> {
	const record = await new OperationJournal(env.journalDir).load(operationId);
	if (!record) throw new Error("no source record");
	return record;
}

const states = (record: OperationRecord): TransferState[] => record.history.map((entry) => entry.state);
const dedupe = <T>(values: T[]): T[] => values.filter((value, index) => index === 0 || value !== values[index - 1]);

async function expectArrived(env: Env): Promise<void> {
	expect(readFileSync(join(env.destProject, "a.txt"), "utf8")).toBe("alpha from source\n");
	const imported = join(env.dstHome, ".fake-omp", "store", `${SESSION_ID}.jsonl`);
	expect(existsSync(imported)).toBe(true);
	expect(readFileSync(imported, "utf8")).toContain('"arrived"');
}

/** Plays the extension: answers the stop request, then (on ack) ends the owner process like `ctx.shutdown()`. */
async function fakeExtension(env: Env, operationId: string, owner: Subprocess, reply: { ok: true } | { ok: false; reasons: string[] }): Promise<void> {
	const dir = join(env.journalDir, operationId);
	for (let i = 0; i < 600 && !existsSync(join(dir, "stop-request.json")); i++) await Bun.sleep(20);
	if (!existsSync(join(dir, "stop-request.json"))) throw new Error("no stop request appeared");
	await writeFile(join(dir, "stop-ack.json"), JSON.stringify(reply));
	if (reply.ok) {
		await Bun.sleep(40);
		owner.kill();
		await owner.exited;
	}
}

async function startOwner(env: Env): Promise<Subprocess> {
	const owner = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
	processes.push(owner);
	await mkdir(join(env.srcHome, ".fake-omp", "live"), { recursive: true });
	await writeFile(join(env.srcHome, ".fake-omp", "live", SESSION_ID), String(owner.pid));
	return owner;
}

// ---------------------------------------------------------------------------
// argv construction

describe("ssh and rsync argv", () => {
	const ssh = { target: "user@worker-host" };
	const helper = ".local/bin/ompc-transfer-helper";

	test("helper call uses the fixed options and the validated helper path as the only remote command", () => {
		expect(buildHelperArgv({ ssh, helperPath: helper }, {})).toEqual(["ssh", ...SSH_FIXED_OPTIONS, "--", "user@worker-host", helper]);
		expect(SSH_FIXED_OPTIONS).toEqual([
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=yes",
			"-o",
			"ForwardAgent=no",
			"-o",
			"ClearAllForwardings=yes",
		]);
	});

	test("-p and -i appear only when configured, and OMPC_TRANSFER_SSH replaces the executable", () => {
		const bare = buildHelperArgv({ ssh, helperPath: helper }, {});
		expect(bare).not.toContain("-p");
		expect(bare).not.toContain("-i");
		const full = buildHelperArgv(
			{ ssh: { target: "user@worker-host", port: 2222, identityFile: "/home/user/.ssh/id_test" }, helperPath: helper },
			{ OMPC_TRANSFER_SSH: "/opt/fake/ssh" },
		);
		expect(full[0]).toBe("/opt/fake/ssh");
		expect(full.slice(full.indexOf("-p"), full.indexOf("-p") + 2)).toEqual(["-p", "2222"]);
		expect(full.slice(full.indexOf("-i"), full.indexOf("-i") + 2)).toEqual(["-i", "/home/user/.ssh/id_test"]);
	});

	test("no forbidden ssh option is ever produced", () => {
		const rsync = buildRsyncArgv({ ssh: { target: "user@worker-host", port: 22 }, src: "/tmp/src", filesFrom: "/tmp/list", dest: "/tmp/dest" });
		// rsync's own flags (-t keeps times) are not ssh options; only the ssh command line is checked.
		const sshTokens = [
			...buildHelperArgv({ ssh: { target: "user@worker-host", port: 22, identityFile: "/home/user/.ssh/id" }, helperPath: helper }, {}),
			...(rsync[rsync.indexOf("-e") + 1] as string).split(" "),
		];
		const text = sshTokens.join("\n");
		for (const forbidden of ["StrictHostKeyChecking=no", "StrictHostKeyChecking=accept-new", "UserKnownHostsFile", "ForwardAgent=yes", "ProxyCommand", "LocalCommand", "BatchMode=no"]) {
			expect(text).not.toContain(forbidden);
		}
		for (const forbidden of ["-A", "-t", "-tt", "-T", "-X", "-Y", "-g", "-F"]) expect(sshTokens).not.toContain(forbidden);
		expect(rsync.some((arg) => arg.startsWith("--delete"))).toBe(false);
	});

	test("hostile configuration values are rejected before anything is spawned", () => {
		const build = (override: Record<string, unknown>, helperPath = helper) =>
			buildHelperArgv({ ssh: { ...ssh, ...override } as never, helperPath }, {});
		expect(() => build({ target: "-oProxyCommand=touch /tmp/pwn" })).toThrow(SshError);
		expect(() => build({ target: "host;touch pwn" })).toThrow(SshError);
		expect(() => build({ target: "user@host name" })).toThrow(SshError);
		expect(() => build({ port: 0 })).toThrow(SshError);
		expect(() => build({ port: 70000 })).toThrow(SshError);
		expect(() => build({ port: "22; id" })).toThrow(SshError);
		expect(() => build({ identityFile: "relative/key" })).toThrow(SshError);
		expect(() => build({ identityFile: "/home/user/key\nProxyCommand=x" })).toThrow(SshError);
		expect(() => build({}, "helper; touch pwn")).toThrow(SshError);
		expect(() => build({}, "../escape")).toThrow(SshError);
		expect(() => build({}, "-oProxyCommand=x")).toThrow(SshError);
		expect(() => build({}, "")).toThrow(SshError);
	});

	test("rsync argv: files-from, no delete, no owner or group, user paths only after the separator", () => {
		const userPath = "/home/user/my proj; touch pwn";
		const argv = buildRsyncArgv({
			ssh: { target: "user@worker-host", port: 2222, identityFile: "/home/user/.ssh/id" },
			src: userPath,
			filesFrom: "/home/user/.local/state/list",
			dest: "/home/dst user/stage",
			env: { OMPC_TRANSFER_SSH: "/opt/fake/ssh" },
		});
		expect(argv[0]).toBe("rsync");
		expect(argv).toContain("--from0");
		expect(argv).toContain("--files-from=/home/user/.local/state/list");
		expect(argv).toContain("--no-owner");
		expect(argv).toContain("--no-group");
		expect(argv).toContain("-s");
		expect(argv.some((arg) => arg.startsWith("--delete"))).toBe(false);
		const separator = argv.indexOf("--");
		expect(argv.slice(separator + 1)).toEqual([`${userPath}/`, "user@worker-host:/home/dst user/stage/"]);
		expect(argv.slice(0, separator).join(" ")).not.toContain("my proj");
		const shell = argv[argv.indexOf("-e") + 1] as string;
		expect(shell.startsWith("/opt/fake/ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no -o ClearAllForwardings=yes -p 2222 -i /home/user/.ssh/id")).toBe(true);
		expect(shell).not.toContain("user@worker-host");
	});

	test("rsync refuses relative or multi-line destinations", () => {
		const base = { ssh, src: "/tmp/src", filesFrom: "/tmp/list" };
		expect(() => buildRsyncArgv({ ...base, dest: "relative/dir" })).toThrow(SshError);
		expect(() => buildRsyncArgv({ ...base, dest: "/tmp/a\n/etc" })).toThrow(SshError);
		expect(() => buildRsyncArgv({ ...base, dest: "/tmp/a", src: "relative" })).toThrow(SshError);
	});
});

// ---------------------------------------------------------------------------
// hub client

describe("hub client", () => {
	const quick = { backoffMs: 1, breakerMs: 20, retries: 1, requestTimeoutMs: 1000 };

	test("renews an expired token with the renewal secret and retries the call", async () => {
		const hub = startHub();
		const client = createHubClient({ hubUrl: hub.url, operationId: "op-1", token: hub.token, renewalSecret: hub.renewalSecret, ...quick });
		await client.event({ state: "prepared" });
		hub.rotateToken();
		await client.event({ state: "source-stopping", detail: "after expiry" });
		expect(hub.renewals).toBe(1);
		expect(hub.events.map((event) => event.state)).toEqual(["prepared", "source-stopping"]);
		await client.event({ state: "source-stopped" });
		expect(hub.renewals).toBe(1);
		expect(client.queued).toBe(0);
	});

	test("a hub outage queues events in memory and flushes them in order when it returns", async () => {
		const first = startHub();
		const { port } = first;
		const client = createHubClient({ hubUrl: first.url, operationId: "op-2", token: first.token, renewalSecret: first.renewalSecret, ...quick });
		first.stop();
		await client.event({ state: "prepared" });
		await client.event({ state: "source-stopping" });
		expect(client.queued).toBe(2);
		expect(await client.commands()).toEqual([]);
		const second = startHub(port);
		await Bun.sleep(40);
		await client.event({ state: "source-stopped" });
		expect(second.events.map((event) => event.state)).toEqual(["prepared", "source-stopping", "source-stopped"]);
		expect(client.queued).toBe(0);
	});

	test("a revoked renewal secret never throws; events stay queued", async () => {
		const hub = startHub();
		hub.renewalRevoked = true;
		const client = createHubClient({ hubUrl: hub.url, operationId: "op-3", token: "stale", renewalSecret: hub.renewalSecret, ...quick });
		await client.event({ state: "prepared" });
		expect(client.queued).toBe(1);
		expect(await client.commands()).toEqual([]);
		await client.finish();
	});

	test("commands use the acknowledged cursor and are acknowledged by sequence", async () => {
		const hub = startHub();
		hub.addCommand("cancel");
		hub.addCommand("recover", { action: "cleanup" });
		const client = createHubClient({ hubUrl: hub.url, operationId: "op-4", token: hub.token, renewalSecret: hub.renewalSecret, ...quick });
		const first = await client.commands();
		expect(first.map((command) => [command.seq, command.type])).toEqual([[1, "cancel"], [2, "recover"]]);
		await client.ack(1);
		const second = await client.commands();
		expect(second.map((command) => command.seq)).toEqual([2]);
		expect(hub.commandQueries.at(-1)).toBe("?after=1");
		expect(hub.commands[0]?.acked).toBe(true);
		await client.finish();
		expect(hub.finished).toBe(true);
	});

	test("without a hub the client records nothing", async () => {
		const client = createNoopHubClient();
		expect(client.enabled).toBe(false);
		await client.event({ state: "prepared" });
		expect(await client.commands()).toEqual([]);
		await client.finish();
	});
});

// ---------------------------------------------------------------------------
// plan

describe("plan", () => {
	test("maps the project below the home, previews the change, and stores a digest-bound plan", async () => {
		const env = await setup();
		const planned = await planFor(env);
		expect(planned.planId).toMatch(/^[0-9a-f]{32}$/);
		expect(planned.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(planned.plan.mode).toBe("create");
		expect(planned.plan.entries.map((entry) => entry.path).sort()).toEqual([".hidden", "a.txt", "sub", "sub/b.txt"]);
		expect(planned.preflight).toMatchObject({
			sessionId: SESSION_ID,
			sourceProject: env.project,
			destinationProject: env.destProject,
			destinationExists: false,
			projectMode: "create",
			live: false,
			children: 2,
			archiveEstimated: false,
			missingBlobs: [],
			externalReferences: [],
			acceptIncompleteRequired: false,
			blockers: [],
			runtimeCompatible: true,
		});
		const stored = JSON.parse(await readFile(join(env.journalDir, "plans", `${planned.planId}.json`), "utf8"));
		expect(stored.digest).toBe(planned.digest);
		expect(stored.bound.projectPlanDigest).toBe(planned.plan.digest);
		// Preflight is read-only: only hello and inspect reach the destination.
		expect(new Set(helperOps(env))).toEqual(new Set(["hello", "inspect"]));
		expect(existsSync(reservationFile(env.dstHome))).toBe(false);
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect(existsSync(env.destProject)).toBe(false);
	});

	test("an existing destination defaults to session-only and update previews replacements and kept files", async () => {
		const env = await setup();
		await mkdir(env.destProject, { recursive: true });
		await writeFile(join(env.destProject, "a.txt"), "alpha from destination\n");
		await writeFile(join(env.destProject, "extra.txt"), "only here\n");
		const sessionOnly = await planFor(env);
		expect(sessionOnly.preflight.projectMode).toBe("session-only");
		expect(sessionOnly.plan.entries).toEqual([]);
		const update = await planFor(env, { projectMode: "update" });
		expect(update.plan.entries.find((entry) => entry.path === "a.txt")?.action).toBe("replace");
		expect(update.plan.destinationOnly).toBe(1);
		expect(update.preflight.blockers).toEqual([]);
		const create = await planFor(env, { projectMode: "create" });
		expect(create.preflight.blockers.join(" ")).toContain("already exists");
	});

	test("missing blobs and outside references are reported and require acceptance", async () => {
		const env = await setup();
		await setFaults(env, { pack: { missingBlobs: ["blob-1"], externalReferences: ["/outside/parent.jsonl"] } });
		const planned = await planFor(env);
		expect(planned.preflight.missingBlobs).toEqual(["blob-1"]);
		expect(planned.preflight.externalReferences).toEqual(["/outside/parent.jsonl"]);
		expect(planned.preflight.acceptIncompleteRequired).toBe(true);
	});

	test("a running session is estimated from its files, not packed", async () => {
		const env = await setup();
		const owner = await startOwner(env);
		const planned = await planFor(env, { pid: owner.pid });
		expect(planned.preflight.live).toBe(true);
		expect(planned.preflight.archiveEstimated).toBe(true);
		expect(planned.preflight.warnings.join(" ")).toContain("running");
		const calls = readFileSync(join(env.srcHome, ".fake-omp", "calls.jsonl"), "utf8");
		expect(calls).not.toContain('"pack"');
	});

	test("hostile helper replies are rejected", async () => {
		const env = await setup();
		await setFaults(env, {
			override: {
				hello: { ok: true, home: "relative/home", hostId: "user@worker-host", ompBin: null, ompVersion: null, ompc: null, rsync: true, freeBytes: null, transferProtocol: 1 },
			},
		});
		await expect(planFor(env)).rejects.toMatchObject({ code: "bad-reply" });
		await setFaults(env, { override: { hello: { ok: true, home: env.dstHome, hostId: 5 } } });
		await expect(planFor(env)).rejects.toMatchObject({ code: "bad-reply" });
		await setFaults(env, { override: { hello: "not an object" } });
		await expect(planFor(env)).rejects.toMatchObject({ code: "bad-reply" });
	});

	test("the plan command prints one JSON object", async () => {
		const env = await setup();
		const requestFile = join(env.root, "plan-request.json");
		await writeFile(requestFile, JSON.stringify({ destination: "worker-host", session: facts(env) }));
		let stdout = "";
		const code = await main(["plan", "--request", requestFile, "--json"], env.ctx(), { out: (text) => void (stdout += text), err: () => undefined });
		expect(code).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Object.keys(parsed).sort()).toEqual(["digest", "plan", "planId", "preflight"]);
		let failure = "";
		const failed = await main(["plan", "--request", requestFile, "--json"], { ...env.ctx(), configPath: join(env.root, "missing.json") }, { out: (text) => void (failure += text), err: () => undefined });
		expect(failed).toBe(1);
		expect(JSON.parse(failure)).toMatchObject({ ok: false, code: "disabled" });
	});
});

// ---------------------------------------------------------------------------
// run: happy paths

describe("run", () => {
	test("create: every transition in strict order, hub events mirror them, departure precedes launch", async () => {
		const env = await setup();
		const hub = startHub();
		const planned = await planFor(env);
		const operationId = await commit(env, planned, { hub });
		const outcome = await run(operationId, env.ctx());
		expect(outcome).toEqual({ operationId, state: "completed" });

		const record = await sourceRecord(env, operationId);
		expect(states(record)).toEqual(FORWARD);
		expect(dedupe(hub.events.map((event) => event.state))).toEqual(FORWARD);
		expect(hub.finished).toBe(true);
		expect(hub.commands).toEqual([]);

		await expectArrived(env);
		expect(readFileSync(join(env.destProject, "sub", "b.txt"), "utf8")).toBe("bravo\n");
		expect(readFileSync(join(env.destProject, ".hidden"), "utf8")).toBe("hidden\n");
		const source = readFileSync(env.sessionFile, "utf8");
		expect(source).toContain('"departed"');
		expect(source).toContain(operationId);

		const launch = sshLogEntries(env).find((entry) => entry.helper === "launch");
		expect(launch?.srcDeparted).toBe(true);
		expect(launch?.request.name).toBe("chat");
		expect(launch?.request.cwd).toBe(env.destProject);
		expect(helperOps(env).filter((op) => op === "launch")).toHaveLength(1);
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect(existsSync(reservationFile(env.dstHome))).toBe(false);
		const destRecord = await new OperationJournal(env.dstJournalDir).load(operationId);
		expect(destRecord?.state).toBe("completed");
		expect(hub.events.some((event) => event.progress?.label === "proj.chat")).toBe(true);
	}, 90_000);

	test("session-only leaves the destination project bytes untouched and transfers no project files", async () => {
		const env = await setup();
		await mkdir(env.destProject, { recursive: true });
		await writeFile(join(env.destProject, "keep.txt"), "keep me\n");
		const planned = await planFor(env);
		expect(planned.preflight.projectMode).toBe("session-only");
		const operationId = await commit(env, planned);
		expect((await run(operationId, env.ctx())).state).toBe("completed");
		expect((await readdir(env.destProject)).sort()).toEqual(["keep.txt"]);
		expect(readFileSync(join(env.destProject, "keep.txt"), "utf8")).toBe("keep me\n");
		expect(existsSync(join(env.dstHome, ".fake-omp", "store", `${SESSION_ID}.jsonl`))).toBe(true);
		expect(rsyncCalls(env)).toHaveLength(1);
	}, 90_000);

	test("update applies the planned entries and retains destination-only files", async () => {
		const env = await setup();
		await mkdir(env.destProject, { recursive: true });
		await writeFile(join(env.destProject, "a.txt"), "alpha from destination\n");
		await writeFile(join(env.destProject, "extra.txt"), "only here\n");
		const planned = await planFor(env, { projectMode: "update" });
		const operationId = await commit(env, planned);
		expect((await run(operationId, env.ctx())).state).toBe("completed");
		expect(readFileSync(join(env.destProject, "a.txt"), "utf8")).toBe("alpha from source\n");
		expect(readFileSync(join(env.destProject, "sub", "b.txt"), "utf8")).toBe("bravo\n");
		expect(readFileSync(join(env.destProject, "extra.txt"), "utf8")).toBe("only here\n");
		expect(existsSync(join(env.dstJournalDir, operationId, "undo"))).toBe(true);
		expect(rsyncCalls(env).length).toBeGreaterThanOrEqual(2);
	}, 90_000);

	test("a project path with shell metacharacters never reaches argv", async () => {
		const env = await setup({ projectName: 'my proj; touch pwn $(id)', title: 'x"; echo hi #' });
		const planned = await planFor(env);
		const operationId = await commit(env, planned);
		expect((await run(operationId, env.ctx())).state).toBe("completed");
		expect(existsSync(join(env.destProject, "a.txt"))).toBe(true);
		expect(existsSync(join(env.destProject, "..", "pwn"))).toBe(false);
		const argv = JSON.stringify(sshLogEntries(env).flatMap((entry) => [entry.ssh, entry.remote]));
		expect(argv).not.toContain("my proj");
		expect(argv).not.toContain("touch pwn");
		expect(argv).not.toContain("echo hi");
		expect(argv).not.toContain(env.srcHome);
		expect(argv).not.toContain(env.dstHome);
	}, 90_000);

	test("a stored plan is bound to its digest, mode and facts", async () => {
		const env = await setup();
		const planned = await planFor(env);

		const wrongDigest = await commit(env, planned, { digest: "0".repeat(64) });
		const refused = await run(wrongDigest, env.ctx());
		expect(refused.state).toBe("rolled-back");
		expect(refused.error?.code).toBe("plan-mismatch");

		const wrongMode = await commit(env, planned, { mode: "update" });
		expect((await run(wrongMode, env.ctx())).error?.code).toBe("plan-mismatch");

		await writeFile(join(env.project, "a.txt"), "changed after the plan\n");
		const stale = await commit(env, planned);
		const staleOutcome = await run(stale, env.ctx());
		expect(staleOutcome.state).toBe("rolled-back");
		expect(staleOutcome.error?.code).toBe("plan-stale");

		expect(existsSync(env.destProject)).toBe(false);
		expect(helperOps(env)).not.toContain("reserve");
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect(existsSync(reservationFile(env.dstHome))).toBe(false);
	}, 90_000);

	test("a blocked plan and an unaccepted incomplete archive never start the commit", async () => {
		const env = await setup();
		await mkdir(env.destProject, { recursive: true });
		await writeFile(join(env.destProject, "x"), "x");
		const blocked = await planFor(env, { projectMode: "create" });
		expect(blocked.preflight.blockers.length).toBeGreaterThan(0);
		const blockedOp = await commit(env, blocked);
		const blockedOutcome = await run(blockedOp, env.ctx());
		expect(blockedOutcome).toMatchObject({ state: "rolled-back", error: { code: "blocked" } });

		const other = await setup();
		await setFaults(other, { pack: { missingBlobs: ["blob-1"] } });
		const incomplete = await planFor(other);
		const refusedOp = await commit(other, incomplete, { acceptIncomplete: false });
		expect(await run(refusedOp, other.ctx())).toMatchObject({ state: "rolled-back", error: { code: "incomplete-not-accepted" } });
		expect(existsSync(other.destProject)).toBe(false);

		const acceptedOp = await commit(other, incomplete, { acceptIncomplete: true });
		expect((await run(acceptedOp, other.ctx())).state).toBe("completed");
	}, 90_000);

	test("an accepted plan fails closed when the archive turns out incomplete after the source stopped", async () => {
		const env = await setup();
		const planned = await planFor(env);
		const operationId = await commit(env, planned);
		await setFaults(env, { pack: { missingBlobs: ["late-blob"] } });
		const outcome = await run(operationId, env.ctx());
		expect(outcome.state).toBe("source-stopped");
		expect(outcome.error?.code).toBe("incomplete-archive");
		expect(existsSync(reservationFile(env.srcHome))).toBe(true);
		expect(helperOps(env)).not.toContain("publish-project");
	}, 90_000);

	test("a helper that places staging outside its root aborts before anything is written", async () => {
		const env = await setup();
		const planned = await planFor(env);
		const operationId = await commit(env, planned);
		await setFaults(env, {
			override: { "stage-dir": { ok: true, stagingRoot: "/tmp/stage", archivePath: "/etc/passwd", projectStaging: "/tmp/stage/project", undoDir: "/tmp/undo" } },
		});
		const outcome = await run(operationId, env.ctx());
		expect(outcome.state).toBe("rolled-back");
		expect(outcome.error?.code).toBe("bad-reply");
		expect(rsyncCalls(env)).toHaveLength(0);
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
	}, 90_000);

	test("a second worker for the same operation is refused", async () => {
		const env = await setup();
		const planned = await planFor(env);
		const operationId = await commit(env, planned);
		const lock = await new OperationJournal(env.journalDir).acquireWorkerLock(operationId);
		try {
			await expect(run(operationId, env.ctx())).rejects.toMatchObject({ code: "worker-active" });
		} finally {
			await lock.release();
		}
		expect((await run(operationId, env.ctx())).state).toBe("completed");
	}, 90_000);
});

// ---------------------------------------------------------------------------
// stop handshake

describe("stop handshake", () => {
	test("a nack aborts, releases both reservations and leaves the session running", async () => {
		const env = await setup();
		const owner = await startOwner(env);
		const hub = startHub();
		const planned = await planFor(env, { pid: owner.pid });
		const operationId = await commit(env, planned, { hub, pid: owner.pid });
		const [outcome] = await Promise.all([run(operationId, env.ctx()), fakeExtension(env, operationId, owner, { ok: false, reasons: ["a prompt is pending"] })]);
		expect(outcome.state).toBe("rolled-back");
		expect(outcome.error?.code).toBe("stop-refused");
		expect(outcome.error?.message).toContain("a prompt is pending");
		expect(() => process.kill(owner.pid, 0)).not.toThrow();
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect(existsSync(reservationFile(env.dstHome))).toBe(false);
		expect(existsSync(env.destProject)).toBe(false);
		const record = await sourceRecord(env, operationId);
		expect(states(record)).toEqual(["prepared", "source-stopping", "aborting", "rolled-back"]);
		const last = hub.events.at(-1);
		expect(last).toMatchObject({ state: "rolled-back", error: { code: "stop-refused" } });
		expect(hub.finished).toBe(true);
		expect(helperOps(env)).toContain("rollback");
		expect(helperOps(env)).not.toContain("import-session");
	}, 90_000);

	test("an ack stops the owner, then the transfer completes", async () => {
		const env = await setup();
		const owner = await startOwner(env);
		const planned = await planFor(env, { pid: owner.pid });
		expect(planned.preflight.live).toBe(true);
		const operationId = await commit(env, planned, { pid: owner.pid });
		const [outcome] = await Promise.all([run(operationId, env.ctx()), fakeExtension(env, operationId, owner, { ok: true })]);
		expect(outcome.state).toBe("completed");
		const request = JSON.parse(await readFile(join(env.journalDir, operationId, "stop-request.json"), "utf8"));
		expect(request.operationId).toBe(operationId);
		await expectArrived(env);
		expect(states(await sourceRecord(env, operationId))).toEqual(FORWARD);
	}, 90_000);

	test("no acknowledgement within the deadline aborts and releases", async () => {
		const env = await setup();
		const owner = await startOwner(env);
		const planned = await planFor(env, { pid: owner.pid });
		const operationId = await commit(env, planned, { pid: owner.pid });
		const outcome = await run(operationId, env.ctx({ timing: { ...FAST, stopAckTimeoutMs: 300 } }));
		expect(outcome).toMatchObject({ state: "rolled-back", error: { code: "stop-timeout" } });
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect(existsSync(join(env.journalDir, operationId, "stop-request.json"))).toBe(false);
	}, 90_000);
});

// ---------------------------------------------------------------------------
// crash and resume

describe("crash and resume", () => {
	for (const crashAt of ["staged", "publishing", "source-departed", "destination-starting"] as const) {
		test(`a worker that dies after '${crashAt}' resumes from the journal without a second launch`, async () => {
			const env = await setup();
			const planned = await planFor(env);
			const operationId = await commit(env, planned);
			let crashed = false;
			await expect(
				run(
					operationId,
					env.ctx({
						afterTransition: (state) => {
							if (state === crashAt && !crashed) {
								crashed = true;
								throw new Error("simulated crash");
							}
						},
					}),
				),
			).rejects.toThrow("simulated crash");
			expect((await sourceRecord(env, operationId)).state).toBe(crashAt);
			expect(existsSync(reservationFile(env.srcHome))).toBe(true);

			const outcome = await run(operationId, env.ctx());
			expect(outcome.state).toBe("completed");
			expect(states(await sourceRecord(env, operationId))).toEqual(FORWARD);
			await expectArrived(env);
			expect(helperOps(env).filter((op) => op === "launch")).toHaveLength(1);
			expect(readFileSync(env.sessionFile, "utf8").split("\n").filter((line) => line.includes('"departed"'))).toHaveLength(1);
			expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		}, 90_000);
	}

	test("an ssh drop during the archive copy is retried and the transfer still completes", async () => {
		const env = await setup();
		const planned = await planFor(env);
		const operationId = await commit(env, planned);
		await setFaults(env, { rsyncDrop: 1 });
		expect((await run(operationId, env.ctx())).state).toBe("completed");
		expect(rsyncCalls(env).length).toBeGreaterThanOrEqual(3);
	}, 90_000);

	test("when the copy keeps failing the operation keeps its last confirmed state", async () => {
		const env = await setup();
		const planned = await planFor(env);
		const operationId = await commit(env, planned);
		await setFaults(env, { rsyncDrop: 99 });
		const outcome = await run(operationId, env.ctx({ timing: { ...FAST } }));
		expect(outcome.state).toBe("source-stopped");
		expect(outcome.error?.code).toBe("rsync-failed");
		expect(existsSync(reservationFile(env.srcHome))).toBe(true);
		expect(helperOps(env)).not.toContain("publish-project");
		await setFaults(env, {});
		expect((await run(operationId, env.ctx())).state).toBe("completed");
	}, 90_000);
});

// ---------------------------------------------------------------------------
// cancel

describe("cancel", () => {
	test("a cancel queued before the commit rolls back and changes nothing", async () => {
		const env = await setup();
		const hub = startHub();
		hub.addCommand("cancel");
		const planned = await planFor(env);
		const operationId = await commit(env, planned, { hub });
		const outcome = await run(operationId, env.ctx());
		expect(outcome).toMatchObject({ state: "rolled-back", error: { code: "cancelled" } });
		expect(hub.commands[0]?.acked).toBe(true);
		expect(helperOps(env)).not.toContain("reserve");
		expect(existsSync(env.destProject)).toBe(false);
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect(readFileSync(env.sessionFile, "utf8")).not.toContain("departed");
	}, 90_000);

	test("a cancel during staging stops the copy, removes staging and keeps the source blocked until rolled back", async () => {
		const env = await setup();
		const hub = startHub();
		hub.onEvent = (event) => {
			// The cancel must arrive while rsync is in flight, so it is delayed in real time
			// (the fake ssh holds the copy for 3 s); the worker's own poll timer then picks it up.
			if (event.progress?.phase === "transferring-archive") setTimeout(() => hub.addCommand("cancel"), 500);
		};
		const planned = await planFor(env);
		const operationId = await commit(env, planned, { hub });
		await setFaults(env, { rsyncDelayMs: 3000 });
		const outcome = await run(operationId, env.ctx());
		expect(outcome.state).toBe("source-stopped");
		expect(outcome.error?.code).toBe("cancelled");
		expect(helperOps(env)).toContain("cleanup");
		expect(helperOps(env)).not.toContain("publish-project");
		expect(existsSync(env.destProject)).toBe(false);
		expect(existsSync(reservationFile(env.srcHome))).toBe(true);

		// A restarted worker does not continue a cancelled operation.
		await setFaults(env, {});
		const again = await run(operationId, env.ctx());
		expect(again.state).toBe("source-stopped");
		expect(again.error?.code).toBe("cancelled");

		const rolledBack = await recover(operationId, "rollback-source", env.ctx());
		expect(rolledBack.state).toBe("rolled-back");
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect(existsSync(reservationFile(env.dstHome))).toBe(false);
		expect(readFileSync(env.sessionFile, "utf8")).not.toContain("departed");
	}, 90_000);

	test("a cancel after publishing started stops at a recorded boundary and needs explicit recovery", async () => {
		const env = await setup();
		const hub = startHub();
		hub.onEvent = (event) => {
			if (event.state === "publishing" && !event.progress && !event.error) hub.addCommand("cancel");
		};
		const planned = await planFor(env);
		const operationId = await commit(env, planned, { hub });
		const outcome = await run(operationId, env.ctx());
		expect(outcome.state).toBe("publishing");
		expect(outcome.error?.code).toBe("cancelled");
		expect(helperOps(env)).not.toContain("publish-project");
		expect(helperOps(env)).not.toContain("launch");
		expect(readFileSync(env.sessionFile, "utf8")).not.toContain("departed");

		expect((await recover(operationId, "rollback-source", env.ctx())).state).toBe("rolled-back");
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
	}, 90_000);

	test("a failed operation waits for a recover command from the hub, with no extension involved", async () => {
		const env = await setup();
		const hub = startHub();
		hub.onEvent = (event) => {
			if (event.progress?.phase === "transferring-archive") hub.addCommand("cancel");
			if (event.error?.code === "cancelled" && !hub.commands.some((command) => command.type === "recover")) {
				hub.addCommand("recover", { action: "rollback-source" });
			}
		};
		const planned = await planFor(env);
		const operationId = await commit(env, planned, { hub });
		const outcome = await run(operationId, env.ctx({ awaitRecovery: true }));
		expect(outcome.state).toBe("rolled-back");
		expect(hub.commands.every((command) => command.acked)).toBe(true);
		expect(hub.finished).toBe(true);
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
	}, 90_000);

	test("token expiry mid-run is renewed and the run completes", async () => {
		const env = await setup();
		const hub = startHub();
		let rotated = false;
		hub.onEvent = (event) => {
			if (event.state === "staged" && !rotated) {
				rotated = true;
				hub.rotateToken();
			}
		};
		const planned = await planFor(env);
		const operationId = await commit(env, planned, { hub });
		expect((await run(operationId, env.ctx())).state).toBe("completed");
		expect(hub.renewals).toBeGreaterThanOrEqual(1);
		expect(dedupe(hub.events.map((event) => event.state))).toEqual(FORWARD);
		expect(hub.finished).toBe(true);
	}, 90_000);

	test("a hub that is down never aborts the transfer", async () => {
		const env = await setup();
		const hub = startHub();
		const planned = await planFor(env);
		const operationId = await commit(env, planned, { hub });
		hub.stop();
		expect((await run(operationId, env.ctx())).state).toBe("completed");
		await expectArrived(env);
	}, 90_000);
});

// ---------------------------------------------------------------------------
// launch failure and recovery

describe("launch failure and recovery", () => {
	async function departed(env: Env, faults: Record<string, unknown>): Promise<string> {
		const planned = await planFor(env);
		const operationId = await commit(env, planned);
		await setFaults(env, faults);
		return operationId;
	}

	test("a lost launch reply keeps the imported data, blocks the source and can be retried", async () => {
		const env = await setup();
		const operationId = await departed(env, { sshDrop: { op: "launch", times: 1 } });
		const outcome = await run(operationId, env.ctx());
		expect(outcome.state).toBe("source-departed");
		expect(outcome.error?.code).toBe("launch-uncertain");
		expect(readFileSync(join(env.destProject, "a.txt"), "utf8")).toBe("alpha from source\n");
		expect(existsSync(join(env.dstHome, ".fake-omp", "store", `${SESSION_ID}.jsonl`))).toBe(true);
		expect(readFileSync(env.sessionFile, "utf8")).toContain('"departed"');
		expect(existsSync(reservationFile(env.srcHome))).toBe(true);
		expect(existsSync(join(env.dstHome, "ompc-calls.jsonl"))).toBe(false);

		const retried = await recover(operationId, "retry-launch", env.ctx());
		expect(retried.state).toBe("completed");
		expect(helperOps(env).filter((op) => op === "launch")).toHaveLength(2);
		expect(readFileSync(join(env.dstHome, "ompc-calls.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
	}, 90_000);

	test("an unreachable target leaves source recovery blocked; a later rollback cancels the launch first", async () => {
		const env = await setup();
		const operationId = await departed(env, { sshDrop: { op: "launch", times: 1 } });
		expect((await run(operationId, env.ctx())).state).toBe("source-departed");

		await setFaults(env, { sshDown: true });
		const blocked = await recover(operationId, "rollback-source", env.ctx());
		expect(blocked.state).toBe("source-departed");
		expect(blocked.error?.code).toBe("target-unreachable");
		expect(existsSync(reservationFile(env.srcHome))).toBe(true);

		await setFaults(env, {});
		const rolledBack = await recover(operationId, "rollback-source", env.ctx());
		expect(rolledBack.state).toBe("rolled-back");
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect(existsSync(reservationFile(env.dstHome))).toBe(false);
		const order = helperOps(env);
		expect(order.lastIndexOf("rollback")).toBeGreaterThan(order.lastIndexOf("launch"));
		const dest = await new OperationJournal(env.dstJournalDir).load(operationId);
		expect(dest?.state).toBe("rolled-back");
		expect(dest?.launch?.status).toBe("cancelled");
		// A delayed launch carrying the old nonce is refused for good.
		const lateNonce = (JSON.parse(await readFile(join(env.journalDir, operationId, "progress.json"), "utf8")) as { nonce: string }).nonce;
		await expect(new OperationJournal(env.dstJournalDir).consumeLaunchIntent(operationId, lateNonce)).resolves.toBe(false);
	}, 90_000);

	test("a spawn failure leaves the same launch retryable", async () => {
		const env = await setup();
		const operationId = await departed(env, { ompcFail: true });
		const outcome = await run(operationId, env.ctx());
		expect(outcome.state).toBe("source-departed");
		expect(outcome.error?.code).toBe("launch-failed");
		expect(existsSync(join(env.dstHome, ".fake-omp", "store", `${SESSION_ID}.jsonl`))).toBe(true);

		await setFaults(env, {});
		const retried = await recover(operationId, "retry-launch", env.ctx());
		expect(retried.state).toBe("completed");
		expect(helperOps(env).filter((op) => op === "launch")).toHaveLength(2);
		expect(readFileSync(join(env.dstHome, "ompc-calls.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
	}, 90_000);

	test("a spawn failure can be rolled back because nothing started", async () => {
		const env = await setup();
		const operationId = await departed(env, { ompcFail: true });
		expect((await run(operationId, env.ctx())).state).toBe("source-departed");
		const rolledBack = await recover(operationId, "rollback-source", env.ctx());
		expect(rolledBack.state).toBe("rolled-back");
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect((await new OperationJournal(env.dstJournalDir).load(operationId))?.state).toBe("rolled-back");
		// The same nonce can no longer launch.
		await setFaults(env, {});
		const late = await recover(operationId, "retry-launch", env.ctx());
		expect(late.state).toBe("rolled-back");
		expect(existsSync(join(env.dstHome, "spawned.pids"))).toBe(false);
	}, 90_000);

	test("a launch that spawned cannot be rolled back automatically", async () => {
		const env = await setup();
		const operationId = await departed(env, { ompcNoArrival: true });
		const outcome = await run(operationId, env.ctx({ timing: { ...FAST, arrivalTimeoutMs: 200 } }));
		expect(outcome.state).toBe("destination-starting");
		const refused = await recover(operationId, "rollback-source", env.ctx());
		expect(refused.state).toBe("destination-starting");
		expect(refused.error?.code).toBe("launch-already-consumed");
		expect(existsSync(reservationFile(env.srcHome))).toBe(true);
	}, 90_000);

	test("an arrival that never registers times out without a second launch; a late arrival then completes", async () => {
		const env = await setup();
		const operationId = await departed(env, { ompcNoArrival: true });
		const outcome = await run(operationId, env.ctx({ timing: { ...FAST, arrivalTimeoutMs: 300 } }));
		expect(outcome.state).toBe("destination-starting");
		expect(outcome.error?.code).toBe("arrival-timeout");
		expect(helperOps(env).filter((op) => op === "launch")).toHaveLength(1);

		// The destination extension registers late: arrival.json appears with the launch nonce.
		const progress = JSON.parse(await readFile(join(env.journalDir, operationId, "progress.json"), "utf8")) as { nonce: string };
		const late = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
		processes.push(late);
		await writeFile(
			join(env.dstJournalDir, operationId, "arrival.json"),
			JSON.stringify({ nonce: progress.nonce, sessionId: SESSION_ID, cwd: env.destProject, pid: late.pid, hostId: "user@worker-host", label: "proj.chat" }),
		);
		const retried = await recover(operationId, "retry-launch", env.ctx());
		expect(retried.state).toBe("completed");
		expect(helperOps(env).filter((op) => op === "launch")).toHaveLength(1);
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
	}, 90_000);

	test("a spoofed arrival with the wrong nonce is not accepted", async () => {
		const env = await setup();
		const operationId = await departed(env, { ompcNoArrival: true });
		const spoof = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
		processes.push(spoof);
		await mkdir(join(env.dstJournalDir, operationId), { recursive: true });
		await writeFile(
			join(env.dstJournalDir, operationId, "arrival.json"),
			JSON.stringify({ nonce: "not-the-launch-nonce", sessionId: SESSION_ID, cwd: env.destProject, pid: spoof.pid, hostId: "user@worker-host", label: "proj.chat" }),
		);
		const outcome = await run(operationId, env.ctx({ timing: { ...FAST, arrivalTimeoutMs: 300 } }));
		expect(outcome.state).toBe("destination-starting");
		expect(outcome.error?.code).toBe("arrival-timeout");
		expect(existsSync(reservationFile(env.srcHome))).toBe(true);
	}, 90_000);

	test("restore-project undoes an update after a failed launch and is refused once the transfer completed", async () => {
		const env = await setup();
		await mkdir(env.destProject, { recursive: true });
		await writeFile(join(env.destProject, "a.txt"), "alpha from destination\n");
		const planned = await planFor(env, { projectMode: "update" });
		const operationId = await commit(env, planned);
		await setFaults(env, { ompcFail: true });
		const outcome = await run(operationId, env.ctx());
		expect(outcome.state).toBe("source-departed");
		expect(readFileSync(join(env.destProject, "a.txt"), "utf8")).toBe("alpha from source\n");

		const restored = await recover(operationId, "restore-project", env.ctx());
		// The failed launch stays the operation's recorded error; the restore added none.
		expect(restored.error?.code).toBe("launch-failed");
		expect(readFileSync(join(env.destProject, "a.txt"), "utf8")).toBe("alpha from destination\n");
		expect(existsSync(join(env.destProject, "sub", "b.txt"))).toBe(false);

		const completed = await setup();
		const doneOp = await commit(completed, await planFor(completed));
		expect((await run(doneOp, completed.ctx())).state).toBe("completed");
		const refusal = await recover(doneOp, "restore-project", completed.ctx());
		expect(refusal.state).toBe("completed");
		expect(refusal.error).toBeUndefined();
	}, 90_000);

	test("cleanup is refused while staging is still needed and works after a rollback", async () => {
		const env = await setup();
		const planned = await planFor(env);
		const operationId = await commit(env, planned);
		await expect(
			run(
				operationId,
				env.ctx({
					afterTransition: (state) => {
						if (state === "staged") throw new Error("simulated crash");
					},
				}),
			),
		).rejects.toThrow("simulated crash");
		const stage = join(env.dstJournalDir, operationId, "stage");
		expect(existsSync(stage)).toBe(true);

		const refused = await recover(operationId, "cleanup", env.ctx());
		expect(refused.state).toBe("staged");
		expect(refused.error).toBeUndefined();
		expect(existsSync(stage)).toBe(true);

		expect((await recover(operationId, "rollback-source", env.ctx())).state).toBe("rolled-back");
		expect(existsSync(stage)).toBe(false);
		const again = await recover(operationId, "cleanup", env.ctx());
		expect(again.state).toBe("rolled-back");
		expect(again.error).toBeUndefined();
	}, 90_000);
});

// ---------------------------------------------------------------------------
// command line

describe("send-to-host command", () => {
	function io() {
		const captured = { out: "", err: "" };
		return {
			captured,
			io: { out: (text: string) => void (captured.out += text), err: (text: string) => void (captured.err += text) },
		};
	}

	test("sends an inactive session with --yes", async () => {
		const env = await setup();
		const { io: cli, captured } = io();
		const code = await main(["send-to-host", SESSION_ID, "worker-host", "--yes"], env.ctx(), cli);
		expect(code).toBe(0);
		expect(captured.out).toContain(env.destProject);
		await expectArrived(env);
	}, 90_000);

	test("refuses a session with a live owner and points to the dashboard", async () => {
		const env = await setup();
		await startOwner(env);
		const { io: cli, captured } = io();
		const code = await main(["send-to-host", SESSION_ID, "worker-host", "--yes"], env.ctx(), cli);
		expect(code).toBe(75);
		expect(captured.err).toContain("dashboard");
		expect(helperOps(env)).toEqual([]);
	}, 90_000);

	test("needs --yes or a terminal, and --accept-incomplete for an incomplete archive", async () => {
		const env = await setup();
		const first = io();
		expect(await main(["send-to-host", SESSION_ID, "worker-host"], env.ctx(), first.io)).toBe(1);
		expect(first.captured.err).toContain("--yes");
		await setFaults(env, { pack: { missingBlobs: ["blob-1"] } });
		const second = io();
		expect(await main(["send-to-host", SESSION_ID, "worker-host", "--yes"], env.ctx(), second.io)).toBe(1);
		expect(second.captured.err).toContain("--accept-incomplete");
		const third = io();
		expect(await main(["send-to-host", SESSION_ID, "worker-host", "--yes", "--accept-incomplete"], env.ctx(), third.io)).toBe(0);
	}, 90_000);

	test("ompc dispatches send-to-host to the worker without starting a TUI", async () => {
		const env = await setup();
		const result = Bun.spawnSync([OMPC_LAUNCHER, "send-to-host"], { env: { ...env.env, OMP_HOST_ENV: "/dev/null" } });
		expect(result.exitCode).toBe(64);
		expect(new TextDecoder().decode(result.stderr)).toContain("send-to-host needs");
	});
});

// ---------------------------------------------------------------------------
// protocol review fixes

/** Writes the arrival record the destination extension would write, with a live pid. */
async function writeArrival(env: Env, operationId: string, hostId: string): Promise<void> {
	const progress = JSON.parse(await readFile(join(env.journalDir, operationId, "progress.json"), "utf8")) as { nonce: string };
	const session = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
	processes.push(session);
	await writeFile(
		join(env.dstJournalDir, operationId, "arrival.json"),
		JSON.stringify({ nonce: progress.nonce, sessionId: SESSION_ID, cwd: env.destProject, pid: session.pid, hostId, label: "proj.chat" }),
	);
}

describe("session ids", () => {
	test("a session id cannot start with a dash", () => {
		expect(() => parsePlanRequest({ destination: "worker-host", session: { sessionId: "-oBad", sessionFile: "/x/y.jsonl", cwd: "/x" } })).toThrow(/sessionId/);
	});

	test("omp is called with -- before the id", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env));
		expect((await run(operationId, env.ctx())).state).toBe("completed");
		const calls = readFileSync(join(env.srcHome, ".fake-omp", "calls.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		const byId = calls.filter((args) => ["reserve", "release", "reservation", "locate"].includes(args[1] as string));
		expect(byId.length).toBeGreaterThan(0);
		for (const args of byId) {
			expect(args.at(-2)).toBe("--");
			expect(args.at(-1)).toBe(SESSION_ID);
		}
	}, 90_000);
});

describe("source reservation release", () => {
	const progressOf = async (env: Env, operationId: string) =>
		JSON.parse(await readFile(join(env.journalDir, operationId, "progress.json"), "utf8")) as { sourceReleasePending?: boolean };

	test("rollback-source never ends terminal while the source release fails, and repeats on a terminal record", async () => {
		const env = await setup();
		const hub = startHub();
		hub.onEvent = (event) => {
			if (event.state === "publishing" && !event.progress && !event.error) hub.addCommand("cancel");
		};
		const operationId = await commit(env, await planFor(env), { hub });
		expect((await run(operationId, env.ctx())).state).toBe("publishing");

		await setFaults(env, { releaseFailSource: true });
		const blocked = await recover(operationId, "rollback-source", env.ctx());
		expect(blocked.state).toBe("aborting");
		expect(blocked.error?.code).toBe("source-release-pending");
		expect(existsSync(reservationFile(env.srcHome))).toBe(true);
		expect((await progressOf(env, operationId)).sourceReleasePending).toBe(true);

		await setFaults(env, {});
		const done = await recover(operationId, "rollback-source", env.ctx());
		expect(done.state).toBe("rolled-back");
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect((await progressOf(env, operationId)).sourceReleasePending).toBe(false);

		const again = await recover(operationId, "rollback-source", env.ctx());
		expect(again).toEqual({ operationId, state: "rolled-back" });
	}, 90_000);

	test("an abort before the source stopped stays open while the release fails", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env), { digest: "0".repeat(64) });
		await setFaults(env, { releaseFailSource: true });
		const outcome = await run(operationId, env.ctx());
		expect(outcome.state).toBe("aborting");
		expect(outcome.error?.code).toBe("source-release-pending");
		await setFaults(env, {});
		expect((await recover(operationId, "rollback-source", env.ctx())).state).toBe("rolled-back");
	}, 90_000);

	test("a failed release after arrival keeps the operation open until it succeeds", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env));
		await setFaults(env, { releaseFailSource: true });
		const outcome = await run(operationId, env.ctx());
		expect(outcome.state).toBe("destination-starting");
		expect(outcome.error?.code).toBe("source-release-pending");
		expect(existsSync(reservationFile(env.srcHome))).toBe(true);
		await setFaults(env, {});
		const done = await recover(operationId, "retry-launch", env.ctx());
		expect(done.state).toBe("completed");
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
		expect(helperOps(env).filter((op) => op === "launch")).toHaveLength(1);
	}, 90_000);
});

describe("publish order and plan blockers", () => {
	test("an existing project imports the session first; a new project is published first", async () => {
		const env = await setup();
		await mkdir(env.destProject, { recursive: true });
		await writeFile(join(env.destProject, "a.txt"), "alpha from destination\n");
		const update = await commit(env, await planFor(env, { projectMode: "update" }));
		expect((await run(update, env.ctx())).state).toBe("completed");
		const updateOps = helperOps(env);
		expect(updateOps.indexOf("import-session")).toBeGreaterThan(-1);
		expect(updateOps.indexOf("import-session")).toBeLessThan(updateOps.indexOf("publish-project"));

		const fresh = await setup();
		expect((await run(await commit(fresh, await planFor(fresh)), fresh.ctx())).state).toBe("completed");
		const createOps = helperOps(fresh);
		expect(createOps.indexOf("publish-project")).toBeLessThan(createOps.indexOf("import-session"));
	}, 90_000);

	test("plan blocks a new project over an existing destination copy unless the helper calls it replayable, and a different filesystem", async () => {
		const env = await setup();
		const base = { ok: true, resolvedProject: env.destProject, exists: false, isDirectory: false, gitDirty: null, knownUsers: [] };
		const copy = { existsLocally: true, sessionFile: "/dst/x.jsonl", reservation: null };
		await setFaults(env, { override: { inspect: { ...base, session: copy } } });
		const blocked = await planFor(env);
		expect(blocked.preflight.blockers.join(" ")).toContain("already holds a copy");

		await setFaults(env, { override: { inspect: { ...base, session: { ...copy, replayable: true } } } });
		const replay = await planFor(env);
		expect(replay.preflight.blockers).toEqual([]);
		expect(replay.preflight.warnings.join(" ")).toContain("already holds a copy");

		await setFaults(env, {
			override: { inspect: { ...base, stagingSameFilesystem: false, session: { existsLocally: false, sessionFile: null, reservation: null } } },
		});
		const split = await planFor(env);
		expect(split.preflight.stagingSameFilesystem).toBe(false);
		expect(split.preflight.blockers.join(" ")).toContain("different filesystems");
		expect(split.preflight.blockers.join(" ")).toContain("share a filesystem");
	}, 90_000);

	test("a return transfer with a prior destination copy plans with a warning and runs for session-only and update", async () => {
		for (const mode of ["session-only", "update"] as const) {
			const env = await setup();
			await mkdir(env.destProject, { recursive: true });
			await writeFile(join(env.destProject, "a.txt"), "alpha from destination\n");
			// The destination kept an earlier copy: the session's header plus a local departure marker.
			const header = (readFileSync(env.sessionFile, "utf8").split("\n")[0] as string) + "\n";
			const marker = JSON.stringify({ type: "custom_message", customType: "session-transfer", details: { kind: "departed", to: "earlier-host" } });
			const prior = join(env.dstHome, ".fake-omp", "store", `${SESSION_ID}.jsonl`);
			await mkdir(join(env.dstHome, ".fake-omp", "store"), { recursive: true });
			await mkdir(join(env.dstHome, ".fake-omp", "sessions"), { recursive: true });
			await writeFile(prior, `${header}${marker}\n`);
			await writeFile(join(env.dstHome, ".fake-omp", "sessions", SESSION_ID), prior);

			const planned = await planFor(env, { projectMode: mode });
			expect(planned.preflight.projectMode).toBe(mode);
			expect(planned.preflight.blockers).toEqual([]);
			expect(planned.preflight.warnings.join(" ")).toContain("already holds a copy");

			const operationId = await commit(env, planned);
			expect((await run(operationId, env.ctx())).state).toBe("completed");
			expect(readFileSync(prior, "utf8")).toContain('"arrived"');
			expect(helperOps(env)).toContain("launch");
		}
	}, 120_000);
});

describe("helper timeouts and busy operations", () => {
	test("long ops get a longer limit than short ones", () => {
		expect(DEFAULT_TIMING.helperLongTimeoutMs).toBe(30 * 60_000);
		expect(DEFAULT_TIMING.helperTimeoutMs).toBeLessThan(DEFAULT_TIMING.helperLongTimeoutMs);
	});

	test("op-busy is waited out instead of raced", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env));
		await setFaults(env, { busy: { op: "import-session", times: 2 } });
		const outcome = await run(operationId, env.ctx({ timing: { ...FAST, opBusyPollMs: 10 } }));
		expect(outcome.state).toBe("completed");
		expect(helperOps(env).filter((op) => op === "import-session")).toHaveLength(3);
	}, 90_000);

	test("a dropped mutating call looks at the helper status before it is sent again", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env));
		await setFaults(env, { sshDrop: { op: "import-session", times: 1 } });
		expect((await run(operationId, env.ctx())).state).toBe("completed");
		expect(helperOps(env).join(",")).toContain("import-session,status,import-session");
	}, 90_000);

	test("a destination that stays busy fails the step and resume continues it", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env));
		await setFaults(env, { busy: { op: "import-session", times: 999 } });
		const outcome = await run(operationId, env.ctx({ timing: { ...FAST, opBusyWaitMs: 150, opBusyPollMs: 10 } }));
		expect(outcome.state).toBe("publishing");
		expect(outcome.error?.code).toBe("op-busy");
		await setFaults(env, {});
		const resumed = await recover(operationId, "resume", env.ctx());
		expect(resumed.state).toBe("completed");
		expect(resumed.error).toBeUndefined();
	}, 90_000);
});

describe("resume and project-restored", () => {
	test("resume is a recovery action", () => {
		expect(RECOVER_ACTIONS).toContain("resume");
	});

	test("resume continues a failed copy from the journal", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env));
		await setFaults(env, { rsyncDrop: 99 });
		const failed = await run(operationId, env.ctx());
		expect(failed.state).toBe("source-stopped");
		await setFaults(env, {});
		const resumed = await recover(operationId, "resume", env.ctx());
		expect(resumed.state).toBe("completed");
		await expectArrived(env);
	}, 90_000);

	test("resume after a cancel re-stages and completes", async () => {
		const env = await setup();
		const hub = startHub();
		hub.onEvent = (event) => {
			if (event.progress?.phase === "transferring-archive") hub.addCommand("cancel");
		};
		const operationId = await commit(env, await planFor(env), { hub });
		const cancelled = await run(operationId, env.ctx());
		expect(cancelled.state).toBe("source-stopped");
		expect(cancelled.error?.code).toBe("cancelled");
		hub.onEvent = undefined;
		const resumed = await recover(operationId, "resume", env.ctx());
		expect(resumed.state).toBe("completed");
		await expectArrived(env);
	}, 90_000);

	test("resume is refused once the source departed", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env));
		await setFaults(env, { sshDrop: { op: "launch", times: 1 } });
		expect((await run(operationId, env.ctx())).state).toBe("source-departed");
		const refused = await recover(operationId, "resume", env.ctx());
		expect(refused.state).toBe("source-departed");
		expect(refused.error?.code).toBe("launch-uncertain");
		expect(helperOps(env).filter((op) => op === "launch")).toHaveLength(1);
	}, 90_000);

	test("a launch refused as project-restored blocks retry-launch", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env));
		await setFaults(env, { override: { launch: { ok: false, code: "project-restored", message: "the project was restored" } } });
		const outcome = await run(operationId, env.ctx());
		expect(outcome.state).toBe("source-departed");
		expect(outcome.error?.code).toBe("project-restored");
		expect((JSON.parse(await readFile(join(env.journalDir, operationId, "progress.json"), "utf8")) as { restored?: boolean }).restored).toBe(true);
		await setFaults(env, {});
		const retried = await recover(operationId, "retry-launch", env.ctx());
		expect(retried.state).toBe("source-departed");
		expect(retried.error?.code).toBe("project-restored");
		expect(helperOps(env).filter((op) => op === "launch")).toHaveLength(1);
	}, 90_000);
});

describe("arrival checks", () => {
	test("an arrival from a different host is not accepted until the host matches", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env));
		await setFaults(env, { ompcNoArrival: true });
		const timing = { ...FAST, arrivalTimeoutMs: 300 };
		expect((await run(operationId, env.ctx({ timing }))).state).toBe("destination-starting");

		await writeArrival(env, operationId, "other@elsewhere");
		const wrong = await recover(operationId, "retry-launch", env.ctx({ timing }));
		expect(wrong.state).toBe("destination-starting");
		expect(wrong.error?.message).toContain("host-mismatch");

		await writeArrival(env, operationId, "user@worker-host");
		const right = await recover(operationId, "retry-launch", env.ctx({ timing }));
		expect(right.state).toBe("completed");
	}, 90_000);

	test("an arrival whose session already exited still completes the operation", async () => {
		const env = await setup();
		const hub = startHub();
		const operationId = await commit(env, await planFor(env), { hub });
		await setFaults(env, {
			override: { "verify-arrival": { ok: true, arrived: true, exited: true, hostId: "user@worker-host", label: "proj.chat", pid: 1 } },
		});
		expect((await run(operationId, env.ctx())).state).toBe("completed");
		const completed = hub.events.find((event) => event.state === "completed");
		expect(completed?.detail).toContain("already exited");
		expect(completed?.progress?.exited).toBe(true);
		expect(existsSync(reservationFile(env.srcHome))).toBe(false);
	}, 90_000);
});

describe("status and handed-over recovery", () => {
	test("status reads the worker lock without taking it, and recover requests queue as separate files", async () => {
		const env = await setup();
		const operationId = await commit(env, await planFor(env));
		expect((await run(operationId, env.ctx())).state).toBe("completed");
		const journal = new OperationJournal(env.journalDir);
		const lock = await journal.acquireWorkerLock(operationId);
		try {
			expect((await status(operationId, env.ctx())).workerActive).toBe(true);
			await expect(journal.acquireWorkerLock(operationId)).rejects.toMatchObject({ code: "worker-active" });
			const first = await recover(operationId, "cleanup", env.ctx());
			const second = await recover(operationId, "resume", env.ctx());
			expect(first.handedOver).toBe(true);
			expect(second.handedOver).toBe(true);
			const files = await readdir(join(env.journalDir, operationId, "recover-requests"));
			expect(files).toHaveLength(2);
			expect(new Set(files).size).toBe(2);
		} finally {
			await lock.release();
		}
		const after = await status(operationId, env.ctx());
		expect(after.workerActive).toBe(false);
		// A status probe never leaves a lock behind that blocks a worker.
		await (await journal.acquireWorkerLock(operationId)).release();
	}, 90_000);

	test("a recover command from the hub is persisted before it is acknowledged and consumed afterwards", async () => {
		const env = await setup();
		const hub = startHub();
		hub.onEvent = (event) => {
			if (event.progress?.phase === "transferring-archive") hub.addCommand("cancel");
			if (event.error?.code === "cancelled" && !hub.commands.some((command) => command.type === "recover")) {
				hub.addCommand("recover", { action: "rollback-source" });
			}
		};
		const operationId = await commit(env, await planFor(env), { hub });
		expect((await run(operationId, env.ctx({ awaitRecovery: true }))).state).toBe("rolled-back");
		expect(await readdir(join(env.journalDir, operationId, "recover-requests"))).toEqual([]);
		expect(hub.commands.every((command) => command.acked)).toBe(true);
	}, 90_000);
});

describe("rollback request", () => {
	test("the destination rollback carries the session id", async () => {
		const env = await setup();
		const owner = await startOwner(env);
		const operationId = await commit(env, await planFor(env, { pid: owner.pid }), { pid: owner.pid });
		await Promise.all([run(operationId, env.ctx()), fakeExtension(env, operationId, owner, { ok: false, reasons: ["busy"] })]);
		const rollback = sshLogEntries(env).find((entry) => entry.helper === "rollback");
		expect(rollback?.request.sessionId).toBe(SESSION_ID);
	}, 90_000);
});
