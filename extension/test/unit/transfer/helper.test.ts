import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	advanceTo,
	HELPER_PROTOCOL,
	HelperError,
	main,
	runHelper,
	type HelperDeps,
	type HelperReply,
	type SpawnResult,
} from "../../../src/transfer/helper.js";
import { OperationJournal, type OperationRecord } from "../../../src/transfer/journal.js";
import { buildManifest, diffManifests } from "../../../src/transfer/project-sync.js";

const SID = "11111111-2222-3333-4444-555555555555";
const BIN = resolve(import.meta.dir, "../../../bin/ompc-transfer-helper");

let root: string;
let home: string;
let journalDir: string;
let events: string[];
let reservations: Map<string, { sessionId: string; operationId: string; role: string; createdAt: string }>;
let ompCalls: string[][];
let spawns: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
let spawnResult: SpawnResult;
let unpackError: { code: string; message: string } | undefined;
let unpackMode: string;
let alive: boolean;
let counter = 0;

function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

/** Stands in for `omp session ...`: holds reservations in memory and writes the unpacked journal file. */
async function fakeOmp(args: string[]): Promise<Record<string, unknown>> {
	ompCalls.push(args);
	const [group, action, target = ""] = args;
	if (group !== "session") return { ok: false, code: "other", message: "unexpected command" };
	const held = reservations.get(target);
	switch (action) {
		case "reserve": {
			const operationId = flag(args, "--operation") as string;
			if (held && held.operationId !== operationId) return { ok: false, code: "reserved", message: `reserved by ${held.operationId}` };
			const reservation = held ?? { sessionId: target, operationId, role: flag(args, "--role") as string, createdAt: "2026-01-01T00:00:00Z" };
			reservations.set(target, reservation);
			return { ok: true, reservation };
		}
		case "release": {
			events.push("omp release");
			const released = held?.operationId === flag(args, "--operation");
			if (released) reservations.delete(target);
			return { ok: true, released, reservation: reservations.get(target) ?? null };
		}
		case "reservation":
			return { ok: true, reservation: held ?? null };
		case "locate":
			return { ok: true, sessionFile: null, sessionDir: join(home, "sessions") };
		case "unpack": {
			if (unpackError) return { ok: false, ...unpackError };
			const sessionFile = join(home, "sessions", `2026-01-01_${SID}.jsonl`);
			await mkdir(join(home, "sessions", `2026-01-01_${SID}`), { recursive: true });
			await writeFile(join(home, "sessions", `2026-01-01_${SID}`, "child.jsonl"), "{}\n");
			await writeFile(sessionFile, "{}\n");
			return { ok: true, sessionFile, id: SID, mode: unpackMode };
		}
		default:
			return { ok: false, code: "other", message: "unexpected action" };
	}
}

function makeDeps(overrides: Partial<HelperDeps> = {}): Partial<HelperDeps> {
	return {
		journalDir,
		home,
		env: { PATH: "" },
		hostname: () => "worker-host",
		user: () => "user",
		resolveOmpBin: () => "/fake/omp",
		resolveOmpc: () => "/fake/ompc",
		hasRsync: () => true,
		ompVersion: async () => "omp 1.2.3",
		runOmp: fakeOmp,
		spawnDetached: async (command, args, options) => {
			events.push("spawn");
			spawns.push({ command, args, cwd: options.cwd, env: options.env });
			return spawnResult;
		},
		gitDirty: async () => false,
		knownUsers: async () => [],
		pidAlive: () => alive,
		freeBytes: async () => 1234,
		log: () => {},
		...overrides,
	};
}

async function call(request: Record<string, unknown>, overrides: Partial<HelperDeps> = {}): Promise<HelperReply> {
	return runHelper({ protocol: HELPER_PROTOCOL, ...request }, makeDeps(overrides));
}

async function ok(request: Record<string, unknown>, overrides: Partial<HelperDeps> = {}): Promise<Record<string, unknown>> {
	const reply = await call(request, overrides);
	if (!reply.ok) throw new Error(`${String(request.op)} failed: ${reply.code}: ${reply.message}`);
	return reply;
}

function fail(reply: HelperReply): { code: string; message: string } & Record<string, unknown> {
	if (reply.ok) throw new Error(`expected a failure, got ${JSON.stringify(reply)}`);
	return reply;
}

function newOp(): string {
	counter += 1;
	return `op-${counter}`;
}

const journal = () => new OperationJournal(journalDir);

async function reserve(op: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	return ok({ op: "reserve", operationId: op, sessionId: SID, planDigest: "digest-1", ...extra });
}

/** reserve + stage-dir + staged archive + import-session. */
async function importedOperation(op: string, extra: Record<string, unknown> = {}): Promise<{ sessionFile: string; cwd: string }> {
	await reserve(op, extra);
	const staged = await ok({ op: "stage-dir", operationId: op });
	await writeFile(staged.archivePath as string, "tar");
	const cwd = join(home, "proj");
	await mkdir(cwd, { recursive: true });
	const imported = await ok({ op: "import-session", operationId: op, sessionId: SID, cwd });
	return { sessionFile: imported.sessionFile as string, cwd };
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "transfer-helper-")));
	home = join(root, "home");
	journalDir = join(root, "state", "transfers");
	await mkdir(home, { recursive: true });
	events = [];
	reservations = new Map();
	ompCalls = [];
	spawns = [];
	spawnResult = { pid: 4242, exitCode: null };
	unpackError = undefined;
	unpackMode = "created";
	alive = true;
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("protocol and validation", () => {
	test("hello reports the host facts", async () => {
		const reply = await ok({ op: "hello" });
		expect(reply).toMatchObject({
			home,
			hostname: "worker-host",
			user: "user",
			hostId: "user@worker-host",
			ompBin: "/fake/omp",
			ompVersion: "omp 1.2.3",
			ompc: "/fake/ompc",
			rsync: true,
			freeBytes: 1234,
			transferProtocol: 1,
		});
	});

	test("hello without omp installed still answers", async () => {
		const reply = await ok({ op: "hello" }, { resolveOmpBin: () => null, resolveOmpc: () => null, hasRsync: () => false });
		expect(reply).toMatchObject({ ompBin: null, ompVersion: null, ompc: null, rsync: false });
	});

	test("protocol mismatch, missing protocol and non-object requests are refused", async () => {
		expect(fail(await runHelper({ protocol: 2, op: "hello" }, makeDeps())).code).toBe("protocol");
		expect(fail(await runHelper({ op: "hello" }, makeDeps())).code).toBe("protocol");
		expect(fail(await runHelper("hello", makeDeps())).code).toBe("invalid-request");
		expect(fail(await runHelper([], makeDeps())).code).toBe("invalid-request");
		expect(fail(await runHelper(null, makeDeps())).code).toBe("invalid-request");
	});

	test("unknown ops are refused", async () => {
		for (const op of ["nope", "__proto__", "constructor", "", 7]) {
			expect(fail(await call({ op })).code).toBe("unknown-op");
		}
		expect(fail(await runHelper({ protocol: 1 }, makeDeps())).code).toBe("unknown-op");
	});

	test("hostile ids are rejected before any filesystem or omp access", async () => {
		const bad = ["../escape", "a/b", "", "-rf", ".hidden", "x".repeat(129), "a b", "a\nb", "a;b", 5, null];
		for (const operationId of bad) {
			const reply = await call({ op: "reserve", operationId, sessionId: SID, planDigest: "d" });
			expect(fail(reply).code).toBe("invalid-request");
		}
		for (const sessionId of bad) {
			const reply = await call({ op: "reserve", operationId: newOp(), sessionId, planDigest: "d" });
			expect(fail(reply).code).toBe("invalid-request");
		}
		for (const op of ["stage-dir", "status", "rollback", "release", "cleanup", "cancel-launch", "restore-project"]) {
			expect(fail(await call({ op, operationId: "../x" })).code).toBe("invalid-request");
		}
		expect(ompCalls).toHaveLength(0);
		await expect(stat(journalDir)).rejects.toThrow();
	});

	test("hostile paths are rejected", async () => {
		const op = newOp();
		await reserve(op);
		for (const projectPath of ["relative/path", `${home}/../etc`, `${home}/a/../b`, `${home}//x`, `${home}/x\ny`, `${home}/x\0y`, "", 5]) {
			const reply = await call({ op: "inspect", sessionId: SID, projectPath });
			expect(fail(reply).code).toBe("invalid-request");
		}
		const staged = await ok({ op: "stage-dir", operationId: op });
		await writeFile(staged.archivePath as string, "tar");
		for (const cwd of ["relative", `${home}/../x`, `${home}/p\nq`]) {
			const reply = await call({ op: "import-session", operationId: op, sessionId: SID, cwd });
			expect(fail(reply).code).toBe("invalid-request");
		}
		expect(ompCalls.some((c) => c[1] === "unpack")).toBe(false);
	});

	test("an unresolved omp binary reports omp-missing and rolls back the record it created", async () => {
		const op = newOp();
		const reply = await runHelper(
			{ protocol: 1, op: "reserve", operationId: op, sessionId: SID, planDigest: "d" },
			{ journalDir, home, env: { PATH: "" }, log: () => {} },
		);
		expect(fail(reply).code).toBe("omp-missing");
		expect((await journal().load(op))?.state).toBe("rolled-back");
	});

	test("a thrown omp-missing from runOmp maps to its code", async () => {
		const reply = await call(
			{ op: "reserve", operationId: newOp(), sessionId: SID, planDigest: "d" },
			{ runOmp: async () => Promise.reject(new HelperError("omp-missing", "gone")) },
		);
		expect(fail(reply).code).toBe("omp-missing");
	});
});

