// Provider login driven from the dashboard.
//
// `AuthStorage.oauth.login` runs a provider's flow through callbacks: an auth
// link to show, progress lines, and prompts (a pasted redirect URL, an API key)
// that a person answers. `LoginManager` runs one such flow per session in the
// background and exposes it as a status record the hub polls; answers arrive
// through `input`. Prompts can come before or after the auth link, and a
// provider with a local callback server asks for pasted input at the same time
// as it waits for the callback.
//
// Values the user submits are never stored in the status or logged; any
// provider text echoing them is redacted.

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { RpcCode, RpcError } from "./protocol.js";

/** How long a finished login stays queryable. */
export const LOGIN_RETENTION_MS = 5 * 60_000;
/** Most progress lines a status carries. */
export const MAX_PROGRESS_LINES = 20;
/** Submitted values shorter than this are not redacted from provider text. */
const MIN_REDACTED_LENGTH = 8;
const MAX_ERROR_LENGTH = 500;
const REDACTED = "[redacted]";
const MANUAL_CODE_MESSAGE = "Paste the authorization code (or full redirect URL):";
/** A login that asks for input again after this many submitted values is failed rather than looped. */
export const MAX_SUBMITTED_VALUES = 3;

export type AuthLoginState = "starting" | "awaiting_auth" | "awaiting_input" | "done" | "failed" | "cancelled";

export interface AuthLoginStatus {
	loginId: string;
	providerId: string;
	state: AuthLoginState;
	url?: string;
	launchUrl?: string;
	instructions?: string;
	progress: string[];
	prompt?: { message: string; placeholder?: string; secret: boolean };
	identity?: string;
	error?: string;
}

export interface AuthAccount {
	credentialId: number;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}

export interface AuthProvider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
	accounts: AuthAccount[];
}

/** The callbacks OMP's `AuthStorage.oauth.login` takes. */
export interface LoginCallbacks {
	signal: AbortSignal;
	onAuth(info: { url: string; launchUrl?: string; instructions?: string }): void;
	onProgress(message: string): void;
	onPrompt(prompt: { message: string; placeholder?: string; secret?: boolean }): Promise<string>;
	/** Present only for providers that take a pasted authorization code or redirect URL. */
	onManualCodeInput?(signal?: AbortSignal): Promise<string>;
}

/** The identity slice OMP reports for a stored credential. */
export interface LoginIdentity {
	type: "oauth" | "api_key";
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
}

export interface LoginRequest {
	providerId: string;
	/** Offer pasted-code input for this provider. */
	manualCodeInput: boolean;
	run(callbacks: LoginCallbacks): Promise<LoginIdentity | undefined>;
	/** Runs after a successful login, outside the login's own outcome. */
	afterSuccess?(): Promise<unknown>;
}

export interface LoginManagerOptions {
	now?: () => number;
	retentionMs?: number;
	/** Reports a failure of `afterSuccess`. */
	onAfterSuccessError?: (error: unknown) => void;
}

interface PendingInput {
	prompt: { message: string; placeholder?: string; secret: boolean };
	resolve(value: string): void;
	reject(error: Error): void;
	/** Detaches the abort listener of a manual-code request. */
	dispose?: () => void;
}

interface LoginRecord {
	id: string;
	providerId: string;
	finished?: "done" | "failed" | "cancelled";
	finishedAt?: number;
	auth?: { url: string; launchUrl?: string; instructions?: string };
	progress: string[];
	pending: PendingInput[];
	identity?: string;
	error?: string;
	abort: AbortController;
	/** Submitted values to keep out of provider text. */
	secrets: string[];
	/** Values submitted so far. */
	submitted: number;
}

/** `email (org)`, `email`, or `org`; undefined when the login stored no account identity. */
export function formatLoginIdentity(identity: LoginIdentity | undefined): string | undefined {
	if (identity?.type !== "oauth") return undefined;
	const base = identity.email ?? identity.accountId;
	const org = identity.orgName ?? identity.orgId;
	if (base) return org ? `${base} (${org})` : base;
	return org;
}

/** The parts of a submitted value that provider text could repeat. */
function secretsOf(value: string): string[] {
	const secrets = [value, value.trim()];
	try {
		const code = new URL(value.trim()).searchParams.get("code");
		if (code) secrets.push(code);
	} catch {
		// Not a URL.
	}
	return secrets.filter((secret) => secret.length >= MIN_REDACTED_LENGTH);
}

export class LoginManager {
	readonly #now: () => number;
	readonly #retentionMs: number;
	readonly #onAfterSuccessError: (error: unknown) => void;
	readonly #records = new Map<string, LoginRecord>();
	#active: LoginRecord | undefined;

