import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import type { Subprocess } from "bun";
import {
	defaultJournalDir,
	JournalError,
	OperationJournal,
	TRANSFER_STATES,
	type CreateOperationInit,
	type TransferState,
} from "../../../src/transfer/journal.js";

const JOURNAL_MODULE = resolve(import.meta.dir, "../../../src/transfer/journal.ts");
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
/** The transition table written out independently of the implementation. */
const EXPECTED: Record<TransferState, TransferState[]> = {
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
const NONCE = "nonce-0123456789abcdef";
const hasProc = existsSync("/proc/self/stat");

let dir: string;
let journal: OperationJournal;
type Child = Subprocess<"pipe", "pipe", "inherit">;
const children = new Set<Child>();

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "transfer-journal-"));
	journal = new OperationJournal(join(dir, "journal"));
});

afterEach(async () => {
	for (const child of children) child.kill("SIGKILL");
	children.clear();
	await rm(dir, { recursive: true, force: true });
});

function init(operationId: string, overrides: Partial<CreateOperationInit> = {}): CreateOperationInit {
	return {
		operationId,
		role: "source",
		sessionId: "session-1",
		planDigest: "digest",
		projectMode: "session-only",
		...overrides,
	};
}

async function errorOf(promise: Promise<unknown>): Promise<JournalError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(JournalError);
		return error as JournalError;
	}
	throw new Error("expected rejection");
}

/** Creates `id` and walks it to `state`. */
async function reach(j: OperationJournal, id: string, state: TransferState) {
	await j.create(init(id));
	if (state === "aborting" || state === "rolled-back") {
		await j.transition(id, "aborting");
		if (state === "rolled-back") await j.transition(id, "rolled-back");
		return;
	}
	for (const step of FORWARD.slice(1, FORWARD.indexOf(state) + 1)) await j.transition(id, step);
}

const childScript = `
import { OperationJournal } from ${JSON.stringify(JOURNAL_MODULE)};
import { readFile, writeFile } from "node:fs/promises";
const [mode, dir, id, extra] = process.argv.slice(2);
const journal = new OperationJournal(dir, { lockTimeoutMs: 20000 });
const forever = () => new Promise(() => {});
if (mode === "hold") {
	await journal.withOperationLock(id, async () => { console.log("ready"); await forever(); });
} else if (mode === "hold-worker") {
	await journal.acquireWorkerLock(id);
	console.log("ready");
	await forever();
} else if (mode === "count") {
	const file = dir + "/counter.txt";
	for (let i = 0; i < Number(extra); i++) {
		await journal.withOperationLock(id, async () => {
			const n = Number(await readFile(file, "utf8").catch(() => "0"));
			await new Promise((resolve) => setImmediate(resolve));
			await writeFile(file, String(n + 1));
		});
	}
} else if (mode === "consume") {
	console.log("armed");
	await Bun.stdin.stream().getReader().read();
	console.log(await journal.consumeLaunchIntent(id, extra));
} else if (mode === "transition") {
	console.log("armed");
	await Bun.stdin.stream().getReader().read();
	try {
		await journal.transition(id, "source-stopping");
		console.log("ok");
	} catch (error) {
		console.log(error.code ?? error.message);
	}
}
`;