describe("reserve and stage-dir", () => {
	test("reserve creates the prepared destination record and the omp reservation", async () => {
		const op = newOp();
		const reply = await reserve(op);
		expect(reply).toMatchObject({ state: "prepared", resumed: false });
		expect(ompCalls[0]).toEqual(["session", "reserve", SID, "--operation", op, "--role", "destination", "--json"]);
		const record = await journal().load(op);
		expect(record).toMatchObject({ role: "destination", sessionId: SID, planDigest: "digest-1", state: "prepared" });
		expect(reservations.get(SID)?.operationId).toBe(op);
	});

	test("reserve is idempotent for identical parameters and refuses different ones", async () => {
		const op = newOp();
		await reserve(op);
		expect(await reserve(op)).toMatchObject({ resumed: true, state: "prepared" });
		const other = await call({ op: "reserve", operationId: op, sessionId: SID, planDigest: "other" });
		expect(fail(other).code).toBe("operation-exists");
		const otherSession = await call({ op: "reserve", operationId: op, sessionId: "another-session", planDigest: "digest-1" });
		expect(fail(otherSession).code).toBe("operation-exists");
	});

	test("a second operation cannot reserve a held session", async () => {
		await reserve(newOp());
		const second = newOp();
		const reply = await call({ op: "reserve", operationId: second, sessionId: SID, planDigest: "digest-1" });
		expect(fail(reply).code).toBe("reserved");
		const record = await journal().load(second);
		expect(record?.state).toBe("rolled-back");
		expect(record?.error?.code).toBe("reserved");
	});

	test("stage-dir creates private directories and returns absolute paths", async () => {
		const op = newOp();
		await reserve(op);
		const reply = await ok({ op: "stage-dir", operationId: op });
		const opDir = join(journalDir, op);
		expect(reply.stagingRoot).toBe(join(opDir, "stage"));
		expect((reply.archivePath as string).startsWith(join(opDir, "stage"))).toBe(true);
		expect(reply.projectStaging).toBe(join(opDir, "stage", "project"));
		expect(reply.undoDir).toBe(join(opDir, "undo"));
		for (const dir of [opDir, reply.stagingRoot, join(reply.archivePath as string, ".."), reply.projectStaging, reply.undoDir]) {
			const info = await lstat(resolve(dir as string));
			expect(info.isDirectory()).toBe(true);
			expect(info.mode & 0o077).toBe(0);
		}
		const again = await ok({ op: "stage-dir", operationId: op });
		expect(again).toEqual(reply);
	});

	test("stage-dir needs a destination record", async () => {
		expect(fail(await call({ op: "stage-dir", operationId: "missing-op" })).code).toBe("operation-not-found");
	});

	test("stage-dir tightens loose permissions on an existing directory", async () => {
		const op = newOp();
		await reserve(op);
		const first = await ok({ op: "stage-dir", operationId: op });
		await chmod(first.projectStaging as string, 0o755);
		await ok({ op: "stage-dir", operationId: op });
		expect((await stat(first.projectStaging as string)).mode & 0o077).toBe(0);
	});
});

describe("inspect", () => {
	test("an absent project reports exists false", async () => {
		const reply = await ok({ op: "inspect", sessionId: SID, projectPath: join(home, "new-proj") });
		expect(reply).toMatchObject({
			resolvedProject: join(home, "new-proj"),
			exists: false,
			isDirectory: false,
			gitDirty: null,
			knownUsers: [],
			session: { existsLocally: false, sessionFile: null, reservation: null },
		});
		expect(reply.manifest).toBeUndefined();
		expect(ompCalls[0]).toEqual(["session", "locate", SID, "--cwd", join(home, "new-proj"), "--json"]);
	});

	test("an existing project returns its manifest, git state and users", async () => {
		const project = join(home, "proj");
		await mkdir(join(project, "sub"), { recursive: true });
		await writeFile(join(project, "a.txt"), "hello");
		await writeFile(join(project, "skip.log"), "x");
		const users = [{ pid: 9, cwd: project, command: "vim" }];
		reservations.set(SID, { sessionId: SID, operationId: "other", role: "source", createdAt: "t" });
		const reply = await ok(
			{ op: "inspect", sessionId: SID, projectPath: project, exclude: ["*.log"] },
			{ gitDirty: async () => true, knownUsers: async () => users },
		);
		expect(reply).toMatchObject({ exists: true, isDirectory: true, gitDirty: true, knownUsers: users });
		const paths = (reply.manifest as { entries: { path: string }[] }).entries.map((e) => e.path);
		expect(paths).toEqual(["a.txt", "sub"]);
		expect((reply.session as { reservation: { operationId: string } }).reservation.operationId).toBe("other");
	});

	test("protected, home and out-of-root paths fail the path policy", async () => {
		const cases = [join(home, ".ssh", "proj"), join(home, ".ssh"), join(home, ".local", "state", "x"), home, "/", "/etc/project", join(home, ".config")];
		for (const projectPath of cases) {
			const reply = await call({ op: "inspect", sessionId: SID, projectPath });
			expect(fail(reply).code).toBe("path-policy");
		}
	});

	test("a request policy cannot remove the built-in protections", async () => {
		const reply = await call({
			op: "inspect",
			sessionId: SID,
			projectPath: join(home, ".ssh", "proj"),
			policy: { allowedRoots: ["~"], protectedPaths: [] },
		});
		expect(fail(reply).code).toBe("path-policy");
	});

	test("a request policy can add protected paths and narrow allowed roots", async () => {
		const protectedReply = await call({
			op: "inspect",
			sessionId: SID,
			projectPath: join(home, "vault", "proj"),
			policy: { allowedRoots: ["~"], protectedPaths: [join(home, "vault")] },
		});
		expect(fail(protectedReply).code).toBe("path-policy");
		const rootsReply = await call({
			op: "inspect",
			sessionId: SID,
			projectPath: join(home, "elsewhere", "proj"),
			policy: { allowedRoots: [join(home, "work")], protectedPaths: [] },
		});
		expect(fail(rootsReply).code).toBe("path-policy");
		const allowed = await ok({
			op: "inspect",
			sessionId: SID,
			projectPath: join(home, "work", "proj"),
			policy: { allowedRoots: ["~/work"], protectedPaths: [] },
		});
		expect(allowed.exists).toBe(false);
	});

	test("a symlink escaping the allowed root is rejected", async () => {
		await mkdir(join(root, "outside"), { recursive: true });
		await mkdir(join(home, "work"), { recursive: true });
		await symlink(join(root, "outside"), join(home, "work", "link"));
		const reply = await call({
			op: "inspect",
			sessionId: SID,
			projectPath: join(home, "work", "link", "proj"),
			policy: { allowedRoots: ["~/work"], protectedPaths: [] },
		});
		expect(fail(reply).code).toBe("path-policy");
	});

	test("malformed policy and exclude are rejected", async () => {
		const projectPath = join(home, "proj");
		expect(fail(await call({ op: "inspect", sessionId: SID, projectPath, policy: "x" })).code).toBe("invalid-request");
		expect(fail(await call({ op: "inspect", sessionId: SID, projectPath, policy: { allowedRoots: [1] } })).code).toBe("invalid-request");
		expect(fail(await call({ op: "inspect", sessionId: SID, projectPath, exclude: "x" })).code).toBe("invalid-request");
	});
});

describe("import-session", () => {
	test("walks the destination record to publishing and runs a strict unpack", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		expect(sessionFile).toBe(join(home, "sessions", `2026-01-01_${SID}.jsonl`));
		const unpack = ompCalls.find((c) => c[1] === "unpack") as string[];
		expect(unpack).toEqual([
			"session",
			"unpack",
			join(journalDir, op, "stage", "archive", "session.tar"),
			"--cwd",
			cwd,
			"--strict",
			"--operation",
			op,
			"--json",
		]);
		const record = await journal().load(op);
		expect(record?.state).toBe("publishing");
		expect(record?.history.map((h) => h.state)).toEqual(["prepared", "source-stopping", "source-stopped", "staged", "publishing"]);
	});

	test("allowPrefixReplace adds the flag", async () => {
		const op = newOp();
		await reserve(op);
		const staged = await ok({ op: "stage-dir", operationId: op });
		await writeFile(staged.archivePath as string, "tar");
		await mkdir(join(home, "proj"), { recursive: true });
		await ok({ op: "import-session", operationId: op, sessionId: SID, cwd: join(home, "proj"), allowPrefixReplace: true });
		expect(ompCalls.find((c) => c[1] === "unpack")).toContain("--allow-prefix-replace");
		const bad = await call({ op: "import-session", operationId: op, sessionId: SID, cwd: join(home, "proj"), allowPrefixReplace: "yes" });
		expect(fail(bad).code).toBe("invalid-request");
	});

	test("a retry after the import is accepted again", async () => {
		const op = newOp();
		const first = await importedOperation(op);
		const again = await ok({ op: "import-session", operationId: op, sessionId: SID, cwd: first.cwd });
		expect(again.sessionFile).toBe(first.sessionFile);
		expect((await journal().load(op))?.state).toBe("publishing");
	});

	test("an omp refusal is passed through and recorded on the journal", async () => {
		const op = newOp();
		await reserve(op);
		const staged = await ok({ op: "stage-dir", operationId: op });
		await writeFile(staged.archivePath as string, "tar");
		await mkdir(join(home, "proj"), { recursive: true });
		unpackError = { code: "diverged", message: "local copy diverged" };
		const reply = await call({ op: "import-session", operationId: op, sessionId: SID, cwd: join(home, "proj") });
		expect(fail(reply)).toMatchObject({ code: "diverged", message: "local copy diverged" });
		const record = await journal().load(op);
		expect(record?.error?.code).toBe("diverged");
		expect(record?.state).toBe("publishing");
	});

	test("a missing archive, a foreign session id and a protected cwd are refused", async () => {
		const op = newOp();
		await reserve(op);
		const cwd = join(home, "proj");
		await mkdir(cwd, { recursive: true });
		expect(fail(await call({ op: "import-session", operationId: op, sessionId: SID, cwd })).code).toBe("archive-missing");
		expect(fail(await call({ op: "import-session", operationId: op, sessionId: "other", cwd })).code).toBe("session-mismatch");
		const staged = await ok({ op: "stage-dir", operationId: op });
		await writeFile(staged.archivePath as string, "tar");
		for (const bad of [home, join(home, ".ssh"), join(home, ".omp", "agent")]) {
			expect(fail(await call({ op: "import-session", operationId: op, sessionId: SID, cwd: bad })).code).toBe("path-policy");
		}
		expect(ompCalls.some((c) => c[1] === "unpack")).toBe(false);
		expect((await journal().load(op))?.state).toBe("prepared");
	});

	test("cwd must sit inside the destination project recorded at reserve", async () => {
		const op = newOp();
		const project = join(home, "proj");
		await mkdir(project, { recursive: true });
		await reserve(op, { destinationProject: project });
		const staged = await ok({ op: "stage-dir", operationId: op });
		await writeFile(staged.archivePath as string, "tar");
		await mkdir(join(home, "other"), { recursive: true });
		const reply = await call({ op: "import-session", operationId: op, sessionId: SID, cwd: join(home, "other") });
		expect(fail(reply).code).toBe("cwd-mismatch");
		await ok({ op: "import-session", operationId: op, sessionId: SID, cwd: project });
	});
});

