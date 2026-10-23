import { expect, test } from "bun:test";
import {
	formatLoginIdentity,
	LOGIN_RETENTION_MS,
	type LoginCallbacks,
	type LoginIdentity,
	LoginManager,
	MAX_PROGRESS_LINES,
	MAX_SUBMITTED_VALUES,
} from "../../src/auth-login.js";
import { RpcCode, RpcError } from "../../src/protocol.js";

/** Lets the fake provider flow reach its next await. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function codeOf(fn: () => unknown): number | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof RpcError ? error.code : undefined;
	}
	return undefined;
}

/** A manager whose clock the test moves. */
function manager() {
	const clock = { now: 1_000 };
	return { logins: new LoginManager({ now: () => clock.now }), clock };
}

test("a login that finishes stays queryable for the retention window, then is forgotten", async () => {
	const { logins, clock } = manager();
	const status = logins.start({
		providerId: "anthropic",
		manualCodeInput: false,
		run: async () => ({ type: "oauth", email: "me@example.test" }),
	});
	await flush();
	expect(logins.status(status.loginId)).toMatchObject({ state: "done", identity: "me@example.test" });

	clock.now += LOGIN_RETENTION_MS;
	expect(logins.status(status.loginId).state).toBe("done");
	clock.now += 1;
	expect(codeOf(() => logins.status(status.loginId))).toBe(RpcCode.NotFound);
});

test("only the last progress lines are kept", async () => {
	const { logins } = manager();
	const { promise, resolve } = Promise.withResolvers<LoginIdentity | undefined>();
	const status = logins.start({
		providerId: "anthropic",
		manualCodeInput: false,
		run: (callbacks) => {
			for (let i = 1; i <= MAX_PROGRESS_LINES + 5; i += 1) callbacks.onProgress(`step ${i}`);
			return promise;
		},
	});
	const { progress } = logins.status(status.loginId);
	expect(progress).toHaveLength(MAX_PROGRESS_LINES);
	expect(progress[0]).toBe("step 6");
	expect(progress.at(-1)).toBe(`step ${MAX_PROGRESS_LINES + 5}`);
	resolve(undefined);
});

test("manual code input withdrawn by the provider no longer waits for an answer", async () => {
	const { logins } = manager();
	const gate = Promise.withResolvers<LoginIdentity | undefined>();
	const manual = new AbortController();
	let rejected = false;
	const status = logins.start({
		providerId: "anthropic",
		manualCodeInput: true,
		run: (callbacks) => {
			callbacks.onAuth({ url: "https://auth.example.test/authorize" });
			callbacks.onManualCodeInput?.(manual.signal).catch(() => {
				rejected = true;
			});
			return gate.promise;
		},
	});
	expect(logins.status(status.loginId).state).toBe("awaiting_input");

	manual.abort();
	await flush();
	expect(rejected).toBe(true);
	expect(logins.status(status.loginId)).toMatchObject({ state: "awaiting_auth", url: "https://auth.example.test/authorize" });
	expect(codeOf(() => logins.input(status.loginId, "late"))).toBe(RpcCode.Invalid);

	gate.resolve({ type: "oauth", accountId: "acct-1", orgId: "org-9" });
	await flush();
	expect(logins.status(status.loginId)).toMatchObject({ state: "done", identity: "acct-1 (org-9)" });
});

test("prompts are answered oldest first", async () => {
	const { logins } = manager();
	const answers: string[] = [];
	const status = logins.start({
		providerId: "p",
		manualCodeInput: false,
		run: async (callbacks) => {
			const first = callbacks.onPrompt({ message: "first" });
			const second = callbacks.onPrompt({ message: "second" });
			answers.push(await first, await second);
			return undefined;
		},
	});
	expect(logins.status(status.loginId).prompt?.message).toBe("first");
	logins.input(status.loginId, "a");
	await flush();
	expect(logins.status(status.loginId).prompt?.message).toBe("second");
	logins.input(status.loginId, "b");
	await flush();
	expect(answers).toEqual(["a", "b"]);
	expect(logins.status(status.loginId).state).toBe("done");
});

