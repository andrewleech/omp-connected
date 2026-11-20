// Worker-side client for the hub's transfer routes. Hub outages never abort a
// transfer: events queue in memory and flush in order when the hub answers,
// and command polling returns nothing while the hub is unreachable.

import type { TransferState } from "./journal.js";

export interface HubEvent {
	state: TransferState;
	detail?: string;
	error?: { code: string; message: string };
	progress?: Record<string, unknown>;
}

export interface HubCommand {
	seq: number;
	type: "cancel" | "recover";
	payload: Record<string, unknown>;
}

export interface HubTransferClient {
	/** False for the no-op client used when no hub is configured. */
	readonly enabled: boolean;
	/** Events waiting for the hub. */
	readonly queued: number;
	/** Queues the event and tries to deliver the queue. Never throws. */
	event(event: HubEvent): Promise<void>;
	/** Unacknowledged commands in order; empty while the hub is unreachable. Never throws. */
	commands(): Promise<HubCommand[]>;
	/** Marks a command handled. Never throws. */
	ack(seq: number): Promise<void>;
	/** Delivers queued events and revokes the renewal secret. Never throws. */
	finish(): Promise<void>;
}

export interface HubClientOptions {
	hubUrl: string;
	operationId: string;
	token: string;
	renewalSecret: string;
	fetch?: typeof fetch;
	/** Extra attempts per call after a network error or 5xx/429. Default 2. */
	retries?: number;
	backoffMs?: number;
	/** After a call exhausts its attempts the hub is not contacted again for this long. Default 15 s. */
	breakerMs?: number;
	requestTimeoutMs?: number;
	maxQueued?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	log?: (message: string) => void;
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

class HubUnavailable extends Error {}

interface HubResponse {
	status: number;
	body: unknown;
}

/** A client that records nothing and reports no commands, for runs without a hub. */
export function createNoopHubClient(): HubTransferClient {
	return {
		enabled: false,
		queued: 0,
		event: async () => undefined,
		commands: async () => [],
		ack: async () => undefined,
		finish: async () => undefined,
	};
}

/** Canonical plain-object guard for the transfer worker modules. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCommands(body: unknown): HubCommand[] {
	if (!isRecord(body) || !Array.isArray(body.commands)) return [];
	const commands: HubCommand[] = [];
	for (const item of body.commands) {
		if (!isRecord(item) || !Number.isSafeInteger(item.seq) || (item.seq as number) < 1) continue;
		if (item.type !== "cancel" && item.type !== "recover") continue;
		commands.push({ seq: item.seq as number, type: item.type, payload: isRecord(item.payload) ? item.payload : {} });
	}
	return commands.sort((a, b) => a.seq - b.seq);
}

export function createHubClient(options: HubClientOptions): HubTransferClient {
	if (!OPERATION_ID.test(options.operationId)) throw new Error("invalid operation id");
	const base = `${options.hubUrl.replace(/\/+$/, "")}/api/transfers/${options.operationId}/worker`;
	const doFetch = options.fetch ?? fetch;
	const retries = options.retries ?? 2;
	const backoffMs = options.backoffMs ?? 250;
	const breakerMs = options.breakerMs ?? 15_000;
	const timeoutMs = options.requestTimeoutMs ?? 5000;
	const maxQueued = options.maxQueued ?? 500;
	const sleep = options.sleep ?? Bun.sleep;
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => undefined);

	let token = options.token;
	let renewalRevoked = false;
	let breakerUntil = 0;
	let cursor = 0;
	let finished = false;
	const queue: HubEvent[] = [];

	async function send(method: string, path: string, bearer: string, body?: unknown): Promise<HubResponse> {
		const response = await doFetch(`${base}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${bearer}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			parsed = undefined;
		}
		return { status: response.status, body: parsed };
	}

	/** Exchanges the renewal secret for a new token. False once the secret is revoked or rejected. */
	async function renew(): Promise<boolean> {
		if (renewalRevoked) return false;
		const response = await send("POST", "/renew", options.renewalSecret, {});
		if (response.status === 401) {
			renewalRevoked = true;
			log("transfer hub renewal secret rejected");
			return false;
		}
		if (response.status < 200 || response.status >= 300 || !isRecord(response.body) || typeof response.body.token !== "string") {
			throw new HubUnavailable("renew failed");
		}
		token = response.body.token;
		return true;
	}

	/** One logical call with bounded retries and a circuit breaker. Throws `HubUnavailable` when the hub cannot be used. */
	async function call(method: string, path: string, body?: unknown): Promise<HubResponse> {
		if (now() < breakerUntil) throw new HubUnavailable("hub unavailable");
		let renewed = false;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				let response = await send(method, path, token, body);
				if (response.status === 401 && !renewed) {
					const code = isRecord(response.body) ? response.body.code : undefined;
					if (code === "token-expired" || code === "token-invalid") {
						renewed = true;
						if (!(await renew())) throw new HubUnavailable("credentials revoked");
						response = await send(method, path, token, body);
					}
				}
				if (response.status === 401) throw new HubUnavailable("unauthorised");
				if (response.status >= 500 || response.status === 429) throw new HubUnavailable(`hub answered ${response.status}`);
				return response;
			} catch (error) {
				if (error instanceof HubUnavailable && /revoked|unauthorised/.test(error.message)) {
					breakerUntil = now() + breakerMs;
					throw error;
				}
				if (attempt === retries) {
					breakerUntil = now() + breakerMs;
					throw new HubUnavailable(error instanceof Error ? error.message : String(error));
				}
				await sleep(backoffMs * 2 ** attempt);
			}
		}
		throw new HubUnavailable("hub unavailable");
	}

	async function flush(): Promise<void> {
		while (queue.length > 0) {
			let response: HubResponse;
			try {
				response = await call("POST", "/events", queue[0]);
			} catch {
				return;
			}
			// A refusal other than an outage (bad body, unknown operation) will not improve on retry.
			if (response.status >= 400) log(`transfer hub refused an event (${response.status})`);
			queue.shift();
		}
	}

	return {
		enabled: true,
		get queued() {
			return queue.length;
		},
		async event(event) {
			if (finished) return;
			const last = queue.at(-1);
			if (last && !last.error && !event.error && last.state === event.state) queue[queue.length - 1] = event;
			else queue.push(event);
			while (queue.length > maxQueued) queue.shift();
			await flush();
		},
		async commands() {
			if (finished) return [];
			try {
				const response = await call("GET", `/commands?after=${cursor}`);
				return response.status === 200 ? parseCommands(response.body) : [];
			} catch {
				return [];
			}
		},
		async ack(seq) {
			cursor = Math.max(cursor, seq);
			if (finished) return;
			try {
				await call("POST", `/commands/${seq}/ack`, {});
			} catch {
				// Redelivery after a restart is harmless; handlers are idempotent.
			}
		},
		async finish() {
			if (finished) return;
			await flush();
			try {
				await call("POST", "/finish", {});
			} catch {
				log("transfer hub did not confirm finish");
			}
			finished = true;
		},
	};
}