describe("advanceTo", () => {
	test("performs each intermediate transition in order and is a no-op at or beyond the target", async () => {
		const op = newOp();
		await reserve(op);
		const j = journal();
		const record = await advanceTo(j, op, "staged");
		expect(record.history.map((h) => h.state)).toEqual(["prepared", "source-stopping", "source-stopped", "staged"]);
		expect((await advanceTo(j, op, "source-stopped")).state).toBe("staged");
		expect((await advanceTo(j, op, "publishing")).state).toBe("publishing");
	});

	test("refuses aborting and rolled-back records", async () => {
		const op = newOp();
		await reserve(op);
		const j = journal();
		await j.transition(op, "aborting");
		await expect(advanceTo(j, op, "staged")).rejects.toMatchObject({ code: "bad-state" });
	});
});

describe("publish-project", () => {
	async function sourceTree(): Promise<string> {
		const src = join(root, "src-tree");
		await mkdir(join(src, "sub"), { recursive: true });
		await writeFile(join(src, "a.txt"), "new a");
		await writeFile(join(src, "sub", "b.txt"), "b");
		return src;
	}

	test("session-only is a no-op that needs an existing directory", async () => {
		const op = newOp();
		await reserve(op);
		const dest = join(home, "proj");
		const missing = await call({ op: "publish-project", operationId: op, mode: "session-only", destRoot: dest });
		expect(fail(missing).code).toBe("destination-missing");
		await mkdir(dest, { recursive: true });
		const reply = await ok({ op: "publish-project", operationId: op, mode: "session-only", destRoot: dest });
		expect(reply).toMatchObject({ mode: "session-only", destRoot: dest, undo: { entries: 0, backupDir: null } });
		expect((await journal().load(op))?.state).toBe("prepared");
	});

	test("create renames the verified staging tree into place and replays", async () => {
		const src = await sourceTree();
		const plan = diffManifests(await buildManifest(src), undefined, "create");
		const op = newOp();
		await reserve(op, { planDigest: plan.digest, projectMode: "create" });
		const staged = await ok({ op: "stage-dir", operationId: op });
		await cp(src, staged.projectStaging as string, { recursive: true });
		const dest = join(home, "created", "proj");
		const reply = await ok({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan });
		expect(reply).toMatchObject({ mode: "create", destRoot: dest, undo: { created: plan.entries.length, backupDir: null } });
		expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("new a");
		expect(await readFile(join(dest, "sub", "b.txt"), "utf8")).toBe("b");
		expect((await journal().load(op))?.state).toBe("publishing");
		await expect(stat(staged.projectStaging as string)).rejects.toThrow();

		const replay = await ok({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan });
		expect(replay.replayed).toBe(true);
		const other = await call({ op: "publish-project", operationId: op, mode: "create", destRoot: join(home, "created", "x"), plan });
		expect(fail(other).code).toBe("already-published");
	});

	test("create refuses staging that differs from the plan, and an existing destination", async () => {
		const src = await sourceTree();
		const plan = diffManifests(await buildManifest(src), undefined, "create");
		const op = newOp();
		await reserve(op, { planDigest: plan.digest });
		const staged = await ok({ op: "stage-dir", operationId: op });
		await cp(src, staged.projectStaging as string, { recursive: true });
		await writeFile(join(staged.projectStaging as string, "extra.txt"), "unplanned");
		const dest = join(home, "created");
		const reply = await call({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan });
		expect(fail(reply)).toMatchObject({ code: "staging-mismatch", paths: ["extra.txt"] });
		await expect(stat(dest)).rejects.toThrow();
		expect((await journal().load(op))?.state).toBe("prepared");

		await rm(join(staged.projectStaging as string, "extra.txt"));
		await mkdir(dest, { recursive: true });
		const exists = await call({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan });
		expect(fail(exists).code).toBe("destination-exists");
	});

	test("a plan not bound to the reserved digest or with a bad digest is refused", async () => {
		const src = await sourceTree();
		const plan = diffManifests(await buildManifest(src), undefined, "create");
		const op = newOp();
		await reserve(op, { planDigest: "something-else" });
		const staged = await ok({ op: "stage-dir", operationId: op });
		await cp(src, staged.projectStaging as string, { recursive: true });
		const dest = join(home, "created");
		expect(fail(await call({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan })).code).toBe("plan-mismatch");
		const bound = await call({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan, planDigest: "something-else" });
		expect(bound.ok).toBe(true);

		reservations.clear();
		const op2 = newOp();
		await reserve(op2, { planDigest: plan.digest });
		const tampered = { ...plan, totalBytes: plan.totalBytes + 1 };
		const reply = await call({ op: "publish-project", operationId: op2, mode: "create", destRoot: join(home, "c2"), plan: tampered });
		expect(fail(reply).code).toBe("invalid-plan");
		const wrongMode = await call({ op: "publish-project", operationId: op2, mode: "update", destRoot: join(home, "c2"), plan });
		expect(fail(wrongMode).code).toBe("invalid-plan");
		const noPlan = await call({ op: "publish-project", operationId: op2, mode: "create", destRoot: join(home, "c2") });
		expect(fail(noPlan).code).toBe("invalid-plan");
	});

	test("update applies the plan, keeps destination-only files, and restore-project undoes it", async () => {
		const src = await sourceTree();
		const dest = join(home, "upd");
		await mkdir(dest, { recursive: true });
		await writeFile(join(dest, "a.txt"), "old a");
		await writeFile(join(dest, "extra.txt"), "keep");
		const plan = diffManifests(await buildManifest(src), await buildManifest(dest), "update");
		expect(plan.entries.map((e) => `${e.action}:${e.path}`)).toEqual(["replace:a.txt", "add:sub", "add:sub/b.txt"]);
		const op = newOp();
		await reserve(op, { planDigest: plan.digest, projectMode: "update" });
		const staged = await ok({ op: "stage-dir", operationId: op });
		await cp(src, staged.projectStaging as string, { recursive: true });
		const reply = await ok({ op: "publish-project", operationId: op, mode: "update", destRoot: dest, plan });
		expect(reply.undo).toMatchObject({ entries: 3, created: 2, replaced: 1, modeChanged: 0, backupDir: staged.undoDir });
		expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("new a");
		expect(await readFile(join(dest, "extra.txt"), "utf8")).toBe("keep");
		expect(await readFile(join(dest, "sub", "b.txt"), "utf8")).toBe("b");

		const restored = await ok({ op: "restore-project", operationId: op });
		expect(restored.conflicts).toEqual([]);
		expect((restored.restored as string[]).sort()).toEqual(["a.txt", "sub", "sub/b.txt"]);
		expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("old a");
		await expect(stat(join(dest, "sub"))).rejects.toThrow();
		expect(await readFile(join(dest, "extra.txt"), "utf8")).toBe("keep");
	});

	test("update refuses a destination that changed since the plan, and writes nothing", async () => {
		const src = await sourceTree();
		const dest = join(home, "upd");
		await mkdir(dest, { recursive: true });
		await writeFile(join(dest, "a.txt"), "old a");
		const plan = diffManifests(await buildManifest(src), await buildManifest(dest), "update");
		await writeFile(join(dest, "a.txt"), "edited since");
		const op = newOp();
		await reserve(op, { planDigest: plan.digest });
		const staged = await ok({ op: "stage-dir", operationId: op });
		await cp(src, staged.projectStaging as string, { recursive: true });
		const reply = await call({ op: "publish-project", operationId: op, mode: "update", destRoot: dest, plan });
		expect(fail(reply).code).toBe("destination-changed");
		expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("edited since");
		expect((await journal().load(op))?.error?.code).toBe("destination-changed");
	});

	test("destRoot runs through the path policy and the recorded project", async () => {
		const op = newOp();
		await reserve(op);
		for (const destRoot of [home, join(home, ".ssh", "p"), join(home, ".omp"), "/tmp-outside-home/p", join(home, ".local", "state", "omp-connected")]) {
			const reply = await call({ op: "publish-project", operationId: op, mode: "session-only", destRoot });
			expect(fail(reply).code).toBe("path-policy");
		}
		const op2 = newOp();
		await mkdir(join(home, "proj"), { recursive: true });
		await mkdir(join(home, "elsewhere"), { recursive: true });
		await call({ op: "reserve", operationId: op2, sessionId: "other-session", planDigest: "d", destinationProject: join(home, "proj") });
		const mismatch = await call({ op: "publish-project", operationId: op2, mode: "session-only", destRoot: join(home, "elsewhere") });
		expect(fail(mismatch).code).toBe("destination-mismatch");
	});

	test("restore-project without an undo manifest reports undo-missing", async () => {
		const op = newOp();
		await reserve(op);
		await ok({ op: "stage-dir", operationId: op });
		expect(fail(await call({ op: "restore-project", operationId: op })).code).toBe("undo-missing");
	});
});