	constructor(options: LoginManagerOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#retentionMs = options.retentionMs ?? LOGIN_RETENTION_MS;
		this.#onAfterSuccessError = options.onAfterSuccessError ?? (() => undefined);
	}

	/** Starts a login; throws Busy while another one is in flight. */
	start(request: LoginRequest): AuthLoginStatus {
		this.#prune();
		if (this.#active) throw new RpcError(RpcCode.Busy, "a login is already in progress for this session");
		const record: LoginRecord = {
			id: crypto.randomUUID(),
			providerId: request.providerId,
			progress: [],
			pending: [],
			abort: new AbortController(),
			secrets: [],
			submitted: 0,
		};
		this.#records.set(record.id, record);
		this.#active = record;
		void this.#run(record, request);
		return this.#snapshot(record);
	}

	status(loginId: string): AuthLoginStatus {
		return this.#snapshot(this.#get(loginId));
	}

	/** Answers the oldest pending prompt or manual-code request. */
	input(loginId: string, value: string): void {
		const record = this.#get(loginId);
		const pending = record.finished ? undefined : record.pending.shift();
		if (!pending) throw new RpcError(RpcCode.Invalid, "the login is not waiting for input");
		record.secrets.push(...secretsOf(value));
		record.submitted += 1;
		pending.dispose?.();
		pending.resolve(value);
	}

	/** Aborts a running login; a finished one is left as it is. */
	cancel(loginId: string): void {
		const record = this.#get(loginId);
		if (record.finished) return;
		record.abort.abort();
		this.#finish(record, "cancelled");
	}

	/** Aborts the running login and forgets every record. */
	clear(): void {
		for (const record of this.#records.values()) {
			if (record.finished) continue;
			record.abort.abort();
			this.#finish(record, "cancelled");
		}
		this.#records.clear();
		this.#active = undefined;
	}

	#get(loginId: string): LoginRecord {
		this.#prune();
		const record = this.#records.get(loginId);
		if (!record) throw new RpcError(RpcCode.NotFound, "no such login; it may have expired");
		return record;
	}

	#prune(): void {
		const now = this.#now();
		for (const [id, record] of this.#records) {
			if (record.finishedAt !== undefined && now - record.finishedAt > this.#retentionMs) {
				this.#records.delete(id);
			}
		}
	}

	async #run(record: LoginRecord, request: LoginRequest): Promise<void> {
		try {
			const identity = await request.run(this.#callbacks(record, request.manualCodeInput));
			if (record.finished) return;
			record.identity = formatLoginIdentity(identity);
			this.#finish(record, "done");
			if (request.afterSuccess) {
				void Promise.resolve()
					.then(() => request.afterSuccess?.())
					.catch(this.#onAfterSuccessError);
			}
		} catch (error) {
			if (record.finished) return;
			record.error = this.#redact(record, error instanceof Error ? error.message : String(error));
			this.#finish(record, "failed");
		}
	}

	#callbacks(record: LoginRecord, manualCodeInput: boolean): LoginCallbacks {
		return {
			signal: record.abort.signal,
			onAuth: (info) => {
				if (record.finished) return;
				record.auth = {
					url: info.url,
					...(info.launchUrl ? { launchUrl: info.launchUrl } : {}),
					...(info.instructions ? { instructions: info.instructions } : {}),
				};
			},
			onProgress: (message) => {
				if (record.finished) return;
				record.progress.push(this.#redact(record, message));
				if (record.progress.length > MAX_PROGRESS_LINES) {
					record.progress.splice(0, record.progress.length - MAX_PROGRESS_LINES);
				}
			},
			onPrompt: (prompt) =>
				this.#ask(record, {
					message: prompt.message,
					...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
					secret: prompt.secret === true,
				}),
			...(manualCodeInput
				? {
						onManualCodeInput: (signal?: AbortSignal) =>
							this.#ask(record, { message: MANUAL_CODE_MESSAGE, secret: false }, signal),
					}
				: {}),
		};
	}

	/** Queues a prompt for the dashboard; settles when answered, aborted or the login ends. */
	#ask(record: LoginRecord, prompt: PendingInput["prompt"], signal?: AbortSignal): Promise<string> {
		if (record.finished) return Promise.reject(new Error("the login has ended"));
		if (record.submitted >= MAX_SUBMITTED_VALUES) {
			record.error = `the provider asked for input again after ${MAX_SUBMITTED_VALUES} submitted values`;
			record.abort.abort();
			this.#finish(record, "failed");
			return Promise.reject(new Error("the login has ended"));
		}
		if (signal?.aborted) return Promise.reject(new Error("the request was aborted"));
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const pending: PendingInput = { prompt, resolve, reject };
		if (signal) {
			const onAbort = () => {
				const at = record.pending.indexOf(pending);
				if (at !== -1) record.pending.splice(at, 1);
				reject(new Error("the request was aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.dispose = () => signal.removeEventListener("abort", onAbort);
		}
		record.pending.push(pending);
		return promise;
	}

	#finish(record: LoginRecord, outcome: "done" | "failed" | "cancelled"): void {
		record.finished = outcome;
		record.finishedAt = this.#now();
		const pending = record.pending.splice(0);
		for (const entry of pending) {
			entry.dispose?.();
			entry.reject(new Error("the login has ended"));
		}
		if (this.#active === record) this.#active = undefined;
	}

	#redact(record: LoginRecord, text: string): string {
		let result = text;
		for (const secret of record.secrets) result = result.split(secret).join(REDACTED);
		return result.length > MAX_ERROR_LENGTH ? `${result.slice(0, MAX_ERROR_LENGTH)}...` : result;
	}

	#snapshot(record: LoginRecord): AuthLoginStatus {
		const waiting = record.pending[0];
		const state: AuthLoginState =
			record.finished ?? (waiting ? "awaiting_input" : record.auth ? "awaiting_auth" : "starting");
		return {
			loginId: record.id,
			providerId: record.providerId,
			state,
			...(record.auth ?? {}),
			progress: [...record.progress],
			...(state === "awaiting_input" && waiting ? { prompt: { ...waiting.prompt } } : {}),
			...(record.identity ? { identity: record.identity } : {}),
			...(record.error ? { error: record.error } : {}),
		};
	}
}