test("a provider that keeps asking after refused input is failed instead of looped", async () => {
	const { logins } = manager();
	let asked = 0;
	let aborted = false;
	const status = logins.start({
		providerId: "anthropic",
		manualCodeInput: false,
		run: async (callbacks: LoginCallbacks) => {
			callbacks.signal.addEventListener("abort", () => {
				aborted = true;
			});
			for (;;) {
				asked += 1;
				await callbacks.onPrompt({ message: "code?" });
			}
		},
	});
	for (let i = 0; i < MAX_SUBMITTED_VALUES; i += 1) {
		logins.input(status.loginId, `wrong-value-${i}-xxxxxxxx`);
		await flush();
	}
	expect(asked).toBe(MAX_SUBMITTED_VALUES + 1);
	expect(aborted).toBe(true);
	const final = logins.status(status.loginId);
	expect(final.state).toBe("failed");
	expect(final.error).toContain("again");
	expect(JSON.stringify(final)).not.toContain("wrong-value");
});

test("a provider error is reported with submitted values redacted", async () => {
	const { logins } = manager();
	const status = logins.start({
		providerId: "anthropic",
		manualCodeInput: false,
		run: async (callbacks) => {
			const pasted = await callbacks.onPrompt({ message: "code?" });
			callbacks.onProgress(`exchanging ${pasted}`);
			throw new Error(`token exchange failed: 400 invalid_grant for ${pasted}`);
		},
	});
	logins.input(status.loginId, "http://localhost:1455/cb?code=abcdefghijkl&state=s");
	await flush();
	const final = logins.status(status.loginId);
	expect(final).toMatchObject({ state: "failed", error: "token exchange failed: 400 invalid_grant for [redacted]" });
	expect(final.progress).toEqual(["exchanging [redacted]"]);
	expect(JSON.stringify(final)).not.toContain("abcdefghijkl");
});

test("prompts requested after cancel reject at once, and cancel never resolves a pending prompt", async () => {
	const { logins } = manager();
	const captured: { callbacks?: LoginCallbacks } = {};
	const status = logins.start({
		providerId: "anthropic",
		manualCodeInput: false,
		run: (callbacks) => {
			captured.callbacks = callbacks;
			return Promise.withResolvers<LoginIdentity | undefined>().promise;
		},
	});
	const { callbacks } = captured;
	if (!callbacks) throw new Error("the provider flow did not start");
	const outcome = callbacks.onPrompt({ message: "code?" }).then(
		() => "resolved",
		() => "rejected",
	);
	logins.cancel(status.loginId);
	expect(callbacks.signal.aborted).toBe(true);
	expect(await outcome).toBe("rejected");
	const late = await callbacks.onPrompt({ message: "again?" }).then(
		() => "resolved",
		() => "rejected",
	);
	expect(late).toBe("rejected");
	expect(logins.status(status.loginId).state).toBe("cancelled");
});

test("a second login is busy until the first one ends", async () => {
	const { logins } = manager();
	const first = logins.start({
		providerId: "a",
		manualCodeInput: false,
		run: () => Promise.withResolvers<LoginIdentity | undefined>().promise,
	});
	const second = {
		providerId: "b",
		manualCodeInput: false,
		run: async () => undefined,
	};
	expect(codeOf(() => logins.start(second))).toBe(RpcCode.Busy);
	logins.cancel(first.loginId);
	expect(logins.start(second).providerId).toBe("b");
});

test("identity is shown as account and organisation when known", () => {
	expect(formatLoginIdentity({ type: "oauth", email: "me@example.test", orgName: "Acme" })).toBe("me@example.test (Acme)");
	expect(formatLoginIdentity({ type: "oauth", orgId: "org-1" })).toBe("org-1");
	expect(formatLoginIdentity({ type: "api_key" })).toBeUndefined();
	expect(formatLoginIdentity(undefined)).toBeUndefined();
});