describe("launch", () => {
	const nonce = "nonce-aaaa";

	function launchRequest(op: string, sessionFile: string, cwd: string, extra: Record<string, unknown> = {}) {
		return { op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce, ...extra };
	}

	test("records and consumes the intent, releases the reservation, then spawns ompc", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		const reply = await ok(launchRequest(op, sessionFile, cwd));
		expect(reply).toMatchObject({ launched: true, pid: 4242, state: "destination-starting" });
		expect(spawns).toHaveLength(1);
		expect(spawns[0]).toMatchObject({
			command: "/fake/ompc",
			args: ["--detach", "--new", "moved", "--resume", sessionFile],
			cwd,
		});
		expect(spawns[0]?.env).toMatchObject({ OMPC_TRANSFER_OPERATION: op, OMPC_TRANSFER_NONCE: nonce, OMP_BIN: "/fake/omp" });
		expect(events.indexOf("omp release")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("omp release")).toBeLessThan(events.indexOf("spawn"));
		expect(ompCalls.find((c) => c[1] === "release")).toEqual(["session", "release", SID, "--operation", op, "--json"]);
		expect(reservations.has(SID)).toBe(false);
		const record = await journal().load(op);
		expect(record?.state).toBe("destination-starting");
		expect(record?.launch).toMatchObject({ nonce, status: "consumed" });
	});

	test("repeating a launch with the same nonce does not spawn twice", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await ok(launchRequest(op, sessionFile, cwd));
		const again = await ok(launchRequest(op, sessionFile, cwd));
		expect(again).toMatchObject({ launched: true, replayed: true, pid: 4242 });
		expect(spawns).toHaveLength(1);
		const other = await call(launchRequest(op, sessionFile, cwd, { nonce: "nonce-bbbb" }));
		expect(fail(other).code).toBe("launch-intent-exists");
		expect(spawns).toHaveLength(1);
	});

	test("a consumed intent whose marker says spawning requires reconciliation", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await ok(launchRequest(op, sessionFile, cwd));
		await writeFile(join(journalDir, op, "launch.json"), JSON.stringify({ nonce, phase: "spawning" }));
		const reply = await call(launchRequest(op, sessionFile, cwd));
		expect(fail(reply).code).toBe("launch-already-consumed");
		expect(spawns).toHaveLength(1);
	});

	test("preconditions: state, imported file, cwd, ompc and name are checked before the intent is consumed", async () => {
		const op = newOp();
		await reserve(op);
		const cwd = join(home, "proj");
		await mkdir(cwd, { recursive: true });
		const file = join(home, "sessions", `2026-01-01_${SID}.jsonl`);
		expect(fail(await call(launchRequest(op, file, cwd))).code).toBe("bad-state");
		const staged = await ok({ op: "stage-dir", operationId: op });
		await writeFile(staged.archivePath as string, "tar");
		await ok({ op: "import-session", operationId: op, sessionId: SID, cwd });

		expect(fail(await call(launchRequest(op, join(home, "sessions", "other.jsonl"), cwd))).code).toBe("session-mismatch");
		expect(fail(await call(launchRequest(op, file, join(home, "missing")))).code).toBe("cwd-missing");
		expect(fail(await call(launchRequest(op, file, home))).code).toBe("path-policy");
		expect(fail(await call(launchRequest(op, file, cwd, { name: "bad name" }))).code).toBe("invalid-request");
		expect(fail(await call(launchRequest(op, file, cwd, { name: "-x" }))).code).toBe("invalid-request");
		expect(fail(await call(launchRequest(op, file, cwd, { nonce: "a b" }))).code).toBe("invalid-request");
		expect(fail(await call(launchRequest(op, "/x/not-a-journal.txt", cwd))).code).toBe("invalid-request");
		expect(fail(await call(launchRequest(op, file, cwd), { resolveOmpc: () => null })).code).toBe("ompc-missing");
		expect((await journal().load(op))?.launch).toBeUndefined();
		expect(spawns).toHaveLength(0);
		expect(reservations.has(SID)).toBe(true);
	});

	test("an unpublished project blocks launch for create and update modes", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op, { projectMode: "update" });
		expect(fail(await call(launchRequest(op, sessionFile, cwd))).code).toBe("project-not-published");
		expect(spawns).toHaveLength(0);
	});

	test("an ompc that exits non-zero fails the launch and records the error", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		spawnResult = { pid: 1, exitCode: 73, stderr: "session exists" };
		const reply = await call(launchRequest(op, sessionFile, cwd));
		expect(fail(reply).code).toBe("launch-failed");
		const record = await journal().load(op);
		expect(record?.error?.code).toBe("launch-failed");
		expect(record?.launch?.status).toBe("consumed");
	});

	test("a spawn failure writes a failed marker and the same nonce may launch again", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		spawnResult = { pid: 1, exitCode: 73, stderr: "session exists" };
		expect(fail(await call(launchRequest(op, sessionFile, cwd))).code).toBe("launch-failed");
		const marker = JSON.parse(await readFile(join(journalDir, op, "launch.json"), "utf8"));
		expect(marker).toMatchObject({ nonce, failed: true });
		expect(await ok({ op: "status", operationId: op })).toMatchObject({ launched: null, launchFailed: true, launch: { status: "consumed" } });

		spawnResult = { pid: 4242, exitCode: null };
		const again = await ok(launchRequest(op, sessionFile, cwd));
		expect(again).toMatchObject({ launched: true, pid: 4242, state: "destination-starting" });
		expect(again.replayed).toBeUndefined();
		expect(spawns).toHaveLength(2);
		expect(await ok({ op: "status", operationId: op })).toMatchObject({ launched: { pid: 4242 }, launchFailed: false });

		const replay = await ok(launchRequest(op, sessionFile, cwd));
		expect(replay).toMatchObject({ launched: true, replayed: true });
		expect(spawns).toHaveLength(2);
	});

	test("a retry with a different nonce after a spawn failure is still refused", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		spawnResult = { pid: 1, exitCode: 73 };
		await call(launchRequest(op, sessionFile, cwd));
		spawnResult = { pid: 4242, exitCode: null };
		expect(fail(await call(launchRequest(op, sessionFile, cwd, { nonce: "nonce-bbbb" }))).code).toBe("launch-intent-exists");
		expect(spawns).toHaveLength(1);
	});

	test("a spawn failure that was rolled back cannot be retried", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		spawnResult = { pid: 1, exitCode: 73 };
		await call(launchRequest(op, sessionFile, cwd));
		expect(await ok({ op: "rollback", operationId: op })).toMatchObject({ state: "rolled-back", cancelled: "launch-failed" });
		expect((await journal().load(op))?.state).toBe("rolled-back");
		expect(reservations.has(SID)).toBe(false);
		spawnResult = { pid: 4242, exitCode: null };
		expect(fail(await call(launchRequest(op, sessionFile, cwd))).code).toBe("bad-state");
		expect(spawns).toHaveLength(1);
	});

	test("the default spawner runs ompc in cwd with the nonce environment", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		const out = join(root, "ompc-out.txt");
		const stub = join(root, "ompc-stub");
		await writeFile(stub, `#!/bin/sh\n{ pwd; echo "$@"; echo "$OMPC_TRANSFER_OPERATION $OMPC_TRANSFER_NONCE"; } > "${out}"\n`);
		await chmod(stub, 0o755);
		const deps = makeDeps({ resolveOmpc: () => stub });
		delete deps.spawnDetached;
		const reply = await runHelper({ protocol: HELPER_PROTOCOL, ...launchRequest(op, sessionFile, cwd) }, deps);
		expect(reply).toMatchObject({ ok: true, launched: true });
		const lines = (await readFile(out, "utf8")).trim().split("\n");
		expect(lines[0]).toBe(cwd);
		expect(lines[1]).toBe(`--detach --new moved --resume ${sessionFile}`);
		expect(lines[2]).toBe(`${op} ${nonce}`);
	});
});

describe("launch intent races", () => {
	const nonce = "race-nonce";

	test("a cancel before any launch tombstones the intent and the late launch is refused", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		const cancelled = await ok({ op: "cancel-launch", operationId: op });
		expect(cancelled).toMatchObject({ result: "cancelled", tombstoned: true });
		const late = await call({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce });
		expect(fail(late).code).toBe("launch-cancelled");
		expect(spawns).toHaveLength(0);
		expect(reservations.has(SID)).toBe(true);
		expect((await journal().load(op))?.state).toBe("publishing");
		expect(await ok({ op: "cancel-launch", operationId: op })).toMatchObject({ result: "cancelled" });
	});

	test("a cancel after the launch consumed the intent reports already-consumed", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await ok({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce });
		expect(await ok({ op: "cancel-launch", operationId: op })).toMatchObject({ result: "already-consumed", tombstoned: false });
	});

	test("cancel-launch for an unknown operation reports none", async () => {
		expect(await ok({ op: "cancel-launch", operationId: "no-such-op" })).toMatchObject({ result: "none" });
	});

	test("concurrent launch and cancel never both win", async () => {
		for (let i = 0; i < 6; i++) {
			reservations.clear();
			const op = newOp();
			const { sessionFile, cwd } = await importedOperation(op);
			spawns.length = 0;
			const launchRequest = () => call({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce });
			const cancelRequest = () => call({ op: "cancel-launch", operationId: op });
			const cancelFirst = i % 2 === 1;
			const cancelPromise = cancelFirst ? cancelRequest() : undefined;
			const launchPromise = launchRequest();
			const [launch, cancel] = await Promise.all([launchPromise, cancelPromise ?? cancelRequest()]);
			const cancelled = cancel as { result: string };
			const launched = spawns.length === 1;
			expect(spawns.length).toBeLessThanOrEqual(1);
			expect(launched).toBe(cancelled.result === "already-consumed");
			if (!launched) expect(fail(launch).code).toBe("launch-cancelled");
			const record = await journal().load(op);
			expect(record?.launch?.status).toBe(launched ? "consumed" : "cancelled");
		}
	});
});

