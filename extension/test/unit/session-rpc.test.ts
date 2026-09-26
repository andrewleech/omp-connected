import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { FileService } from "../../src/files-rpc.js";
import { RpcCode } from "../../src/protocol.js";
import {
	type AccessSource,
	type CollabAccess,
	createAccessCache,
	createSessionRpc,
	type SessionRpcDeps,
	thinkingLevelsFor,
} from "../../src/session-rpc.js";

type Model = NonNullable<ExtensionContext["model"]>;

const sonnet = {
	provider: "anthropic",
	id: "claude-sonnet",
	name: "Claude Sonnet",
	reasoning: true,
	thinking: { efforts: ["low", "medium", "high"] },
} as unknown as Model;
const plain = { provider: "openai", id: "gpt-plain", name: "GPT Plain", reasoning: false } as unknown as Model;

let root: string;
let files: FileService;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-rpc-"));
	files = await FileService.open(root);
});

afterEach(async () => {
	await files.dispose();
	await fs.rm(root, { recursive: true, force: true });
});

function harness(options: { access?: CollabAccess | AccessSource; idle?: boolean; setModelResult?: boolean } = {}) {
	const level = typeof options.access === "string" ? options.access : "control";
	const access: AccessSource =
		typeof options.access === "object" ? options.access : { current: async () => level, refresh: async () => level };
	const calls = { abort: 0, compact: [] as (string | undefined)[], setModel: [] as Model[], thinking: [] as string[] };
	const warnings: string[] = [];
	let onWarn: () => void = () => undefined;
	const compaction = Promise.withResolvers<void>();
	const state = { model: sonnet as Model | undefined, idle: options.idle ?? true };
	const ctx = {
		get model() {
			return state.model;
		},
		models: { list: () => [sonnet, plain] },
		isIdle: () => state.idle,
		abort: () => {
			calls.abort += 1;
		},
		compact: (instructions?: string) => {
			calls.compact.push(instructions);
			return compaction.promise;
		},
		getContextUsage: () => ({ tokens: 1200, contextWindow: 200_000, percent: Number.NaN }),
	} as unknown as ExtensionContext;
	const pi = {
		getThinkingLevel: () => "medium",
		setThinkingLevel: (level: string) => calls.thinking.push(level),
		setModel: async (model: Model) => {
			calls.setModel.push(model);
			return options.setModelResult ?? true;
		},
		getSessionName: () => undefined,
		logger: {
			warn: (message: string) => {
				warnings.push(message);
				onWarn();
			},
		},
	} as unknown as SessionRpcDeps["pi"];
	const handle = createSessionRpc({
		pi,
		context: () => ctx,
		access,
		files,
	});
	return {
		handle,
		calls,
		warnings,
		state,
		compaction,
		/** Resolves on the next logged warning. */
		nextWarning: () => new Promise<void>((resolve) => {
			onWarn = resolve;
		}),
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

test("thinking levels are 'off' plus the model's efforts, and empty without controllable thinking", () => {
	expect(thinkingLevelsFor(sonnet)).toEqual(["off", "low", "medium", "high"]);
	expect(thinkingLevelsFor(plain)).toEqual([]);
	expect(thinkingLevelsFor({ ...sonnet, thinking: undefined } as unknown as Model)).toEqual([]);
	expect(thinkingLevelsFor(undefined)).toEqual([]);
});

test("session.info reports the session, its model choices and usage, with non-finite numbers as null", async () => {
	const { handle } = harness({ access: "view" });
	expect(await handle("session.info", {})).toEqual({
		cwd: files.root,
		pid: process.pid,
		sessionName: null,
		access: "view",
		idle: true,
		model: { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
		thinkingLevel: "medium",
		thinkingLevels: ["off", "low", "medium", "high"],
		contextUsage: { tokens: 1200, contextWindow: 200_000, percent: null },
		models: [
			{ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
			{ provider: "openai", id: "gpt-plain", name: "GPT Plain" },
		],
	});
});

test("a view-only session answers session.info but refuses every other method as forbidden", async () => {
	const { handle, calls } = harness({ access: "view" });
	const gated: [string, unknown][] = [
		["session.abort", {}],
		["session.compact", {}],
		["session.set_model", { provider: "openai", id: "gpt-plain" }],
		["session.set_thinking", { level: "low" }],
		["files.list", { path: "" }],
		["files.stat", { path: "" }],
		["files.read", { path: "x", offset: 0, length: 1 }],
		["files.write", { path: "x", uploadId: "upload-01", offset: 0, data: "", final: true, overwrite: false }],
		["files.write_abort", { path: "x", uploadId: "upload-01" }],
		["files.mkdir", { path: "d" }],
	];
	for (const [method, params] of gated) {
		expect({ method, code: await rpcCode(handle(method, params)) }).toEqual({ method, code: RpcCode.Forbidden });
	}
	expect(calls.abort).toBe(0);
	expect(await fs.readdir(root)).toEqual([]);
});

test("an unknown method is -32601 regardless of access", async () => {
	expect(await rpcCode(harness({ access: "view" }).handle("session.reboot", {}))).toBe(RpcCode.MethodNotFound);
	expect(await rpcCode(harness().handle("toString", {}))).toBe(RpcCode.MethodNotFound);
});

test("files methods reach the session root when control is shared", async () => {
	const { handle } = harness();
	expect(await handle("files.mkdir", { path: "made" })).toEqual({ ok: true });
	expect(await handle("files.list", { path: "" })).toMatchObject({ path: "", entries: [{ name: "made", type: "dir" }] });
});

test("set_thinking accepts only the current model's levels", async () => {
	const { handle, calls, state } = harness();
	expect(await handle("session.set_thinking", { level: "high" })).toEqual({ ok: true });
	expect(await rpcCode(handle("session.set_thinking", { level: "xhigh" }))).toBe(RpcCode.Invalid);
	expect(await rpcCode(handle("session.set_thinking", {}))).toBe(RpcCode.Invalid);
	state.model = plain;
	expect(await rpcCode(handle("session.set_thinking", { level: "off" }))).toBe(RpcCode.Invalid);
	expect(calls.thinking).toEqual(["high"]);
});

test("set_model resolves provider and id from the available models", async () => {
	const { handle, calls } = harness();
	expect(await handle("session.set_model", { provider: "openai", id: "gpt-plain" })).toEqual({ ok: true });
	expect(calls.setModel).toEqual([plain]);
	expect(await rpcCode(handle("session.set_model", { provider: "anthropic", id: "gpt-plain" }))).toBe(
		RpcCode.NotFound,
	);
	expect(await rpcCode(handle("session.set_model", { provider: "openai" }))).toBe(RpcCode.Invalid);
});

test("set_model is invalid when omp has no API key for the model", async () => {
	const { handle } = harness({ setModelResult: false });
	expect(await rpcCode(handle("session.set_model", { provider: "openai", id: "gpt-plain" }))).toBe(RpcCode.Invalid);
});

test("compact is busy while the session is working", async () => {
	const { handle, calls } = harness({ idle: false });
	expect(await rpcCode(handle("session.compact", { instructions: "keep it short" }))).toBe(RpcCode.Busy);
	expect(calls.compact).toEqual([]);
});

test("compact starts compaction and replies before it finishes; a failure is logged", async () => {
	const { handle, calls, warnings, compaction, nextWarning } = harness();
	expect(await handle("session.compact", { instructions: "focus on the API" })).toEqual({ ok: true });
	expect(calls.compact).toEqual(["focus on the API"]);
	expect(warnings).toEqual([]);

	const warned = nextWarning();
	compaction.reject(new Error("provider down"));
	await warned;
	expect(warnings).toHaveLength(1);
	expect(await rpcCode(handle("session.compact", { instructions: 5 }))).toBe(RpcCode.Invalid);
});

test("compact is busy while a compaction it started is still running", async () => {
	const { handle, calls, compaction } = harness();
	expect(await handle("session.compact", {})).toEqual({ ok: true });
	expect(await rpcCode(handle("session.compact", {}))).toBe(RpcCode.Busy);
	expect(calls.compact).toEqual([undefined]);

	compaction.resolve();
	// The handler clears its flag a few microtasks after the compaction settles.
	let code = await rpcCode(handle("session.compact", {}));
	for (let turn = 0; turn < 20 && code === RpcCode.Busy; turn += 1) {
		code = await rpcCode(handle("session.compact", {}));
	}
	expect(code).toBeUndefined();
	expect(calls.compact).toEqual([undefined, undefined]);
});

function accessHarness(options: { ttlMs?: number; staleMs?: number } = {}) {
	const clock = { now: 0 };
	const lookups: PromiseWithResolvers<CollabAccess | undefined>[] = [];
	const cache = createAccessCache(
		() => {
			const lookup = Promise.withResolvers<CollabAccess | undefined>();
			lookups.push(lookup);
			return lookup.promise;
		},
		{ ttlMs: options.ttlMs ?? 5_000, staleMs: options.staleMs ?? 30_000, now: () => clock.now },
	);
	return { cache, clock, lookups };
}

test("the access cache shares one in-flight lookup and reuses its answer until the TTL passes", async () => {
	const { cache, clock, lookups } = accessHarness();
	const first = cache.current();
	const second = cache.current();
	expect(lookups).toHaveLength(1);
	lookups[0].resolve("control");
	expect(await Promise.all([first, second])).toEqual(["control", "control"]);

	clock.now = 4_999;
	expect(await cache.current()).toBe("control");
	expect(lookups).toHaveLength(1);

	clock.now = 5_000;
	const renewed = cache.current();
	expect(lookups).toHaveLength(2);
	lookups[1].resolve("view");
	expect(await renewed).toBe("view");
});

test("a failed lookup keeps the last known level until it is stale, and is view with none known", async () => {
	const { cache, clock, lookups } = accessHarness();
	const unknown = cache.current();
	lookups[0].resolve(undefined);
	expect(await unknown).toBe("view");

	const known = cache.refresh();
	lookups[1].resolve("control");
	expect(await known).toBe("control");

	clock.now = 10_000;
	const failed = cache.current();
	lookups[2].reject(new Error("registry unreadable"));
	expect(await failed).toBe("control");

	clock.now = 30_001;
	const stale = cache.current();
	lookups[3].resolve(undefined);
	expect(await stale).toBe("view");
	expect(lookups).toHaveLength(4);
});

test("session.info refreshes the gate's cached access, so a switch to view-only applies at once", async () => {
	const { cache, lookups } = accessHarness();
	const { handle } = harness({ access: cache });

	const shared = handle("session.info", {});
	lookups[0].resolve("control");
	expect(await shared).toMatchObject({ access: "control" });
	expect(await handle("files.list", { path: "" })).toMatchObject({ path: "" });

	const revoked = handle("session.info", {});
	lookups[1].resolve("view");
	expect(await revoked).toMatchObject({ access: "view" });
	expect(await rpcCode(handle("files.list", { path: "" }))).toBe(RpcCode.Forbidden);
	expect(lookups).toHaveLength(2);
});

test("blank compact instructions are treated as none", async () => {
	const { handle, calls } = harness();
	await handle("session.compact", { instructions: "   " });
	expect(calls.compact).toEqual([undefined]);
});

test("abort calls through to the session", async () => {
	const { handle, calls } = harness();
	expect(await handle("session.abort", undefined)).toEqual({ ok: true });
	expect(calls.abort).toBe(1);
});
