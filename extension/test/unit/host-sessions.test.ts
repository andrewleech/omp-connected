import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HostSessions, type HistorySession } from "../../src/host-sessions.js";

let root: string;
let cwd: string;
let history: HistorySession[];
let open = [{ instanceId: "instance", pid: 1, sessionId: "active", access: "control" }];
const prior = new Map<string, string | undefined>();
const sockets = new Set<string>();
let service: HostSessions;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hs-"));
	cwd = join(root, "project");
	await mkdir(cwd);
	history = [
		{
			id: "old",
			path: join(root, "older session.jsonl"),
			cwd,
			title: "Older",
			firstMessage: "",
			modified: new Date(1),
		},
		{
			id: "active",
			path: "/active",
			cwd,
			title: "Active",
			firstMessage: "",
			modified: new Date(3),
		},
		{
			id: "recent",
			path: join(root, "recent.jsonl"),
			cwd,
			title: "Recent",
			firstMessage: "",
			modified: new Date(2),
		},
	];
	open = [{ instanceId: "instance", pid: 1, sessionId: "active", access: "control" }];
	const fakeOmp = join(root, "omp");
	await writeFile(
		fakeOmp,
		`#!/usr/bin/env bun\nawait Bun.write(process.cwd()+"/started.json", JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), parent:process.env.OMPC_SESSION}));\nsetInterval(()=>{},1000);\n`,
	);
	await chmod(fakeOmp, 0o755);
	for (const [key, value] of Object.entries({
		OMP_BIN: fakeOmp,
		OMP_HOST_ENV: join(root, "no-env"),
		TMUX_TMPDIR: root,
	})) {
		prior.set(key, process.env[key]);
		process.env[key] = value;
	}
	service = new HostSessions({
		listHistory: async () => [...history],
		listOpen: async () => open,
		newSessionDir: async () => join(root, "history"),
		currentSessionId: () => "active",
		isSessionOpen: async (id) => id === "unshared",
		acquireLaunchLock: async () => () => {},
		stateDir: join(root, "names"),
		launcher: resolve(import.meta.dir, "../../bin/ompc"),
	});
});

afterEach(async () => {
	for (const socket of sockets) {
		try {
			execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
		} catch {}
	}
	sockets.clear();
	for (const [key, value] of prior) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	prior.clear();
	await rm(root, { recursive: true, force: true });
});

async function started() {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			return JSON.parse(await readFile(join(cwd, "started.json"), "utf8"));
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error("OMP did not start inside the tmux pane");
}

describe("host session management", () => {
	test("lists newest first, excludes open UUIDs and remembers ompc suffix separately from title", async () => {
		await service.remember("recent", cwd, "project.review");
		history.push({ ...history[0]!, id: "unshared", modified: new Date(4) });
		const result = await service.list();
		expect(result.sessions.map((session) => session.sessionId)).toEqual(["recent", "old"]);
		expect(result.sessions[0]).toMatchObject({
			title: "Recent",
			cwd,
			name: "review",
		});
		expect(result.sessions[1]?.name).toBeUndefined();
	});

	test("refuses history and launch on a view-only host", async () => {
		open[0]!.access = "view";
		await expect(service.list()).rejects.toMatchObject({ code: -32003 });
		await expect(service.start({ cwd, name: "denied" })).rejects.toMatchObject({
			code: -32003,
		});
	});

	test("rechecks a selected UUID and validates the combined tmux name", async () => {
		await expect(service.start({ cwd, name: "active", sessionId: "active" })).rejects.toMatchObject({ code: -32002 });
		await expect(service.start({ cwd, name: "unshared", sessionId: "unshared" })).rejects.toMatchObject({
			code: -32002,
		});
		await expect(service.start({ cwd, name: "missing", sessionId: "unknown" })).rejects.toMatchObject({ code: -32001 });
		await expect(service.start({ cwd, name: "x".repeat(64) })).rejects.toMatchObject({ code: -32004 });
		await expect(service.start({ cwd, name: "x;touch marker" })).rejects.toMatchObject({ code: -32004 });
		await expect(service.start({ cwd: join(root, "missing"), name: "" })).rejects.toMatchObject({ code: -32004 });
	});

	test("starts a fresh detached pane with explicit session storage and rejects a live name collision", async () => {
		sockets.add("project.fresh");
		await expect(service.start({ cwd, name: "fresh" })).resolves.toEqual({
			ok: true,
			label: "project.fresh",
		});
		const run = await started();
		expect(run).toEqual({
			args: ["--session-dir", join(root, "history")],
			cwd,
			parent: "project.fresh",
		});
		await expect(service.start({ cwd, name: "fresh" })).rejects.toMatchObject({
			code: -32002,
		});
		await expect(service.start({ cwd, name: "fresh", sessionId: "old" })).rejects.toMatchObject({ code: -32002 });
		expect((await service.list()).sessions.map((session) => session.sessionId)).toEqual(["recent", "old"]);
		expect(
			execFileSync("tmux", ["-L", "project.fresh", "list-panes", "-F", "#{pane_dead}"], { encoding: "utf8" }).trim(),
		).toBe("0");
	});

	test("resumes the authoritative session file with spaces and refuses another launch while it starts", async () => {
		sockets.add("project..resume");
		await service.start({ cwd, name: ".resume", sessionId: "old" });
		expect((await started()).args).toEqual(["--resume", history[0]!.path]);
		await expect(service.start({ cwd, name: "other", sessionId: "old" })).rejects.toMatchObject({ code: -32002 });
		expect((await service.list()).sessions.map((session) => session.sessionId)).toEqual(["recent"]);
	});
});