describe("rollback and release", () => {
	test("rollback before launch cancels the intent, releases the reservation and rolls back", async () => {
		const op = newOp();
		await reserve(op);
		const reply = await ok({ op: "rollback", operationId: op });
		expect(reply).toMatchObject({ state: "rolled-back", cancelled: "cancelled" });
		expect(reservations.has(SID)).toBe(false);
		const record = await journal().load(op);
		expect(record?.state).toBe("rolled-back");
		expect(record?.history.map((h) => h.state)).toEqual(["prepared", "aborting", "rolled-back"]);
		expect(record?.launch?.status).toBe("cancelled");
		expect(await ok({ op: "rollback", operationId: op })).toMatchObject({ state: "rolled-back", replayed: true });
	});

	test("a launch arriving after rollback is refused and spawns nothing", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await ok({ op: "rollback", operationId: op });
		const late = await call({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce: "late-nonce" });
		expect(fail(late).code).toBe("launch-cancelled");
		expect(spawns).toHaveLength(0);
	});

	test("rollback with a recorded but unconsumed intent cancels it", async () => {
		const op = newOp();
		await reserve(op);
		await journal().recordLaunchIntent(op, "pending-nonce");
		const reply = await ok({ op: "rollback", operationId: op });
		expect(reply.cancelled).toBe("cancelled");
		expect((await journal().load(op))?.launch?.status).toBe("cancelled");
	});

	test("rollback after the launch consumed the intent is refused and changes nothing", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await ok({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce: "n-1" });
		ompCalls.length = 0;
		const reply = await call({ op: "rollback", operationId: op });
		expect(fail(reply).code).toBe("launch-already-consumed");
		expect(ompCalls).toHaveLength(0);
		expect((await journal().load(op))?.state).toBe("destination-starting");
	});

	test("rollback resumes from aborting after a crash and keeps the reservation until released", async () => {
		const op = newOp();
		await reserve(op);
		await journal().transition(op, "aborting");
		const reply = await ok({ op: "rollback", operationId: op });
		expect(reply.state).toBe("rolled-back");
		expect(reservations.has(SID)).toBe(false);
	});

	test("rollback of a completed operation is refused", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await ok({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce: "n-2" });
		await ok({ op: "release", operationId: op });
		expect(fail(await call({ op: "rollback", operationId: op })).code).toBe("bad-state");
	});

	test("release completes the record after launch and is idempotent", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		expect(fail(await call({ op: "release", operationId: op })).code).toBe("bad-state");
		await ok({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce: "n-3" });
		expect(await ok({ op: "release", operationId: op })).toMatchObject({ state: "completed" });
		expect((await journal().load(op))?.state).toBe("completed");
		expect(await ok({ op: "release", operationId: op })).toMatchObject({ state: "completed", replayed: true });
	});

	test("rollback and release of an unknown operation report operation-not-found", async () => {
		expect(fail(await call({ op: "rollback", operationId: "nope" })).code).toBe("operation-not-found");
		expect(fail(await call({ op: "release", operationId: "nope" })).code).toBe("operation-not-found");
	});
});

describe("verify-arrival", () => {
	const nonce = "arrive-nonce";

	async function launched(): Promise<{ op: string; cwd: string }> {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await ok({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce });
		return { op, cwd };
	}

	function writeArrival(op: string, value: Record<string, unknown>): Promise<void> {
		return writeFile(join(journalDir, op, "arrival.json"), JSON.stringify(value));
	}

	const verify = (op: string, cwd: string, extra: Record<string, unknown> = {}) =>
		ok({ op: "verify-arrival", operationId: op, nonce, sessionId: SID, cwd, ...extra });

	test("arrived requires matching nonce, session id, cwd and a live pid", async () => {
		const { op, cwd } = await launched();
		await writeArrival(op, { nonce, sessionId: SID, cwd, pid: 777, hostId: "user@worker-host", label: "proj.moved" });
		expect(await verify(op, cwd)).toEqual({ ok: true, arrived: true, exited: false, hostId: "user@worker-host", label: "proj.moved", pid: 777 });
	});

	test("mismatches are not arrivals; a dead pid is an exited arrival", async () => {
		const { op, cwd } = await launched();
		const good = { nonce, sessionId: SID, cwd, pid: 777, hostId: "h", label: "l" };
		const cases: [Record<string, unknown>, string][] = [
			[{ ...good, nonce: "other-nonce" }, "nonce-mismatch"],
			[{ ...good, sessionId: "another" }, "session-mismatch"],
			[{ ...good, cwd: join(home, "elsewhere") }, "cwd-mismatch"],
			[{ ...good, pid: 0 }, "arrival-malformed"],
			[{ ...good, pid: "777" }, "arrival-malformed"],
			[{ ...good, cwd: 5 }, "arrival-malformed"],
		];
		for (const [arrival, reason] of cases) {
			await writeArrival(op, arrival);
			expect(await verify(op, cwd)).toMatchObject({ arrived: false, reason, hostId: null, label: null, pid: null });
		}
		await writeArrival(op, good);
		alive = false;
		expect(await verify(op, cwd)).toMatchObject({ arrived: true, exited: true, pid: 777, hostId: "h", label: "l" });
	});

	test("no arrival file, a wrong request nonce and a symlinked arrival file are not arrivals", async () => {
		const { op, cwd } = await launched();
		expect(await verify(op, cwd)).toMatchObject({ arrived: false, reason: "no-arrival-record" });
		expect(await verify(op, cwd, { nonce: "wrong-nonce" })).toMatchObject({ arrived: false, reason: "nonce-mismatch" });
		const target = join(root, "elsewhere.json");
		await writeFile(target, JSON.stringify({ nonce, sessionId: SID, cwd, pid: 777 }));
		await symlink(target, join(journalDir, op, "arrival.json"));
		expect(await verify(op, cwd)).toMatchObject({ arrived: false, reason: "arrival-unreadable" });
	});

	test("an oversize or non-JSON arrival file is not an arrival", async () => {
		const { op, cwd } = await launched();
		await writeFile(join(journalDir, op, "arrival.json"), "not json");
		expect(await verify(op, cwd)).toMatchObject({ arrived: false, reason: "arrival-unreadable" });
		await writeFile(join(journalDir, op, "arrival.json"), "x".repeat(70_000));
		expect(await verify(op, cwd)).toMatchObject({ arrived: false, reason: "arrival-unreadable" });
	});

	test("before the intent is consumed nothing can arrive", async () => {
		const op = newOp();
		const { cwd } = await importedOperation(op);
		await mkdir(join(journalDir, op), { recursive: true });
		await writeArrival(op, { nonce, sessionId: SID, cwd, pid: 777 });
		expect(await verify(op, cwd)).toMatchObject({ arrived: false, reason: "launch-not-consumed" });
	});

	test("a foreign session id in the request is refused", async () => {
		const { op, cwd } = await launched();
		const reply = await call({ op: "verify-arrival", operationId: op, nonce, sessionId: "another", cwd });
		expect(fail(reply).code).toBe("session-mismatch");
	});
});

describe("status and cleanup", () => {
	test("status of an unknown operation has a null record", async () => {
		expect(await ok({ op: "status", operationId: "nope" })).toMatchObject({ record: null, reservation: null, launch: null });
	});

	test("status returns the record, reservation and launch, and survives a missing omp", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await ok({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce: "st-1" });
		reservations.set(SID, { sessionId: SID, operationId: "someone", role: "source", createdAt: "t" });
		const reply = await ok({ op: "status", operationId: op });
		expect(reply).toMatchObject({
			record: { operationId: op, state: "destination-starting" },
			reservation: { operationId: "someone" },
			launch: { status: "consumed" },
			launched: { pid: 4242 },
		});
		const offline = await ok(
			{ op: "status", operationId: op },
			{ runOmp: async () => Promise.reject(new HelperError("omp-missing", "gone")) },
		);
		expect(offline).toMatchObject({ reservation: null, reservationError: "omp-missing", record: { state: "destination-starting" } });
	});

	test("cleanup removes staging and keeps undo backups unless asked", async () => {
		const op = newOp();
		await reserve(op);
		const staged = await ok({ op: "stage-dir", operationId: op });
		await writeFile(join(staged.undoDir as string, "marker"), "backup");
		expect(await ok({ op: "cleanup", operationId: op })).toEqual({ ok: true, stagingRemoved: true, backupsRemoved: false });
		await expect(stat(staged.stagingRoot as string)).rejects.toThrow();
		expect(await readFile(join(staged.undoDir as string, "marker"), "utf8")).toBe("backup");
		expect(await ok({ op: "cleanup", operationId: op })).toMatchObject({ stagingRemoved: false });

		expect(fail(await call({ op: "cleanup", operationId: op, removeBackups: true })).code).toBe("bad-state");
		await ok({ op: "rollback", operationId: op });
		expect(await ok({ op: "cleanup", operationId: op, removeBackups: true })).toMatchObject({ backupsRemoved: true });
		await expect(stat(staged.undoDir as string)).rejects.toThrow();
		expect((await readdir(join(journalDir, op))).includes("undo")).toBe(false);
	});

	test("cleanup refuses a symlinked staging directory", async () => {
		const op = newOp();
		await reserve(op);
		await mkdir(join(journalDir, op), { recursive: true });
		await mkdir(join(root, "victim"), { recursive: true });
		await writeFile(join(root, "victim", "keep"), "x");
		await symlink(join(root, "victim"), join(journalDir, op, "stage"));
		expect(fail(await call({ op: "cleanup", operationId: op })).code).toBe("stage-unsafe");
		expect(await readFile(join(root, "victim", "keep"), "utf8")).toBe("x");
	});
});