/** The slice of OMP's provider and credential modules the dashboard uses. */
export interface AuthPlatform {
	providers(): Array<{ id: string; name: string; available: boolean; storeCredentialsAs?: string }>;
	/** Provider id a login for `providerId` stores its credentials under. */
	credentialProvider(providerId: string): string;
	pasteCodeProviders: ReadonlySet<string>;
	listAccounts(ctx: ExtensionContext, providerId: string): Promise<AuthAccount[]>;
	logout(
		ctx: ExtensionContext,
		providerId: string,
		credentialId: number,
	): Promise<{ removed: boolean; remainingSource?: string }>;
}

interface LogoutAccount {
	credentialId: number;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}

let platform: Promise<AuthPlatform> | undefined;

/**
 * Loads OMP's provider registry and logout helpers through subpath exports
 * (`pi-ai/oauth`, `slash-commands/*`), which a compiled omp binary bundles;
 * the pi-ai root export is the extension compatibility entry point.
 */
export function loadAuthPlatform(): Promise<AuthPlatform> {
	platform ??= (async () => {
		const [oauth, ai, logout] = await Promise.all([
			import("@oh-my-pi/pi-ai/oauth") as unknown as Promise<{
				getOAuthProviders(): Array<{ id: string; name: string; available: boolean; storeCredentialsAs?: string }>;
				getOAuthCredentialProvider(providerId: string): string;
			}>,
			import("@oh-my-pi/pi-ai") as unknown as Promise<{ PASTE_CODE_LOGIN_PROVIDERS: ReadonlySet<string> }>,
			import("@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout") as unknown as Promise<{
				listLogoutAccounts(authStorage: unknown, providerId: string, sessionId: string): Promise<LogoutAccount[]>;
				logoutCredential(
					modelRegistry: unknown,
					providerId: string,
					credentialId: number,
					sessionId: string,
				): Promise<{ removed: boolean; remainingSource?: string }>;
			}>,
		]);
		return {
			providers: () => oauth.getOAuthProviders(),
			credentialProvider: (providerId) => oauth.getOAuthCredentialProvider(providerId),
			pasteCodeProviders: ai.PASTE_CODE_LOGIN_PROVIDERS,
			async listAccounts(ctx, providerId) {
				const accounts = await logout.listLogoutAccounts(
					ctx.modelRegistry.authStorage,
					providerId,
					ctx.sessionManager.getSessionId(),
				);
				return accounts.map(({ credentialId, label, detail, type, active }) => ({
					credentialId,
					label,
					detail,
					type,
					active,
				}));
			},
			logout: (ctx, providerId, credentialId) =>
				logout.logoutCredential(ctx.modelRegistry, providerId, credentialId, ctx.sessionManager.getSessionId()),
		};
	})().catch((error: unknown) => {
		platform = undefined;
		throw error;
	});
	return platform;
}