async function spawnChild(mode: string, journalDir: string, id: string, extra = ""): Promise<Child> {
	const script = join(dir, "child.ts");
	if (!existsSync(script)) await writeFile(script, childScript);
	const child = Bun.spawn([process.execPath, script, mode, journalDir, id, extra], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	children.add(child);
	return child;
}

interface ChildOutput {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	decoder: TextDecoder;
	buffer: string;
}
const childOutputs = new WeakMap<Child, ChildOutput>();

/** One reader per child for its whole life, so output read by `readUntil` is not lost to `output`. */
function outputOf(child: Child): ChildOutput {
	let state = childOutputs.get(child);
	if (!state) {
		state = { reader: child.stdout.getReader(), decoder: new TextDecoder(), buffer: "" };
		childOutputs.set(child, state);
	}
	return state;
}

async function readUntil(child: Child, text: string) {
	const state = outputOf(child);
	while (!state.buffer.includes(text)) {
		const { value, done } = await state.reader.read();
		if (done) throw new Error(`child exited before printing ${text}: ${state.buffer}`);
		state.buffer += state.decoder.decode(value, { stream: true });
	}
	state.buffer = state.buffer.slice(state.buffer.indexOf(text) + text.length);
}

/** Everything the child prints after the last `readUntil` match, once it exits. */
async function output(child: Child): Promise<string> {
	const state = outputOf(child);
	for (;;) {
		const { value, done } = await state.reader.read();
		if (done) break;
		state.buffer += state.decoder.decode(value, { stream: true });
	}
	return state.buffer.trim();
}

async function deadPid(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", ""]);
	await child.exited;
	return child.pid;
}

function lockInfo(pid: number, startTime: number | null = null) {
	return JSON.stringify({ pid, startTime, startedAt: new Date().toISOString(), token: "stale-token" });
}

describe("defaultJournalDir", () => {
	test("uses XDG_STATE_HOME when absolute, else ~/.local/state", () => {
		expect(defaultJournalDir({ XDG_STATE_HOME: "/xdg/state" }, "/home/user")).toBe("/xdg/state/omp-connected/transfers");
		expect(defaultJournalDir({}, "/home/user")).toBe("/home/user/.local/state/omp-connected/transfers");
		expect(defaultJournalDir({ XDG_STATE_HOME: "rel" }, "/home/user")).toBe(
			"/home/user/.local/state/omp-connected/transfers",
		);
	});
});

describe("operation ids", () => {
	const bad = ["", "../escape", "a/b", "a\\b", ".hidden", "-lead", "a.json", "a b", "a\0b", "x".repeat(129), "caf\u00e9"];

	test("every entry point rejects unsafe ids before touching the filesystem", async () => {
		for (const id of bad) {
			const calls = [
				journal.create(init(id)),
				journal.load(id),
				journal.transition(id, "aborting"),
				journal.fail(id, { code: "x", message: "y" }),
				journal.withOperationLock(id, async () => 1),
				journal.acquireWorkerLock(id),
				journal.recordLaunchIntent(id, NONCE),
				journal.cancelLaunchIntent(id),
				journal.consumeLaunchIntent(id, NONCE),
			];
			for (const error of await Promise.all(calls.map(errorOf))) expect(error.code).toBe("invalid-id");
		}
		expect(existsSync(join(dir, "journal"))).toBe(false);
	});

	test("accepts ids at the boundary", async () => {
		await journal.create(init(`a${"b".repeat(127)}`));
		await journal.create(init("0_a-B"));
		expect((await journal.list()).length).toBe(2);
	});
});

describe("create, load, list", () => {
	test("create writes a prepared record with one history entry", async () => {
		const record = await journal.create(
			init("op1", { role: "destination", projectMode: "update", destinationName: "box", sourceProject: "/home/user/p" }),
		);
		expect(record).toMatchObject({
			operationId: "op1",
			role: "destination",
			sessionId: "session-1",
			state: "prepared",
			lastConfirmedState: "prepared",
			planDigest: "digest",
			projectMode: "update",
			destinationName: "box",
			sourceProject: "/home/user/p",
		});
		expect(record.history).toEqual([{ state: "prepared", at: record.createdAt }]);
		expect(record.error).toBeUndefined();
		expect(record.launch).toBeUndefined();
		expect(await journal.load("op1")).toEqual(record);
		expect((await stat(join(dir, "journal", "op1.json"))).mode & 0o777).toBe(0o600);
	});

	test("a duplicate create is refused and leaves the record untouched", async () => {
		const first = await journal.create(init("op1"));
		expect((await errorOf(journal.create(init("op1", { sessionId: "other" })))).code).toBe("exists");
		expect(await journal.load("op1")).toEqual(first);
	});

	test("create validates its input", async () => {
		const bad = [
			init("a", { role: "x" as never }),
			init("b", { projectMode: "x" as never }),
			init("c", { sessionId: "" }),
			init("d", { planDigest: 5 as never }),
			init("e", { sessionName: 5 as never }),
		];
		for (const value of bad) expect((await errorOf(journal.create(value))).code).toBe("invalid-argument");
	});

	test("load returns undefined for an absent operation", async () => {
		expect(await journal.load("missing")).toBeUndefined();
	});

	test("list returns records oldest first and is empty without a directory", async () => {
		expect(await journal.list()).toEqual([]);
		await journal.create(init("b"));
		await journal.create(init("a"));
		const file = join(dir, "journal", "a.json");
		const later = { ...JSON.parse(await readFile(file, "utf8")), createdAt: "2999-01-01T00:00:00.000Z" };
		await writeFile(file, JSON.stringify(later));
		expect((await journal.list()).map((record) => record.operationId)).toEqual(["b", "a"]);
	});

	test("a second journal instance on the same directory sees the same records", async () => {
		await journal.create(init("op1"));
		const other = new OperationJournal(join(dir, "journal"));
		expect((await other.load("op1"))?.operationId).toBe("op1");
	});
});

describe("transition table", () => {
	test("TRANSFER_STATES lists every state once", () => {
		expect([...TRANSFER_STATES].sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	for (const from of Object.keys(EXPECTED) as TransferState[]) {
		for (const to of TRANSFER_STATES) {
			const allowed = EXPECTED[from].includes(to);
			test(`${from} -> ${to} is ${allowed ? "allowed" : "rejected"}`, async () => {
				const id = `t-${from}-${to}`;
				await reach(journal, id, from);
				const before = await journal.load(id);
				if (allowed) {
					const after = await journal.transition(id, to, "why");
					expect(after.state).toBe(to);
					expect(after.history.at(-1)).toMatchObject({ state: to, detail: "why" });
					expect(after.history.length).toBe(before!.history.length + 1);
					expect(await journal.load(id)).toEqual(after);
				} else {
					const error = await errorOf(journal.transition(id, to));
					expect(error.code).toBe("illegal-transition");
					expect(await journal.load(id)).toEqual(before);
				}
			});
		}
	}

	test("the full forward sequence completes and records history in order", async () => {
		await reach(journal, "op1", "completed");
		const record = (await journal.load("op1"))!;
		expect(record.history.map((entry) => entry.state)).toEqual(FORWARD);
		expect(record.state).toBe("completed");
		expect(record.lastConfirmedState).toBe("completed");
	});

	test("aborting is reachable from every non-terminal state except completed", async () => {
		for (const state of FORWARD.slice(0, -1)) {
			await reach(journal, `abort-${state}`, state);
			const record = await journal.transition(`abort-${state}`, "aborting");
			expect(record.state).toBe("aborting");
			expect(record.lastConfirmedState).toBe(state);
			expect((await journal.transition(`abort-${state}`, "rolled-back")).state).toBe("rolled-back");
		}
		await reach(journal, "abort-completed", "completed");
		expect((await errorOf(journal.transition("abort-completed", "aborting"))).code).toBe("illegal-transition");
	});

	test("rolled-back is only reachable from aborting", async () => {
		for (const state of FORWARD) {
			await reach(journal, `rb-${state}`, state);
			expect((await errorOf(journal.transition(`rb-${state}`, "rolled-back"))).code).toBe("illegal-transition");
		}
	});

	test("terminal states reject every further transition", async () => {
		await reach(journal, "done", "completed");
		await reach(journal, "gone", "rolled-back");
		for (const id of ["done", "gone"]) {
			for (const to of TRANSFER_STATES) {
				expect((await errorOf(journal.transition(id, to))).code).toBe("illegal-transition");
			}
		}
	});

	test("unknown target states and unknown operations are refused", async () => {
		await journal.create(init("op1"));
		expect((await errorOf(journal.transition("op1", "nope" as never))).code).toBe("invalid-argument");
		expect((await errorOf(journal.transition("absent", "source-stopping"))).code).toBe("not-found");
	});
});

describe("fail", () => {
	test("records the error and keeps state and lastConfirmedState", async () => {
		await reach(journal, "op1", "staged");
		const record = await journal.fail("op1", { code: "ssh", message: "connection lost" });
		expect(record.state).toBe("staged");
		expect(record.lastConfirmedState).toBe("staged");
		expect(record.error).toMatchObject({ code: "ssh", message: "connection lost" });
		expect(Date.parse(record.error!.at)).not.toBeNaN();
		expect(await journal.load("op1")).toEqual(record);
	});

	test("a failure does not block the next transition, which clears the error", async () => {
		await reach(journal, "op1", "staged");
		await journal.fail("op1", { code: "ssh", message: "x" });
		const record = await journal.transition("op1", "publishing");
		expect(record.error).toBeUndefined();
		expect(record.lastConfirmedState).toBe("publishing");
	});

	test("a failure after abort keeps the pre-abort confirmed state", async () => {
		await reach(journal, "op1", "publishing");
		await journal.transition("op1", "aborting");
		const record = await journal.fail("op1", { code: "x", message: "y" });
		expect(record.state).toBe("aborting");
		expect(record.lastConfirmedState).toBe("publishing");
	});

	test("fail on a terminal record still records the error", async () => {
		await reach(journal, "op1", "completed");
		expect((await journal.fail("op1", { code: "x", message: "y" })).state).toBe("completed");
	});

	test("unknown operation and malformed errors are refused", async () => {
		expect((await errorOf(journal.fail("absent", { code: "x", message: "y" }))).code).toBe("not-found");
		await journal.create(init("op1"));
		expect((await errorOf(journal.fail("op1", { code: 1, message: "y" } as never))).code).toBe("invalid-argument");
	});
});

describe("corrupt and partial files", () => {
	const dirOf = () => join(dir, "journal");

	test("a corrupt record makes load throw a typed error", async () => {
		await journal.create(init("op1"));
		await writeFile(join(dirOf(), "op1.json"), "{ not json");
		const error = await errorOf(journal.load("op1"));
		expect(error.code).toBe("corrupt");
		expect((await errorOf(journal.transition("op1", "source-stopping"))).code).toBe("corrupt");
	});

	test("an empty record, wrong shape and mismatched id are corrupt", async () => {
		await journal.create(init("op1"));
		const valid = JSON.parse(await readFile(join(dirOf(), "op1.json"), "utf8"));
		const variants: unknown[] = [
			"",
			"[]",
			"null",
			{ ...valid, state: "bogus" },
			{ ...valid, history: [{ state: "bogus", at: "x" }] },
			{ ...valid, operationId: "other" },
			{ ...valid, launch: { nonce: "n", status: "weird", recordedAt: "x" } },
			{ ...valid, error: { code: 1 } },
		];
		for (const variant of variants) {
			await writeFile(join(dirOf(), "op1.json"), typeof variant === "string" ? variant : JSON.stringify(variant));
			expect((await errorOf(journal.load("op1"))).code).toBe("corrupt");
		}
	});

	test("list skips corrupt records and listCorrupt reports them", async () => {
		await journal.create(init("good"));
		await journal.create(init("bad"));
		await writeFile(join(dirOf(), "bad.json"), "garbage");
		expect((await journal.list()).map((record) => record.operationId)).toEqual(["good"]);
		expect((await journal.listCorrupt()).map((entry) => entry.operationId)).toEqual(["bad"]);
	});

	test("a temp file left by a crash before rename is ignored", async () => {
		const record = await journal.create(init("op1"));
		await writeFile(join(dirOf(), `op1.json.${process.pid}.crash.tmp`), "{ half written");
		await writeFile(join(dirOf(), `newer.json.${process.pid}.crash.tmp`), JSON.stringify({ ...record, operationId: "newer" }));
		expect(await journal.load("op1")).toEqual(record);
		expect((await journal.list()).map((entry) => entry.operationId)).toEqual(["op1"]);
		expect(await journal.load("newer")).toBeUndefined();
		expect((await journal.transition("op1", "source-stopping")).state).toBe("source-stopping");
		expect(await journal.listCorrupt()).toEqual([]);
	});

	test("writes leave no temp or lock files behind", async () => {
		await reach(journal, "op1", "completed");
		await journal.recordLaunchIntent("op1", NONCE);
		expect(await readdir(dirOf())).toEqual(["op1.json"]);
	});
});

describe("in-process locking", () => {
	test("withOperationLock serialises callers on one operation", async () => {
		const other = new OperationJournal(join(dir, "journal"));
		let active = 0;
		let overlap = false;
		const order: number[] = [];
		const run = (j: OperationJournal, n: number) =>
			j.withOperationLock("op1", async () => {
				active++;
				overlap ||= active > 1;
				await tick();
				order.push(n);
				active--;
				return n;
			});
		const results = await Promise.all([run(journal, 1), run(other, 2), run(journal, 3), run(other, 4)]);
		expect(overlap).toBe(false);
		expect(results).toEqual([1, 2, 3, 4]);
		expect(order).toEqual([1, 2, 3, 4]);
	});

	test("different operations do not block each other", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const held = journal.withOperationLock("op1", () => gate);
		await journal.withOperationLock("op2", async () => {});
		release();
		await held;
	});

	test("nested calls on the same operation run inline instead of deadlocking", async () => {
		await journal.create(init("op1"));
		const result = await journal.withOperationLock("op1", async () => {
			await journal.transition("op1", "source-stopping");
			return journal.withOperationLock("op1", async () => (await journal.load("op1"))!.state);
		});
		expect(result).toBe("source-stopping");
	});

	test("the lock is released when fn throws", async () => {
		await expect(
			journal.withOperationLock("op1", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await journal.withOperationLock("op1", async () => "again")).toBe("again");
	});

	test("concurrent transitions on one journal: one wins, the rest are illegal", async () => {
		await journal.create(init("op1"));
		const results = await Promise.allSettled(
			Array.from({ length: 6 }, () => journal.transition("op1", "source-stopping")),
		);
		expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
		for (const result of results) {
			if (result.status === "rejected") expect(result.reason.code).toBe("illegal-transition");
		}
		expect((await journal.load("op1"))!.history.map((entry) => entry.state)).toEqual(["prepared", "source-stopping"]);
	});
});

describe("stale lock takeover", () => {
	const lockPath = () => join(dir, "journal", "op1.lock");

	async function plant(content: string) {
		await journal.create(init("op1"));
		await writeFile(lockPath(), content);
	}

	test("a lock whose pid is dead is taken over", async () => {
		await plant(lockInfo(await deadPid()));
		expect((await journal.transition("op1", "source-stopping")).state).toBe("source-stopping");
		expect(existsSync(lockPath())).toBe(false);
	});

	test.skipIf(!hasProc)("a live pid with a different start time (pid reuse) is taken over", async () => {
		await plant(lockInfo(process.pid, 1));
		expect((await journal.transition("op1", "source-stopping")).state).toBe("source-stopping");
	});

	test("a lock held by a live process is respected until the timeout", async () => {
		const impatient = new OperationJournal(join(dir, "journal"), { lockTimeoutMs: 80 });
		await plant(lockInfo(process.pid));
		const error = await errorOf(impatient.transition("op1", "source-stopping"));
		expect(error.code).toBe("lock-timeout");
		expect((await journal.load("op1"))!.state).toBe("prepared");
		expect(existsSync(lockPath())).toBe(true);
	});

	test("an unparseable fresh lock is respected; an old one is taken over", async () => {
		const impatient = new OperationJournal(join(dir, "journal"), { lockTimeoutMs: 80 });
		await plant("");
		expect((await errorOf(impatient.transition("op1", "source-stopping"))).code).toBe("lock-timeout");
		const old = new Date(Date.now() - 60_000);
		await utimes(lockPath(), old, old);
		expect((await impatient.transition("op1", "source-stopping")).state).toBe("source-stopping");
	});

	test("simultaneous takeovers of one stale lock from several processes never overlap", async () => {
		await plant(lockInfo(await deadPid()));
		const journalDir = join(dir, "journal");
		const iterations = 5;
		const processes = await Promise.all(
			Array.from({ length: 3 }, () => spawnChild("count", journalDir, "op1", String(iterations))),
		);
		await Promise.all(processes.map((child) => child.exited));
		for (const child of processes) expect(child.exitCode).toBe(0);
		expect(await readFile(join(journalDir, "counter.txt"), "utf8")).toBe(String(iterations * 3));
		expect(existsSync(lockPath())).toBe(false);
	});

	test("a stale takeover guard from a dead process is cleared", async () => {
		await plant(lockInfo(await deadPid()));
		await writeFile(`${lockPath()}.takeover`, lockInfo(await deadPid()));
		expect((await journal.transition("op1", "source-stopping")).state).toBe("source-stopping");
		expect(existsSync(`${lockPath()}.takeover`)).toBe(false);
	});
});

describe("cross-process locking", () => {
	test("a lock held by another process blocks this one, and its death releases it", async () => {
		const journalDir = join(dir, "journal");
		await journal.create(init("op1"));
		const holder = await spawnChild("hold", journalDir, "op1");
		await readUntil(holder, "ready");

		const info = JSON.parse(await readFile(join(journalDir, "op1.lock"), "utf8"));
		expect(info.pid).toBe(holder.pid);
		expect(typeof info.startedAt).toBe("string");
		if (hasProc) expect(typeof info.startTime).toBe("number");

		const impatient = new OperationJournal(journalDir, { lockTimeoutMs: 150 });
		expect((await errorOf(impatient.transition("op1", "source-stopping"))).code).toBe("lock-timeout");

		holder.kill("SIGKILL");
		await holder.exited;
		const patient = new OperationJournal(journalDir, { lockTimeoutMs: 10_000 });
		expect((await patient.transition("op1", "source-stopping")).state).toBe("source-stopping");
	});

	test("a lock released by a clean exit is free again", async () => {
		const journalDir = join(dir, "journal");
		await journal.create(init("op1"));
		const counter = await spawnChild("count", journalDir, "op1", "1");
		await counter.exited;
		expect(await journal.withOperationLock("op1", async () => "ok")).toBe("ok");
		expect(existsSync(join(journalDir, "op1.lock"))).toBe(false);
	});

	test("read-modify-write sections from three processes never interleave", async () => {
		const journalDir = join(dir, "journal");
		await journal.create(init("op1"));
		const iterations = 15;
		const processes = await Promise.all([
			spawnChild("count", journalDir, "op1", String(iterations)),
			spawnChild("count", journalDir, "op1", String(iterations)),
			spawnChild("count", journalDir, "op1", String(iterations)),
		]);
		const own = (async () => {
			for (let i = 0; i < iterations; i++) {
				await journal.withOperationLock("op1", async () => {
					const file = join(journalDir, "counter.txt");
					const n = Number(await readFile(file, "utf8").catch(() => "0"));
					await tick();
					await writeFile(file, String(n + 1));
				});
			}
		})();
		await Promise.all([own, ...processes.map((child) => child.exited)]);
		for (const child of processes) expect(child.exitCode).toBe(0);
		expect(await readFile(join(journalDir, "counter.txt"), "utf8")).toBe(String(iterations * 4));
	});

	test("concurrent transition calls from two processes: exactly one succeeds", async () => {
		const journalDir = join(dir, "journal");
		await journal.create(init("op1"));
		const first = await spawnChild("transition", journalDir, "op1");
		const second = await spawnChild("transition", journalDir, "op1");
		await Promise.all([readUntil(first, "armed"), readUntil(second, "armed")]);
		first.stdin.write("go\n");
		second.stdin.write("go\n");
		first.stdin.end();
		second.stdin.end();
		const results = (await Promise.all([output(first), output(second)])).sort();
		expect(results).toEqual(["illegal-transition", "ok"]);
		const record = (await journal.load("op1"))!;
		expect(record.state).toBe("source-stopping");
		expect(record.history.map((entry) => entry.state)).toEqual(["prepared", "source-stopping"]);
	});
});

describe("worker lock", () => {
	test("a second acquire is refused until the first releases", async () => {
		const first = await journal.acquireWorkerLock("op1");
		expect((await errorOf(journal.acquireWorkerLock("op1"))).code).toBe("worker-active");
		await first.release();
		const second = await journal.acquireWorkerLock("op1");
		await second.release();
	});

	test("release is idempotent and cannot free a successor's lock", async () => {
		const first = await journal.acquireWorkerLock("op1");
		await first.release();
		const second = await journal.acquireWorkerLock("op1");
		await first.release();
		expect((await errorOf(journal.acquireWorkerLock("op1"))).code).toBe("worker-active");
		await second.release();
	});

	test("locks are per operation and independent of the operation lock", async () => {
		const a = await journal.acquireWorkerLock("op1");
		const b = await journal.acquireWorkerLock("op2");
		await journal.withOperationLock("op1", async () => {});
		await a.release();
		await b.release();
	});

	test("a dead worker is replaced", async () => {
		await journal.create(init("op1"));
		await writeFile(join(dir, "journal", "op1.worker.lock"), lockInfo(await deadPid()));
		const lock = await journal.acquireWorkerLock("op1");
		await lock.release();
		expect(existsSync(join(dir, "journal", "op1.worker.lock"))).toBe(false);
	});

	test("a worker in another process excludes this one, and its death frees the lock", async () => {
		const journalDir = join(dir, "journal");
		const worker = await spawnChild("hold-worker", journalDir, "op1");
		await readUntil(worker, "ready");
		expect((await errorOf(journal.acquireWorkerLock("op1"))).code).toBe("worker-active");
		worker.kill("SIGKILL");
		await worker.exited;
		await (await journal.acquireWorkerLock("op1")).release();
	});
});

describe("launch intent", () => {
	beforeEach(async () => {
		await journal.create(init("op1", { role: "destination" }));
	});

	test("recordLaunchIntent stores a recorded intent", async () => {
		await journal.recordLaunchIntent("op1", NONCE);
		const launch = (await journal.load("op1"))!.launch!;
		expect(launch).toMatchObject({ nonce: NONCE, status: "recorded" });
		expect(Date.parse(launch.recordedAt)).not.toBeNaN();
		expect(launch.settledAt).toBeUndefined();
	});

	test("recording the same nonce again is a no-op; a different nonce is refused", async () => {
		await journal.recordLaunchIntent("op1", NONCE);
		const before = await journal.load("op1");
		await journal.recordLaunchIntent("op1", NONCE);
		expect(await journal.load("op1")).toEqual(before);
		expect((await errorOf(journal.recordLaunchIntent("op1", "another-nonce"))).code).toBe("launch-intent-exists");
	});

	test("recording requires an existing operation and a well-formed nonce", async () => {
		expect((await errorOf(journal.recordLaunchIntent("absent", NONCE))).code).toBe("not-found");
		for (const nonce of ["", "a b", "a/b", "x".repeat(129), "n\0"]) {
			expect((await errorOf(journal.recordLaunchIntent("op1", nonce))).code).toBe("invalid-argument");
			expect((await errorOf(journal.consumeLaunchIntent("op1", nonce))).code).toBe("invalid-argument");
		}
	});

	test("consume returns true exactly once for the matching nonce", async () => {
		await journal.recordLaunchIntent("op1", NONCE);
		expect(await journal.consumeLaunchIntent("op1", NONCE)).toBe(true);
		expect(await journal.consumeLaunchIntent("op1", NONCE)).toBe(false);
		const launch = (await journal.load("op1"))!.launch!;
		expect(launch.status).toBe("consumed");
		expect(Date.parse(launch.settledAt!)).not.toBeNaN();
	});

	test("a wrong nonce is refused and leaves the intent consumable", async () => {
		await journal.recordLaunchIntent("op1", NONCE);
		expect(await journal.consumeLaunchIntent("op1", "wrong-nonce")).toBe(false);
		expect((await journal.load("op1"))!.launch!.status).toBe("recorded");
		expect(await journal.consumeLaunchIntent("op1", NONCE)).toBe(true);
	});

	test("consume is false without an intent or without the operation", async () => {
		expect(await journal.consumeLaunchIntent("op1", NONCE)).toBe(false);
		expect(await journal.consumeLaunchIntent("absent", NONCE)).toBe(false);
	});

	test("cancel returns none when absent, cancelled when recorded, already-consumed when consumed", async () => {
		expect(await journal.cancelLaunchIntent("op1")).toBe("none");
		expect(await journal.cancelLaunchIntent("absent")).toBe("none");

		await journal.recordLaunchIntent("op1", NONCE);
		expect(await journal.cancelLaunchIntent("op1")).toBe("cancelled");
		const launch = (await journal.load("op1"))!.launch!;
		expect(launch.status).toBe("cancelled");
		expect(Date.parse(launch.settledAt!)).not.toBeNaN();

		await journal.create(init("op2"));
		await journal.recordLaunchIntent("op2", NONCE);
		await journal.consumeLaunchIntent("op2", NONCE);
		expect(await journal.cancelLaunchIntent("op2")).toBe("already-consumed");
		expect((await journal.load("op2"))!.launch!.status).toBe("consumed");
	});

	test("a cancelled intent can never be consumed or re-recorded", async () => {
		await journal.recordLaunchIntent("op1", NONCE);
		await journal.cancelLaunchIntent("op1");
		expect(await journal.consumeLaunchIntent("op1", NONCE)).toBe(false);
		expect((await errorOf(journal.recordLaunchIntent("op1", NONCE))).code).toBe("launch-intent-settled");
		expect((await errorOf(journal.recordLaunchIntent("op1", "fresh-nonce"))).code).toBe("launch-intent-settled");
		expect(await journal.cancelLaunchIntent("op1")).toBe("cancelled");
		expect(await journal.consumeLaunchIntent("op1", NONCE)).toBe(false);
		expect((await journal.load("op1"))!.launch!.status).toBe("cancelled");
	});

	test("a consumed intent cannot be re-recorded", async () => {
		await journal.recordLaunchIntent("op1", NONCE);
		await journal.consumeLaunchIntent("op1", NONCE);
		expect((await errorOf(journal.recordLaunchIntent("op1", NONCE))).code).toBe("launch-intent-settled");
	});

	test("launch intent changes do not touch state, history or error", async () => {
		await journal.fail("op1", { code: "x", message: "y" });
		const before = (await journal.load("op1"))!;
		await journal.recordLaunchIntent("op1", NONCE);
		await journal.cancelLaunchIntent("op1");
		const after = (await journal.load("op1"))!;
		expect(after.state).toBe(before.state);
		expect(after.history).toEqual(before.history);
		expect(after.error).toEqual(before.error);
	});

	test("cancel and consume racing each other: exactly one side wins, across journal instances", async () => {
		const other = new OperationJournal(join(dir, "journal"));
		for (let round = 0; round < 15; round++) {
			const id = `race-${round}`;
			await journal.create(init(id));
			await journal.recordLaunchIntent(id, NONCE);
			const [cancel, consumed] =
				round % 2 === 0
					? await Promise.all([journal.cancelLaunchIntent(id), other.consumeLaunchIntent(id, NONCE)])
					: (await Promise.all([other.consumeLaunchIntent(id, NONCE), journal.cancelLaunchIntent(id)])).reverse();
			const status = (await journal.load(id))!.launch!.status;
			if (consumed) {
				expect(cancel).toBe("already-consumed");
				expect(status).toBe("consumed");
			} else {
				expect(cancel).toBe("cancelled");
				expect(status).toBe("cancelled");
			}
			expect(await other.consumeLaunchIntent(id, NONCE)).toBe(false);
		}
	});

	test("cancel in this process racing a consume in another: exactly one side wins", async () => {
		const journalDir = join(dir, "journal");
		for (let round = 0; round < 3; round++) {
			const id = `xrace-${round}`;
			await journal.create(init(id));
			await journal.recordLaunchIntent(id, NONCE);
			const child = await spawnChild("consume", journalDir, id, NONCE);
			await readUntil(child, "armed");
			child.stdin.write("go\n");
			child.stdin.end();
			const cancel = await journal.cancelLaunchIntent(id);
			const consumed = (await output(child)) === "true";
			const status = (await journal.load(id))!.launch!.status;
			expect(cancel).toBe(consumed ? "already-consumed" : "cancelled");
			expect(status).toBe(consumed ? "consumed" : "cancelled");
		}
	});

	test("many concurrent consumers: exactly one gets true", async () => {
		await journal.recordLaunchIntent("op1", NONCE);
		const others = Array.from({ length: 4 }, () => new OperationJournal(join(dir, "journal")));
		const results = await Promise.all([
			...others.map((j) => j.consumeLaunchIntent("op1", NONCE)),
			journal.consumeLaunchIntent("op1", NONCE),
		]);
		expect(results.filter(Boolean).length).toBe(1);
	});
});