describe("main", () => {
	async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<string | Uint8Array> {
		for (const part of parts) yield part;
	}

	async function run(stdin: AsyncIterable<string | Uint8Array>, maxBytes?: number): Promise<{ lines: string[]; reply: HelperReply }> {
		const out: string[] = [];
		const reply = await main({ stdin, write: (text) => out.push(text), maxBytes, deps: makeDeps() });
		return { lines: out.join("").split("\n").filter((l) => l !== ""), reply };
	}

	test("one request in, exactly one JSON line out", async () => {
		const { lines, reply } = await run(chunks('{"protocol":1,', '"op":"hello"}'));
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toEqual(reply);
		expect(reply.ok).toBe(true);
	});

	test("non-JSON, empty and non-object input give invalid-request", async () => {
		for (const input of ["not json", "", "   ", "[1]", "42"]) {
			const { lines, reply } = await run(chunks(input));
			expect(lines).toHaveLength(1);
			expect(fail(reply).code).toBe("invalid-request");
		}
	});

	test("oversize input is refused with request-too-large", async () => {
		const big = `{"protocol":1,"op":"hello","pad":"${"x".repeat(1024 * 1024)}"}`;
		const { reply, lines } = await run(chunks(big.slice(0, 600_000), big.slice(600_000)));
		expect(fail(reply).code).toBe("request-too-large");
		expect(lines).toHaveLength(1);
		const small = await run(chunks('{"protocol":1,"op":"hello"}'), 8);
		expect(fail(small.reply).code).toBe("request-too-large");
	});
});

describe("ompc-transfer-helper executable", () => {
	let binHome: string;
	let stateHome: string;
	let stub: string;

	beforeEach(async () => {
		binHome = join(root, "bin-home");
		stateHome = join(root, "bin-state");
		await mkdir(binHome, { recursive: true });
		stub = join(root, "omp-stub");
		await writeFile(
			stub,
			[
				"#!/bin/sh",
				'echo "stub diagnostics" >&2',
				'case "$1" in',
				'	--version) echo "omp 9.9.9" ;;',
				'	*) echo \'{"ok":true,"reservation":null}\' ;;',
				"esac",
				"",
			].join("\n"),
		);
		await chmod(stub, 0o755);
	});

	async function runBin(input: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
		const proc = Bun.spawn([process.execPath, BIN], {
			stdin: new Blob([input]),
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: process.env.PATH ?? "", HOME: binHome, XDG_STATE_HOME: stateHome, OMP_BIN: stub, ...env },
		});
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { stdout, stderr, code };
	}

	function singleReply(stdout: string): Record<string, unknown> {
		expect(stdout.endsWith("\n")).toBe(true);
		const lines = stdout.split("\n").filter((l) => l !== "");
		expect(lines).toHaveLength(1);
		return JSON.parse(lines[0] as string) as Record<string, unknown>;
	}

	test("hello prints exactly one JSON line even when omp writes diagnostics", async () => {
		const result = await runBin('{"protocol":1,"op":"hello"}');
		expect(result.code).toBe(0);
		const reply = singleReply(result.stdout);
		expect(reply).toMatchObject({ ok: true, home: binHome, ompBin: stub, ompVersion: "omp 9.9.9", transferProtocol: 1 });
	});

	test("reserve through the executable writes the record under the state directory", async () => {
		const request = { protocol: 1, op: "reserve", operationId: "bin-op", sessionId: SID, planDigest: "d" };
		const result = await runBin(JSON.stringify(request));
		expect(result.code).toBe(0);
		expect(singleReply(result.stdout)).toMatchObject({ ok: true, state: "prepared" });
		expect(result.stderr).toContain("stub diagnostics");
		const record = JSON.parse(await readFile(join(stateHome, "omp-connected", "transfers", "bin-op.json"), "utf8"));
		expect(record).toMatchObject({ role: "destination", sessionId: SID, state: "prepared" });
	});

	test("bad input still yields one JSON line and exit code 0", async () => {
		for (const input of ["", "not json", '{"protocol":9,"op":"hello"}', '{"protocol":1,"op":"bogus"}']) {
			const result = await runBin(input);
			expect(result.code).toBe(0);
			expect(singleReply(result.stdout).ok).toBe(false);
		}
		const oversize = await runBin(`{"protocol":1,"op":"hello","pad":"${"x".repeat(1024 * 1024 + 10)}"}`);
		expect(singleReply(oversize.stdout)).toMatchObject({ ok: false, code: "request-too-large" });
	});

	test("a missing omp binary reports omp-missing", async () => {
		const request = { protocol: 1, op: "reserve", operationId: "bin-op-2", sessionId: SID, planDigest: "d" };
		const result = await runBin(JSON.stringify(request), { OMP_BIN: join(root, "does-not-exist") });
		expect(singleReply(result.stdout)).toMatchObject({ ok: false, code: "omp-missing" });
	});
});

describe("launch attempt markers", () => {
	const nonce = "mark-nonce";
	const launchReq = (op: string, sessionFile: string, cwd: string) => ({
		op: "launch",
		operationId: op,
		sessionFile,
		cwd,
		name: "moved",
		nonce,
	});
	const markerPath = (op: string) => join(journalDir, op, "launch.json");
	const readMarker = async (op: string) => JSON.parse(await readFile(markerPath(op), "utf8"));

	test("attempt is written before the intent is consumed, spawning right before ompc, spawned after", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		const seen: Record<string, unknown> = {};
		await ok(launchReq(op, sessionFile, cwd), {
			runOmp: async (args) => {
				if (args[1] === "release") seen.atRelease = await readMarker(op);
				return fakeOmp(args);
			},
			spawnDetached: async (command, args, options) => {
				seen.atSpawn = await readMarker(op);
				spawns.push({ command, args, cwd: options.cwd, env: options.env });
				return spawnResult;
			},
		});
		expect(seen.atRelease).toMatchObject({ nonce, phase: "attempt" });
		expect(seen.atSpawn).toMatchObject({ nonce, phase: "spawning" });
		expect(await readMarker(op)).toMatchObject({ nonce, phase: "spawned", pid: 4242 });
	});

	test("a failure before the spawn call writes a failed marker and the same nonce can launch again", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		const failingRelease = async (args: string[]) =>
			args[1] === "release" ? { ok: false, code: "other", message: "release boom" } : fakeOmp(args);
		const first = await call(launchReq(op, sessionFile, cwd), { runOmp: failingRelease });
		expect(fail(first).code).toBe("other");
		expect(spawns).toHaveLength(0);
		expect(await readMarker(op)).toMatchObject({ nonce, phase: "failed", failed: true });
		expect((await journal().load(op))?.launch?.status).toBe("consumed");

		const again = await ok(launchReq(op, sessionFile, cwd));
		expect(again).toMatchObject({ launched: true, pid: 4242 });
		expect(again.replayed).toBeUndefined();
		expect(spawns).toHaveLength(1);
		expect(await ok(launchReq(op, sessionFile, cwd))).toMatchObject({ replayed: true });
		expect(spawns).toHaveLength(1);
	});

	test("a consumed intent with no marker (crash before the attempt was recorded) is retryable once", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await journal().recordLaunchIntent(op, nonce);
		expect(await journal().consumeLaunchIntent(op, nonce)).toBe(true);
		const reply = await ok(launchReq(op, sessionFile, cwd));
		expect(reply).toMatchObject({ launched: true });
		expect(spawns).toHaveLength(1);
		expect(await ok(launchReq(op, sessionFile, cwd))).toMatchObject({ replayed: true });
		expect(spawns).toHaveLength(1);
	});

	test("a spawning marker (crash around the spawn) blocks both a second launch and rollback", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await journal().recordLaunchIntent(op, nonce);
		await journal().consumeLaunchIntent(op, nonce);
		await mkdir(join(journalDir, op), { recursive: true });
		await writeFile(markerPath(op), JSON.stringify({ nonce, phase: "spawning" }));
		expect(fail(await call(launchReq(op, sessionFile, cwd))).code).toBe("launch-already-consumed");
		expect(fail(await call({ op: "rollback", operationId: op })).code).toBe("launch-already-consumed");
		expect(spawns).toHaveLength(0);
		expect((await journal().load(op))?.state).toBe("publishing");
	});

	test("an unexpected error from the spawner keeps the spawning marker so no second spawn is possible", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		const first = await call(launchReq(op, sessionFile, cwd), {
			spawnDetached: async () => Promise.reject(new Error("spawner crashed")),
		});
		expect(fail(first).code).toBe("internal");
		expect(await readMarker(op)).toMatchObject({ nonce, phase: "spawning" });
		expect(await ok({ op: "status", operationId: op })).toMatchObject({ launchPhase: "spawning", launched: null, launchFailed: false });
		expect(fail(await call(launchReq(op, sessionFile, cwd))).code).toBe("launch-already-consumed");
		expect(spawns).toHaveLength(0);
	});

	test("a spawner that reports it never started leaves a failed marker", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		const first = await call(launchReq(op, sessionFile, cwd), {
			spawnDetached: async () => Promise.reject(new HelperError("launch-failed", "cannot start ompc")),
		});
		expect(fail(first).code).toBe("launch-failed");
		expect(await readMarker(op)).toMatchObject({ phase: "failed", failed: true });
	});

	test("rollback is allowed while the marker only says attempt", async () => {
		const op = newOp();
		await importedOperation(op);
		await journal().recordLaunchIntent(op, nonce);
		await journal().consumeLaunchIntent(op, nonce);
		await writeFile(markerPath(op), JSON.stringify({ nonce, phase: "attempt" }));
		expect(await ok({ op: "rollback", operationId: op })).toMatchObject({ state: "rolled-back", cancelled: "launch-not-started" });
	});
});

