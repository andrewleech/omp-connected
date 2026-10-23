import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type AuthAccount,
	type AuthLoginStatus,
	type AuthPlatform,
	type AuthProvider,
	type LoginCallbacks,
	type LoginIdentity,
	LoginManager,
} from "../../src/auth-login.js";
import { FileService } from "../../src/files-rpc.js";
import { RpcCode } from "../../src/protocol.js";
import { PromptScheduler } from "../../src/scheduled-prompts.js";
import {
	type AccessSource,
	type CollabAccess,
	createAccessCache,
	createSessionRpc,
	type SessionRequestHandler,
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

function harness(
	options: {
		access?: CollabAccess | AccessSource;
		idle?: boolean;
		pending?: boolean;
		setModelResult?: boolean;
		usageReports?: unknown[];
		/** Behaviour of the fake `authStorage.oauth.login`. */
		login?: (providerId: string, callbacks: LoginCallbacks) => Promise<LoginIdentity | undefined>;
	} = {},
) {
	const level = typeof options.access === "string" ? options.access : "control";
	const access: AccessSource =
		typeof options.access === "object"
			? options.access
			: { current: async () => level, refresh: async () => level };
	const calls = {
		abort: 0,
		compact: [] as (string | undefined)[],
		setModel: [] as Model[],
		thinking: [] as string[],
		forks: [] as { cwd: string; name: string; sessionFile: string }[],
		refreshed: [] as string[],
		loginCalls: [] as { providerId: string; manualCodeInput: boolean }[],
	};
	const warnings: string[] = [];
	const stored: Record<string, AuthAccount[]> = {
		anthropic: [{ credentialId: 7, label: "me@example.test", detail: "oauth #7", type: "oauth", active: true }],
	};
	let onWarn: () => void = () => undefined;
	const compaction = Promise.withResolvers<void>();
	const state = { model: sonnet as Model | undefined, idle: options.idle ?? true, pending: options.pending ?? false };
	const ctx = {
		get model() {
			return state.model;
		},
		models: { list: () => [sonnet, plain] },
		modelRegistry: {
			getProviderBaseUrl: () => undefined,
			authStorage: {
				usage: { reports: async () => options.usageReports ?? [] },
				keys: { source: (provider: string) => (provider === "envkey" ? { kind: "env" } : undefined) },
				oauth: {
					login: (providerId: string, callbacks: LoginCallbacks) => {
						calls.loginCalls.push({ providerId, manualCodeInput: callbacks.onManualCodeInput !== undefined });
						return (options.login ?? (async () => undefined))(providerId, callbacks);
					},
				},
			},
			refreshProvider: async (provider: string) => {
				calls.refreshed.push(provider);
			},
		},
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		sessionManager: {
			getCwd: () => root,
			getSessionFile: () => path.join(root, "current.jsonl"),
		},
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
	// Never fires within a test: the clock stands still and the timer is inert.
	const scheduler = new PromptScheduler({
		send: () => undefined,
		onError: () => undefined,
		isIdle: () => true,
		now: () => 5_000,
		setTimer: () => undefined,
		clearTimer: () => undefined,
	});
	const platform: AuthPlatform = {
		providers: () => [
			{ id: "anthropic", name: "Anthropic", available: true },
			{ id: "openai-codex-device", name: "Codex (device)", available: true, storeCredentialsAs: "openai-codex" },
			{ id: "envkey", name: "Env Key", available: true },
			{ id: "soon", name: "Soon", available: false },
		],
		credentialProvider: (providerId) => (providerId === "openai-codex-device" ? "openai-codex" : providerId),
		pasteCodeProviders: new Set(["anthropic"]),
		listAccounts: async (_ctx, providerId) => stored[providerId] ?? [],
		logout: async (_ctx, providerId, credentialId) => {
			const accounts = stored[providerId] ?? [];
			const at = accounts.findIndex((account) => account.credentialId === credentialId);
			if (at === -1) return { removed: false };
			accounts.splice(at, 1);
			return { removed: true, remainingSource: "ANTHROPIC_API_KEY" };
		},
	};
	const logins = new LoginManager();
	const handle = createSessionRpc({
		pi,
		context: () => ctx,
		access,
		files,
		scheduler,
		logins,
		authPlatform: async () => platform,
		forkCurrentSession: async (params) => {
			calls.forks.push(params);
			return { ok: true, label: "project.fork" };
		},
	});
	return {
		handle,
		logins,
		stored,
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
test("session.usage returns quota values without provider account identity", async () => {
	const { handle } = harness({
		usageReports: [
			{
				provider: "anthropic",
				fetchedAt: 1_000,
				metadata: { email: "person@example.invalid" },
				raw: { accessToken: "secret" },
				limits: [
					{
						label: "Weekly",
						amount: { unit: "percent", used: 37 },
						status: "ok",
						window: { label: "7 Day", resetsAt: 50_000, resetLabel: "Resets" },
						scope: { accountId: "account-secret" },
					},
				],
			},
		],
	});
	const result = (await handle("session.usage", {})) as {
		generatedAt: number;
		reports: unknown[];
	};
	expect(result).toEqual({
		generatedAt: expect.any(Number),
		reports: [
			{
				provider: "anthropic",
				fetchedAt: 1_000,
				limits: [
					{
						label: "Weekly",
						unit: "percent",
						used: 37,
						limit: null,
						remaining: null,
						usedFraction: 0.37,
						status: "ok",
						window: { label: "7 Day", resetsAt: 50_000, resetLabel: "Resets" },
					},
				],
			},
		],
	});
	expect(JSON.stringify(result)).not.toContain("person@example.invalid");
	expect(JSON.stringify(result)).not.toContain("account-secret");
	expect(JSON.stringify(result)).not.toContain("accessToken");
});

test("a view-only session answers session.info but refuses every other method as forbidden", async () => {
	const { handle, calls } = harness({ access: "view" });
	const gated: [string, unknown][] = [
		["session.usage", {}],
		["session.abort", {}],
		["session.exit", {}],
		["session.fork", { name: "fork" }],
		["session.compact", {}],
		["session.set_model", { provider: "openai", id: "gpt-plain" }],
		["session.set_thinking", { level: "low" }],
		["files.list", { path: "" }],
		["files.stat", { path: "" }],
		["files.read", { path: "x", offset: 0, length: 1 }],
		["files.write", { path: "x", uploadId: "upload-01", offset: 0, data: "", final: true, overwrite: false }],
		["files.write_abort", { path: "x", uploadId: "upload-01" }],
		["files.mkdir", { path: "d" }],
		["session.schedule_prompt", { text: "later", delayMs: 60_000 }],
		["session.scheduled", {}],
		["session.cancel_scheduled", { id: "x" }],
		["session.auth_providers", {}],
		["session.auth_login_start", { providerId: "anthropic" }],
		["session.auth_login_status", { loginId: "x" }],
		["session.auth_login_input", { loginId: "x", value: "v" }],
		["session.auth_login_cancel", { loginId: "x" }],
		["session.auth_logout", { providerId: "anthropic", credentialId: 7 }],
	];
	for (const [method, params] of gated) {
		expect({ method, code: await rpcCode(handle(method, params)) }).toEqual({
			method,
			code: RpcCode.Forbidden,
		});
	}
	expect(calls.abort).toBe(0);
	expect(await fs.readdir(root)).toEqual([]);
});

test("exit requires a live control-shared owner session", async () => {
	const { handle } = harness();
	expect(await handle("session.exit", {})).toEqual({ ok: true });
	expect(await rpcCode(harness({ access: "view" }).handle("session.exit", {}))).toBe(RpcCode.Forbidden);
});
test("session.fork launches a snapshot of this persisted session", async () => {
	const { handle, calls } = harness();
	expect(await handle("session.fork", { name: "review" })).toEqual({
		ok: true,
		label: "project.fork",
	});
	expect(calls.forks).toEqual([{ cwd: root, name: "review", sessionFile: path.join(root, "current.jsonl") }]);
});

test("session.fork refuses a busy session or queued prompt", async () => {
	for (const options of [{ idle: false }, { pending: true }]) {
		const { handle, calls } = harness(options);
		expect(await rpcCode(handle("session.fork", { name: "review" }))).toBe(RpcCode.Busy);
		expect(calls.forks).toEqual([]);
	}
});

test("an unknown method is -32601 regardless of access", async () => {
	expect(await rpcCode(harness({ access: "view" }).handle("session.reboot", {}))).toBe(RpcCode.MethodNotFound);
	expect(await rpcCode(harness().handle("toString", {}))).toBe(RpcCode.MethodNotFound);
});

test("files methods reach the session root when control is shared", async () => {
	const { handle } = harness();
	expect(await handle("files.mkdir", { path: "made" })).toEqual({ ok: true });
	expect(await handle("files.list", { path: "" })).toMatchObject({
		path: "",
		entries: [{ name: "made", type: "dir" }],
	});
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
	expect(await handle("session.set_model", { provider: "openai", id: "gpt-plain" })).toEqual({
		ok: true,
	});
	expect(calls.setModel).toEqual([plain]);
	expect(await rpcCode(handle("session.set_model", { provider: "anthropic", id: "gpt-plain" }))).toBe(RpcCode.NotFound);
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
	expect(await handle("session.compact", { instructions: "focus on the API" })).toEqual({
		ok: true,
	});
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

test("scheduled prompts can be queued, listed and cancelled; bad requests are invalid", async () => {
	const { handle } = harness();
	const queued = (await handle("session.schedule_prompt", {
		text: "run the tests",
		delayMs: 90_000,
	})) as {
		id: string;
		fireAt: number;
	};
	expect(queued).toMatchObject({ text: "run the tests", fireAt: 95_000, createdAt: 5_000 });
	expect(await handle("session.scheduled", {})).toEqual({ prompts: [queued] });

	expect(await rpcCode(handle("session.schedule_prompt", { text: "", delayMs: 1_000 }))).toBe(RpcCode.Invalid);
	expect(await rpcCode(handle("session.schedule_prompt", { text: "x", delayMs: "soon" }))).toBe(RpcCode.Invalid);
	expect(await rpcCode(handle("session.schedule_prompt", { text: "x", delayMs: -5 }))).toBe(RpcCode.Invalid);

	expect(await handle("session.cancel_scheduled", { id: queued.id })).toEqual({ ok: true });
	expect(await rpcCode(handle("session.cancel_scheduled", { id: queued.id }))).toBe(RpcCode.NotFound);
	expect(await handle("session.scheduled", {})).toEqual({ prompts: [] });
});

/** Lets the login flow the fake provider runs reach its next await. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A provider flow that stays pending until aborted, then rejects. */
function abortable(signal: AbortSignal, onAbort: () => void): Promise<LoginIdentity | undefined> {
	const { promise, reject } = Promise.withResolvers<LoginIdentity | undefined>();
	signal.addEventListener("abort", () => {
		onAbort();
		reject(new Error("aborted"));
	});
	return promise;
}

async function loginStatus(handle: SessionRequestHandler, loginId: string): Promise<AuthLoginStatus> {
	return (await handle("session.auth_login_status", { loginId })) as AuthLoginStatus;
}

test("session.auth_providers lists providers with their stored accounts and credential sources", async () => {
	const { handle } = harness();
	const { providers } = (await handle("session.auth_providers", {})) as { providers: AuthProvider[] };
	expect(providers.map(({ id, authenticated, available }) => ({ id, authenticated, available }))).toEqual([
		{ id: "anthropic", authenticated: true, available: true },
		{ id: "openai-codex-device", authenticated: false, available: true },
		{ id: "envkey", authenticated: true, available: true },
		{ id: "soon", authenticated: false, available: false },
	]);
	expect(providers[0]?.accounts).toEqual([
		{ credentialId: 7, label: "me@example.test", detail: "oauth #7", type: "oauth", active: true },
	]);
});

test("a paste-code login shows the auth link, takes the pasted redirect URL and refreshes the provider", async () => {
	const pasted = "http://localhost:1455/auth/callback?code=abc123456789&state=s1";
	let received = "";
	const { handle, calls } = harness({
		login: async (_providerId, callbacks) => {
			callbacks.onProgress("Waiting for the browser");
			callbacks.onAuth({
				url: "https://auth.example.test/authorize?x=1",
				launchUrl: "http://127.0.0.1:1455/launch",
				instructions: "Sign in",
			});
			received = (await callbacks.onManualCodeInput?.(callbacks.signal)) ?? "";
			return { type: "oauth", email: "me@example.test", orgName: "Acme" };
		},
	});
	const started = (await handle("session.auth_login_start", { providerId: "anthropic" })) as AuthLoginStatus;
	expect(started.providerId).toBe("anthropic");
	await flush();
	expect(await loginStatus(handle, started.loginId)).toEqual({
		loginId: started.loginId,
		providerId: "anthropic",
		state: "awaiting_input",
		url: "https://auth.example.test/authorize?x=1",
		launchUrl: "http://127.0.0.1:1455/launch",
		instructions: "Sign in",
		progress: ["Waiting for the browser"],
		prompt: { message: "Paste the authorization code (or full redirect URL):", secret: false },
	});

	expect(await handle("session.auth_login_input", { loginId: started.loginId, value: pasted })).toEqual({ ok: true });
	await flush();
	const done = await loginStatus(handle, started.loginId);
	expect(done).toMatchObject({ state: "done", identity: "me@example.test (Acme)" });
	expect(done.prompt).toBeUndefined();
	expect(received).toBe(pasted);
	expect(calls.loginCalls).toEqual([{ providerId: "anthropic", manualCodeInput: true }]);
	expect(calls.refreshed).toEqual(["anthropic"]);
	expect(JSON.stringify(done)).not.toContain("abc123456789");
});

test("a secret prompt before any auth link is forwarded, and a failure never echoes the submitted key", async () => {
	const { handle, calls } = harness({
		login: async (_providerId, callbacks) => {
			const key = await callbacks.onPrompt({ message: "Enter API key", placeholder: "sk-...", secret: true });
			throw new Error(`the provider rejected ${key}`);
		},
	});
	const started = (await handle("session.auth_login_start", { providerId: "envkey" })) as AuthLoginStatus;
	await flush();
	const waiting = await loginStatus(handle, started.loginId);
	expect(waiting).toMatchObject({
		state: "awaiting_input",
		prompt: { message: "Enter API key", placeholder: "sk-...", secret: true },
	});
	expect(waiting.url).toBeUndefined();

	await handle("session.auth_login_input", { loginId: started.loginId, value: "sk-secret-value-123" });
	await flush();
	const failed = await loginStatus(handle, started.loginId);
	expect(failed).toMatchObject({ state: "failed", error: "the provider rejected [redacted]" });
	expect(JSON.stringify(failed)).not.toContain("sk-secret-value-123");
	expect(calls.loginCalls).toEqual([{ providerId: "envkey", manualCodeInput: false }]);
	expect(calls.refreshed).toEqual([]);
});

test("cancelling aborts the provider flow, frees the session for a new login and is idempotent", async () => {
	let aborted = false;
	const { handle } = harness({
		login: (_providerId, callbacks) =>
			abortable(callbacks.signal, () => {
				aborted = true;
			}),
	});
	const first = (await handle("session.auth_login_start", { providerId: "anthropic" })) as AuthLoginStatus;
	expect(await handle("session.auth_login_cancel", { loginId: first.loginId })).toEqual({ ok: true });
	expect(aborted).toBe(true);
	expect(await loginStatus(handle, first.loginId)).toMatchObject({ state: "cancelled" });
	expect(await handle("session.auth_login_cancel", { loginId: first.loginId })).toEqual({ ok: true });

	const second = (await handle("session.auth_login_start", { providerId: "anthropic" })) as AuthLoginStatus;
	expect(second.loginId).not.toBe(first.loginId);
});

test("auth login requests are validated: busy, unknown provider, no pending prompt, unknown login, bad values", async () => {
	const { handle, logins } = harness({ login: () => Promise.withResolvers<undefined>().promise });
	const first = (await handle("session.auth_login_start", { providerId: "anthropic" })) as AuthLoginStatus;

	expect(await rpcCode(handle("session.auth_login_start", { providerId: "envkey" }))).toBe(RpcCode.Busy);
	expect(await rpcCode(handle("session.auth_login_start", { providerId: "nope" }))).toBe(RpcCode.Invalid);
	expect(await rpcCode(handle("session.auth_login_start", { providerId: "soon" }))).toBe(RpcCode.Invalid);
	expect(await rpcCode(handle("session.auth_login_start", { providerId: "" }))).toBe(RpcCode.Invalid);
	expect(await rpcCode(handle("session.auth_login_start", {}))).toBe(RpcCode.Invalid);

	expect(await rpcCode(handle("session.auth_login_input", { loginId: first.loginId, value: "x" }))).toBe(
		RpcCode.Invalid,
	);
	expect(await rpcCode(handle("session.auth_login_input", { loginId: first.loginId, value: 5 }))).toBe(
		RpcCode.Invalid,
	);
	expect(
		await rpcCode(handle("session.auth_login_input", { loginId: first.loginId, value: "x".repeat(100_001) })),
	).toBe(RpcCode.Invalid);
	for (const method of ["session.auth_login_status", "session.auth_login_input", "session.auth_login_cancel"]) {
		expect(await rpcCode(handle(method, { loginId: "missing", value: "x" }))).toBe(RpcCode.NotFound);
		expect(await rpcCode(handle(method, { value: "x" }))).toBe(RpcCode.Invalid);
	}
	logins.clear();
});

test("ending the session aborts the running login and forgets it", async () => {
	let aborted = false;
	const { handle, logins } = harness({
		login: (_providerId, callbacks) =>
			abortable(callbacks.signal, () => {
				aborted = true;
			}),
	});
	const started = (await handle("session.auth_login_start", { providerId: "anthropic" })) as AuthLoginStatus;
	logins.clear();
	expect(aborted).toBe(true);
	expect(await rpcCode(handle("session.auth_login_status", { loginId: started.loginId }))).toBe(RpcCode.NotFound);
});

test("session.auth_logout removes a stored account and reports what still authenticates the provider", async () => {
	const { handle, stored } = harness();
	expect(await handle("session.auth_logout", { providerId: "anthropic", credentialId: 7 })).toEqual({
		ok: true,
		remainingSource: "ANTHROPIC_API_KEY",
	});
	expect(stored.anthropic).toEqual([]);
	expect(await rpcCode(handle("session.auth_logout", { providerId: "anthropic", credentialId: 7 }))).toBe(
		RpcCode.NotFound,
	);
	for (const params of [
		{ providerId: "anthropic", credentialId: "7" },
		{ providerId: "anthropic", credentialId: 1.5 },
		{ providerId: "", credentialId: 7 },
		{ credentialId: 7 },
	]) {
		expect(await rpcCode(handle("session.auth_logout", params))).toBe(RpcCode.Invalid);
	}
});
