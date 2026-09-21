import type { AgentMessage } from "./provenance.js";
import { getCollabRegistry } from "./collab-registry.js";
import { hubWebSocketUrl, makeRequest } from "./protocol.js";

// Wire shapes from omp-hub's agent.register — kept as small local mirrors
// (this plugin and omp-hub are separate repos/packages with no shared
// dependency) rather than importing omp-hub's own types.
export interface AgentSummary {
	id: string;
	hostId: string;
	instanceId: string;
	label: string;
	cwd: string;
	pid: number;
	connectedAt: string;
	teams: string[];
}

export interface AgentRegisterResult {
	ok: true;
	agent: AgentSummary;
}

type InboundHandler = (message: AgentMessage) => void;

const REQUEST_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_FRAME_CHARS = 20_000;

export class HubTransport {
	#socket: WebSocket | undefined;
	#pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();

	constructor(
		private readonly hubUrl: string,
		private readonly token: string,
		private readonly onInbound: InboundHandler,
		private readonly onClose?: () => void,
	) {}

	/** Sends `agent.register`, injecting the shared-secret token so callers
	 *  never have to remember to attach it themselves. */
	async register(params: { hostId: string; instanceId: string; pid: number; cwd: string }): Promise<AgentRegisterResult> {
		return (await this.request("agent.register", { ...params, token: this.token })) as AgentRegisterResult;
	}

	async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		const socket = await this.connect();
		const frame = makeRequest(method, params);
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.#pending.delete(frame.id)) reject(new Error(`omp-hub request '${method}' timed out`));
			}, REQUEST_TIMEOUT_MS);
			this.#pending.set(frame.id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				socket.send(JSON.stringify(frame));
			} catch (error) {
				const pending = this.#pending.get(frame.id);
				this.#pending.delete(frame.id);
				pending?.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): void {
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.close();
		for (const pending of this.#pending.values()) pending.reject(new Error("omp-hub transport closed"));
		this.#pending.clear();
		this.onClose?.();
	}

	private async connect(): Promise<WebSocket> {
		if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
		if (this.#socket?.readyState === WebSocket.CONNECTING) {
			return this.awaitOpen(this.#socket);
		}
		const socket = new WebSocket(hubWebSocketUrl(this.hubUrl));
		this.#socket = socket;
		socket.addEventListener("message", (event) => this.handleFrame(event.data));
		socket.addEventListener("close", () => this.closeSocket(socket));
		return this.awaitOpen(socket);
	}

	private async awaitOpen(socket: WebSocket): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error("omp-hub connection timed out"));
			}, CONNECT_TIMEOUT_MS);
			const finish = (result: () => void) => {
				clearTimeout(timer);
				result();
			};
			socket.addEventListener("open", () => finish(() => resolve(socket)), { once: true });
			socket.addEventListener("error", () => finish(() => reject(new Error("omp-hub connection failed"))), {
				once: true,
			});
			socket.addEventListener("close", () => finish(() => reject(new Error("omp-hub connection closed"))), {
				once: true,
			});
		});
	}

	private closeSocket(socket: WebSocket): void {
		if (this.#socket !== socket) return;
		this.close();
	}

	/** Distinguishes a reply to one of our own requests (has `result`/`error`)
	 *  from a server-initiated push (has `method`) — omp-hub sends
	 *  `agent.message` as a JSON-RPC *request*, not a notification, so the
	 *  extension's own reply is the delivery receipt. */
	private handleFrame(raw: unknown): void {
		if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) return;
		let frame: unknown;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!frame || typeof frame !== "object") return;
		const value = frame as Record<string, unknown>;
		if (typeof value.id !== "string") return;

		if (typeof value.method === "string") {
			this.handlePush(value.id, value.method, "params" in value ? value.params : undefined);
			return;
		}

		const pending = this.#pending.get(value.id);
		if (!pending) return;
		this.#pending.delete(value.id);
		if ("result" in value) {
			pending.resolve(value.result);
			return;
		}
		if (
			"error" in value &&
			value.error &&
			typeof value.error === "object" &&
			"message" in value.error &&
			typeof (value.error as { message: unknown }).message === "string"
		) {
			pending.reject(new Error((value.error as { message: string }).message));
			return;
		}
		pending.reject(new Error("omp-hub sent a malformed response"));
	}

	private handlePush(id: string, method: string, params: unknown): void {
		if (method === "agent.message") {
			this.onInbound(params as AgentMessage);
			try {
				this.#socket?.send(JSON.stringify({ jsonrpc: "2.0", id, result: { received: true } }));
			} catch {
				// Best-effort ack; the server retains the message and redelivers
				// on reconnect if this drops.
			}
			return;
		}
		if (method === "collab.list" || method === "collab.link") {
			void this.handleCollabPush(id, method, params);
			return;
		}
	}

	private async handleCollabPush(id: string, method: string, params: unknown): Promise<void> {
		const reply = (result: unknown) => {
			try {
				this.#socket?.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
			} catch { /* best-effort */ }
		};
		const replyError = (message: string) => {
			try {
				this.#socket?.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
			} catch { /* best-effort */ }
		};

		const registry = await getCollabRegistry();
		if (!registry) return replyError("Collab registry not available");

		try {
			if (method === "collab.list") {
				const hosts = await registry.listCollabHosts();
				reply({ sessions: hosts });
				return;
			}

			// collab.link — forward to OMP's local Collab host IPC.
			const p = params as Record<string, unknown> | undefined;
			if (
				typeof p?.instanceId !== "string" ||
				typeof p?.generation !== "number" ||
				(p?.access !== "view" && p?.access !== "control")
			) return replyError("invalid Collab link request");

			const result = await registry.resolveCollabHostLink(
				p.instanceId,
				p.access as "view" | "control",
			);

			if (
				result.instanceId !== p.instanceId ||
				result.access !== p.access ||
				typeof result.url !== "string"
			) return replyError("stale or invalid Collab link response");

			reply({ access: result.access, url: result.url });
		} catch (error) {
			replyError(error instanceof Error ? error.message : String(error));
		}
	}
}