describe("reserve ordering and orphan rollback", () => {
	test("the journal record exists before omp reserve runs", async () => {
		const op = newOp();
		let during: OperationRecord | undefined;
		await ok(
			{ op: "reserve", operationId: op, sessionId: SID, planDigest: "d1" },
			{
				runOmp: async (args) => {
					if (args[1] === "reserve") during = await journal().load(op);
					return fakeOmp(args);
				},
			},
		);
		expect(during?.state).toBe("prepared");
	});

	test("a failed reserve rolls back the record it created and the operation id cannot be reused", async () => {
		const op = newOp();
		reservations.set(SID, { sessionId: SID, operationId: "other-op", role: "destination", createdAt: "t" });
		expect(fail(await call({ op: "reserve", operationId: op, sessionId: SID, planDigest: "d1" })).code).toBe("reserved");
		const record = await journal().load(op);
		expect(record?.state).toBe("rolled-back");
		expect(record?.history.map((h) => h.state)).toEqual(["prepared", "aborting", "rolled-back"]);
		expect(record?.error?.code).toBe("reserved");
		reservations.clear();
		expect(fail(await call({ op: "reserve", operationId: op, sessionId: SID, planDigest: "d1" })).code).toBe("bad-state");
	});

	test("a failed reserve of an existing record keeps it and records the error", async () => {
		const op = newOp();
		await reserve(op);
		const failing = async (args: string[]) => (args[1] === "reserve" ? { ok: false, code: "other", message: "later" } : fakeOmp(args));
		expect(fail(await call({ op: "reserve", operationId: op, sessionId: SID, planDigest: "digest-1" }, { runOmp: failing })).code).toBe("other");
		const record = await journal().load(op);
		expect(record?.state).toBe("prepared");
		expect(record?.error?.code).toBe("other");
		expect(await reserve(op)).toMatchObject({ resumed: true });
	});

	test("rollback without a record releases a destination reservation held by that operation id", async () => {
		reservations.set(SID, { sessionId: SID, operationId: "orphan-op", role: "destination", createdAt: "t" });
		expect(fail(await call({ op: "rollback", operationId: "orphan-op" })).code).toBe("operation-not-found");
		expect(reservations.has(SID)).toBe(true);
		expect(await ok({ op: "rollback", operationId: "orphan-op", sessionId: SID })).toMatchObject({ state: "no-record", released: true });
		expect(reservations.has(SID)).toBe(false);
		expect(await ok({ op: "rollback", operationId: "orphan-op", sessionId: SID })).toMatchObject({ state: "no-record", released: false });
	});

	test("rollback without a record leaves another operation's or a source reservation alone", async () => {
		reservations.set(SID, { sessionId: SID, operationId: "someone-else", role: "destination", createdAt: "t" });
		expect(await ok({ op: "rollback", operationId: "orphan-op", sessionId: SID })).toMatchObject({ released: false });
		expect(reservations.get(SID)?.operationId).toBe("someone-else");
		reservations.set(SID, { sessionId: SID, operationId: "orphan-op", role: "source", createdAt: "t" });
		expect(await ok({ op: "rollback", operationId: "orphan-op", sessionId: SID })).toMatchObject({ released: false });
		expect(reservations.has(SID)).toBe(true);
		expect(fail(await call({ op: "rollback", operationId: "orphan-op", sessionId: "-x" })).code).toBe("invalid-request");
	});

	test("rollback of an existing record rejects a different sessionId", async () => {
		const op = newOp();
		await reserve(op);
		expect(fail(await call({ op: "rollback", operationId: op, sessionId: "another-session" })).code).toBe("session-mismatch");
		expect((await journal().load(op))?.state).toBe("prepared");
	});

	test("import-session refuses an operation that no longer holds the reservation", async () => {
		const op = newOp();
		await reserve(op);
		const staged = await ok({ op: "stage-dir", operationId: op });
		await writeFile(staged.archivePath as string, "tar");
		reservations.clear();
		const cwd = join(home, "proj");
		await mkdir(cwd, { recursive: true });
		expect(fail(await call({ op: "import-session", operationId: op, sessionId: SID, cwd })).code).toBe("reservation-missing");
		expect(ompCalls.some((c) => c[1] === "unpack")).toBe(false);
		expect((await journal().load(op))?.state).toBe("prepared");
	});
});

describe("rollback removes the imported session", () => {
	const sessionsDir = () => join(home, "sessions");
	const jsonl = () => join(sessionsDir(), `2026-01-01_${SID}.jsonl`);
	const artifacts = () => join(sessionsDir(), `2026-01-01_${SID}`);
	const exists = (p: string) => stat(p).then(() => true, () => false);

	test("a session this operation created is removed with its artifacts", async () => {
		const op = newOp();
		await importedOperation(op);
		expect(await exists(jsonl())).toBe(true);
		expect(await exists(join(artifacts(), "child.jsonl"))).toBe(true);
		const reply = await ok({ op: "rollback", operationId: op });
		expect(reply).toMatchObject({ state: "rolled-back", importedRemoved: [jsonl(), artifacts()], importedCopyKept: false });
		expect(await exists(jsonl())).toBe(false);
		expect(await exists(artifacts())).toBe(false);
		expect(JSON.parse(await readFile(join(journalDir, op, "import.json"), "utf8"))).toMatchObject({ removed: true });
		expect(reservations.has(SID)).toBe(false);
	});

	test("a failed launch is rolled back and its imported session removed", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		spawnResult = { pid: 1, exitCode: 73 };
		await call({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce: "rb-nonce" });
		const reply = await ok({ op: "rollback", operationId: op });
		expect(reply).toMatchObject({ cancelled: "launch-failed", importedCopyKept: false });
		expect(await exists(jsonl())).toBe(false);
	});

	test("a session that replaced an existing copy is kept", async () => {
		unpackMode = "replaced";
		const op = newOp();
		await importedOperation(op);
		const reply = await ok({ op: "rollback", operationId: op });
		expect(reply).toMatchObject({ state: "rolled-back", importedRemoved: [], importedCopyKept: true, importedKeptReason: "replaced-existing-copy" });
		expect(await exists(jsonl())).toBe(true);
		expect(await exists(artifacts())).toBe(true);
	});

	test("a replayed import keeps the mode of the first import", async () => {
		const op = newOp();
		const { cwd } = await importedOperation(op);
		unpackMode = "replayed";
		await ok({ op: "import-session", operationId: op, sessionId: SID, cwd });
		expect(JSON.parse(await readFile(join(journalDir, op, "import.json"), "utf8"))).toMatchObject({ mode: "created", lastMode: "replayed" });
		expect(await ok({ op: "rollback", operationId: op })).toMatchObject({ importedCopyKept: false });
		expect(await exists(jsonl())).toBe(false);
	});

	test("a replayed import with no earlier record cannot show whether a copy pre-existed, so it is kept", async () => {
		unpackMode = "replayed";
		const op = newOp();
		await importedOperation(op);
		const reply = await ok({ op: "rollback", operationId: op });
		expect(reply).toMatchObject({ importedCopyKept: true, importedKeptReason: "pre-existing-copy-unknown" });
		expect(await exists(jsonl())).toBe(true);
	});

	test("a recorded path outside the sessions directory is never deleted", async () => {
		const op = newOp();
		await reserve(op);
		const staged = await ok({ op: "stage-dir", operationId: op });
		await writeFile(staged.archivePath as string, "tar");
		const cwd = join(home, "proj");
		await mkdir(cwd, { recursive: true });
		await mkdir(sessionsDir(), { recursive: true });
		const stray = join(home, "elsewhere", `2026-01-01_${SID}.jsonl`);
		await mkdir(join(home, "elsewhere"), { recursive: true });
		await writeFile(stray, "{}\n");
		const strayUnpack = async (args: string[]) =>
			args[1] === "unpack" ? { ok: true, sessionFile: stray, id: SID, mode: "created" } : fakeOmp(args);
		await ok({ op: "import-session", operationId: op, sessionId: SID, cwd }, { runOmp: strayUnpack });
		const reply = await ok({ op: "rollback", operationId: op });
		expect(reply).toMatchObject({ importedCopyKept: true, importedKeptReason: "outside-sessions-dir", importedRemoved: [] });
		expect(await exists(stray)).toBe(true);
		expect((await journal().load(op))?.state).toBe("rolled-back");
	});

	test("after the launch consumed the intent nothing is removed", async () => {
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op);
		await ok({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce: "rb-2" });
		expect(fail(await call({ op: "rollback", operationId: op })).code).toBe("launch-already-consumed");
		expect(await exists(jsonl())).toBe(true);
		expect(await exists(artifacts())).toBe(true);
	});

	test("a repeated rollback after a crash mid-way finishes without deleting twice", async () => {
		const op = newOp();
		await importedOperation(op);
		await journal().transition(op, "aborting");
		await rm(jsonl());
		const reply = await ok({ op: "rollback", operationId: op });
		expect(reply).toMatchObject({ state: "rolled-back", importedCopyKept: false, importedRemoved: [artifacts()] });
	});
});

describe("per-operation busy lock", () => {
	test("a second call for an operation with a call in progress gets op-busy, then works after", async () => {
		const op = newOp();
		await reserve(op);
		const staged = await ok({ op: "stage-dir", operationId: op });
		await writeFile(staged.archivePath as string, "tar");
		const cwd = join(home, "proj");
		await mkdir(cwd, { recursive: true });
		const importReq = { op: "import-session", operationId: op, sessionId: SID, cwd };

		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const slow = async (args: string[]) => {
			if (args[1] === "unpack") {
				started.resolve();
				await gate.promise;
			}
			return fakeOmp(args);
		};
		const first = call(importReq, { runOmp: slow });
		await started.promise;

		const busy = fail(await call(importReq));
		expect(busy).toMatchObject({ code: "op-busy", retryable: true });
		for (const request of [
			{ op: "rollback", operationId: op },
			{ op: "restore-project", operationId: op },
			{ op: "cleanup", operationId: op },
			{ op: "publish-project", operationId: op, mode: "session-only", destRoot: cwd },
			{ op: "launch", operationId: op, sessionFile: join(home, "x.jsonl"), cwd, name: "moved", nonce: "busy-nonce" },
		]) {
			expect(fail(await call(request)).code).toBe("op-busy");
		}
		expect(spawns).toHaveLength(0);

		gate.resolve();
		expect((await first).ok).toBe(true);
		expect((await call(importReq)).ok).toBe(true);
	});

	test("different operations do not block each other", async () => {
		const first = newOp();
		const second = newOp();
		await reserve(first);
		reservations.clear();
		await ok({ op: "reserve", operationId: second, sessionId: "other-session", planDigest: "d" });
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const slow = async (args: string[]) => {
			if (args[1] === "unpack") {
				started.resolve();
				await gate.promise;
			}
			return fakeOmp(args);
		};
		const staged = await ok({ op: "stage-dir", operationId: first });
		await writeFile(staged.archivePath as string, "tar");
		const cwd = join(home, "proj");
		await mkdir(cwd, { recursive: true });
		reservations.set(SID, { sessionId: SID, operationId: first, role: "destination", createdAt: "t" });
		const running = call({ op: "import-session", operationId: first, sessionId: SID, cwd }, { runOmp: slow });
		await started.promise;
		expect((await call({ op: "rollback", operationId: second, sessionId: "other-session" })).ok).toBe(true);
		gate.resolve();
		expect((await running).ok).toBe(true);
	});
});

describe("publish-project recovery and restore", () => {
	async function tree(): Promise<string> {
		const src = join(root, "recovery-src");
		await mkdir(join(src, "sub"), { recursive: true });
		await writeFile(join(src, "a.txt"), "new a");
		await writeFile(join(src, "sub", "b.txt"), "b");
		return src;
	}
	const finalMarker = (op: string) => join(journalDir, op, "project-published.json");
	const applyingMarker = (op: string) => join(journalDir, op, "project-applying.json");

	test("create: a retry after the rename but before the final marker returns replayed and writes the marker", async () => {
		const src = await tree();
		const plan = diffManifests(await buildManifest(src), undefined, "create");
		const op = newOp();
		await reserve(op, { planDigest: plan.digest, projectMode: "create" });
		const staged = await ok({ op: "stage-dir", operationId: op });
		await cp(src, staged.projectStaging as string, { recursive: true });
		const dest = join(home, "recovered", "proj");
		await ok({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan });
		expect(JSON.parse(await readFile(applyingMarker(op), "utf8"))).toMatchObject({ mode: "create", destRoot: dest, planDigest: plan.digest });

		await rm(finalMarker(op));
		const retry = await ok({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan });
		expect(retry).toMatchObject({ mode: "create", destRoot: dest, replayed: true });
		expect(JSON.parse(await readFile(finalMarker(op), "utf8"))).toMatchObject({ mode: "create", destRoot: dest, planDigest: plan.digest });
		expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("new a");
	});

	test("create: without an applying marker, or with a changed destination, the retry is not treated as done", async () => {
		const src = await tree();
		const plan = diffManifests(await buildManifest(src), undefined, "create");
		const op = newOp();
		await reserve(op, { planDigest: plan.digest, projectMode: "create" });
		const staged = await ok({ op: "stage-dir", operationId: op });
		await cp(src, staged.projectStaging as string, { recursive: true });
		const dest = join(home, "recovered", "proj");
		await ok({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan });

		await rm(finalMarker(op));
		await writeFile(join(dest, "extra.txt"), "added later");
		const changed = await call({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan });
		expect(fail(changed).code).toBe("staging-missing");
		await rm(applyingMarker(op));
		await rm(join(dest, "extra.txt"));
		const unmarked = await call({ op: "publish-project", operationId: op, mode: "create", destRoot: dest, plan });
		expect(fail(unmarked).code).toBe("staging-missing");
		await expect(stat(finalMarker(op))).rejects.toThrow();
	});

	test("update: a retry after the apply finished but before the final marker returns replayed", async () => {
		const src = await tree();
		const dest = join(home, "recovered-upd");
		await mkdir(dest, { recursive: true });
		await writeFile(join(dest, "a.txt"), "old a");
		const plan = diffManifests(await buildManifest(src), await buildManifest(dest), "update");
		const op = newOp();
		await reserve(op, { planDigest: plan.digest, projectMode: "update" });
		const staged = await ok({ op: "stage-dir", operationId: op });
		await cp(src, staged.projectStaging as string, { recursive: true });
		await ok({ op: "publish-project", operationId: op, mode: "update", destRoot: dest, plan });

		await rm(finalMarker(op));
		const retry = await ok({ op: "publish-project", operationId: op, mode: "update", destRoot: dest, plan });
		expect(retry).toMatchObject({ mode: "update", replayed: true, undo: { backupDir: staged.undoDir, replaced: 1, created: 2 } });
		expect(JSON.parse(await readFile(finalMarker(op), "utf8"))).toMatchObject({ mode: "update", planDigest: plan.digest });
		expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("new a");
	});

	test("update: the applying marker is written before the apply, so a failed apply leaves it", async () => {
		const src = await tree();
		const dest = join(home, "recovered-upd");
		await mkdir(dest, { recursive: true });
		await writeFile(join(dest, "a.txt"), "old a");
		const plan = diffManifests(await buildManifest(src), await buildManifest(dest), "update");
		await writeFile(join(dest, "a.txt"), "edited since");
		const op = newOp();
		await reserve(op, { planDigest: plan.digest });
		const staged = await ok({ op: "stage-dir", operationId: op });
		await cp(src, staged.projectStaging as string, { recursive: true });
		expect(fail(await call({ op: "publish-project", operationId: op, mode: "update", destRoot: dest, plan })).code).toBe("destination-changed");
		expect(JSON.parse(await readFile(applyingMarker(op), "utf8"))).toMatchObject({ mode: "update", destRoot: dest, planDigest: plan.digest });
		await expect(stat(finalMarker(op))).rejects.toThrow();
		const retry = await call({ op: "publish-project", operationId: op, mode: "update", destRoot: dest, plan });
		expect(fail(retry).code).toBe("destination-changed");
	});

	test("restore-project flags the published marker so launch and republish are refused", async () => {
		const src = await tree();
		const dest = join(home, "restored-upd");
		await mkdir(dest, { recursive: true });
		await writeFile(join(dest, "a.txt"), "old a");
		const plan = diffManifests(await buildManifest(src), await buildManifest(dest), "update");
		const op = newOp();
		const { sessionFile, cwd } = await importedOperation(op, { planDigest: plan.digest, projectMode: "update" });
		await cp(src, join(journalDir, op, "stage", "project"), { recursive: true });
		await ok({ op: "publish-project", operationId: op, mode: "update", destRoot: dest, plan });

		const restored = await ok({ op: "restore-project", operationId: op });
		expect(restored).toMatchObject({ conflicts: [], publishedMarkerFlagged: true });
		expect(JSON.parse(await readFile(finalMarker(op), "utf8"))).toMatchObject({ restored: true });
		expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("old a");

		expect(fail(await call({ op: "launch", operationId: op, sessionFile, cwd, name: "moved", nonce: "pr-1" })).code).toBe("project-restored");
		expect(fail(await call({ op: "publish-project", operationId: op, mode: "update", destRoot: dest, plan })).code).toBe("project-restored");
		expect(spawns).toHaveLength(0);
		expect((await journal().load(op))?.launch).toBeUndefined();
	});

	test("restore-project before any final marker flags nothing", async () => {
		const op = newOp();
		await reserve(op);
		await ok({ op: "stage-dir", operationId: op });
		await mkdir(join(journalDir, op, "undo"), { recursive: true });
		await writeFile(join(journalDir, op, "undo", "undo.json"), JSON.stringify({ version: 1, planDigest: "x", destRoot: home, createdAt: "t", status: "applied", entries: [] }));
		expect(await ok({ op: "restore-project", operationId: op })).toMatchObject({ publishedMarkerFlagged: false });
	});
});

describe("inspect stagingSameFilesystem", () => {
	test("true when the journal directory and the project share a filesystem", async () => {
		const reply = await ok({ op: "inspect", sessionId: SID, projectPath: join(home, "fresh", "proj") });
		expect(reply.stagingSameFilesystem).toBe(true);
		const existing = await ok({ op: "inspect", sessionId: SID, projectPath: home + "/fresh" });
		expect(existing.stagingSameFilesystem).toBe(true);
	});

	test("false when the project lives on another filesystem", async () => {
		const shm = "/dev/shm";
		const shmStat = await stat(shm).catch(() => undefined);
		if (!shmStat || shmStat.dev === (await stat(root)).dev) return;
		const reply = await ok({
			op: "inspect",
			sessionId: SID,
			projectPath: join(shm, `ompc-helper-test-${process.pid}`, "proj"),
			policy: { allowedRoots: [shm], protectedPaths: [] },
		});
		expect(reply.stagingSameFilesystem).toBe(false);
	});
});

describe("inspect session.replayable", () => {
	test("false without an operation id or a local copy, true once that operation imported the same file", async () => {
		const op = newOp();
		const projectPath = join(home, "proj");
		const inspectReq = (extra: Record<string, unknown> = {}) => ({ op: "inspect", sessionId: SID, projectPath, ...extra });
		const located = join(home, "sessions", `2026-01-01_${SID}.jsonl`);
		const withFile = { runOmp: async (args: string[]) => (args[1] === "locate" ? { ok: true, sessionFile: located, sessionDir: join(home, "sessions") } : fakeOmp(args)) };

		expect((await ok(inspectReq())).session).toMatchObject({ existsLocally: false, replayable: false });
		expect((await ok(inspectReq({ operationId: op }), withFile)).session).toMatchObject({ existsLocally: true, replayable: false });
		expect((await ok(inspectReq(), withFile)).session).toMatchObject({ existsLocally: true, replayable: false });

		await importedOperation(op);
		expect((await ok(inspectReq({ operationId: op }), withFile)).session).toMatchObject({ existsLocally: true, replayable: true });
		expect((await ok(inspectReq({ operationId: newOp() }), withFile)).session).toMatchObject({ replayable: false });
		expect(fail(await call(inspectReq({ operationId: "../x" }), withFile)).code).toBe("invalid-request");
	});
});
