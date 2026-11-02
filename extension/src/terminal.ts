import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";

export const TERMINAL_FEATURE = "terminal.v1";

interface TerminalHandle {
	write(data: string | Uint8Array): void;
	resize(cols: number, rows: number): void;
	close(): void;
}
interface Child {
	terminal: TerminalHandle;
	exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
}
interface TerminalRequest { ticket?: unknown; relayUrl?: unknown; clientOrigin?: unknown }
interface Peer {
	ready(): boolean;
	bufferedAmount(): number;
	send(data: Uint8Array): void;
	close(): void;
	onFrame(handler: (data: Uint8Array) => void): void;
}
interface DirectData { ticket?: string; hello?: boolean; pendingHello?: boolean; helloTimer?: ReturnType<typeof setTimeout>; server?: DirectServer }
type DirectServer = Server<DirectData>;
interface CapabilityGroup {
	expiresAt: number;
	claimed: boolean;
	clientOrigin?: string;
	tickets: Set<string>;
	closeRelay?: () => void;
}
interface Capability { group: CapabilityGroup; audience: "relay" | "direct" }

const CAPABILITY_TTL_MS = 35_000;
const MAX_UNACKED_BYTES = 128 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_OUTPUT_FRAME = 16 * 1024;
const BATCH_MS = 12;
const RENEW_MS = 24 * 60 * 60 * 1000;

const MAX_UNAUTHENTICATED_CONNECTIONS = 64;
const HELLO_TIMEOUT_MS = 5_000;

function frame(type: number, body?: Uint8Array): Uint8Array {
	const out = new Uint8Array(1 + (body?.byteLength ?? 0));
	out[0] = type;
	if (body) out.set(body, 1);
	return out;
}

function tmuxEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
	delete env.TMUX;
	delete env.TMUX_PANE;
	return env;
}

/** Owns the capability table and TLS listener for one tmux-backed session. */
export class TerminalService {
	readonly #tmuxSocket: string;
	readonly #capabilities = new Map<string, Capability>();
	readonly #active = new Set<() => void>();
	readonly #claimed = new Set<string>();
	readonly #directSessions = new Map<string, { input(data: Uint8Array): void; close(): void }>();
	#directServer: DirectServer | undefined;
	#directUrl: string | undefined;
	#directCertExpiresAt: number | undefined;
	#directTlsFingerprint: string | undefined;
	readonly #directServerConnections = new Map<DirectServer, number>();
	readonly #drainingDirectServers = new Set<DirectServer>();
	#pendingDirectHello = 0;
	#certDir: string | undefined;
	#renewTimer: ReturnType<typeof setTimeout> | undefined;
	#directAttempt: Promise<string | undefined> | undefined;
	#directOrigin: string | undefined;
	#closed = false;

	constructor(tmuxSocket: string) { this.#tmuxSocket = tmuxSocket; }
	prepareDirect(): void { void this.#startDirect(); }

	#expireDirectCertificate(): boolean {
		if (this.#directCertExpiresAt === undefined || this.#directCertExpiresAt > Date.now()) return false;
		this.#directCertExpiresAt = undefined;
		this.#directTlsFingerprint = undefined;
		this.#directUrl = undefined;
		clearTimeout(this.#renewTimer);
		this.#renewTimer = undefined;
		this.#retireDirectServer();
		return true;
	}

	#retireDirectServer(): void {
		const server = this.#directServer;
		if (!server) return;
		this.#directServer = undefined;
		server.stop();
		if ((this.#directServerConnections.get(server) ?? 0) > 0) this.#drainingDirectServers.add(server);
		else server.stop(true);
	}

	async #runTailscale(args: string[], timeoutMs = 4_000): Promise<{ code: number; stdout: string }> {
		const child = Bun.spawn(["tailscale", ...args], { stdout: "pipe", stderr: "ignore" });
		const timeout = setTimeout(() => child.kill(), timeoutMs);
		const stdout = await new Response(child.stdout).text();
		const code = await child.exited;
		clearTimeout(timeout);
		return { code, stdout };
	}

	#startDirect(): Promise<string | undefined> {
		if (this.#directAttempt) return this.#directAttempt;
		const attempt = this.#startDirectNow().finally(() => {
			if (this.#directAttempt === attempt) this.#directAttempt = undefined;
		});
		this.#directAttempt = attempt;
		return attempt;
	}

	async #startDirectNow(): Promise<string | undefined> {
		const hubUrl = process.env.OMP_HUB_URL;
		if (!hubUrl || this.#closed) return undefined;
		this.#expireDirectCertificate();
		if (this.#directUrl && this.#renewTimer) return this.#directUrl;
		try {
			const hub = new URL(hubUrl);
			if (hub.protocol === "wss:") hub.protocol = "https:";
			else if (hub.protocol === "ws:") hub.protocol = "http:";
			const hubOrigin = hub.origin;
			const status = await this.#runTailscale(["status", "--json"]);
			if (this.#closed) return undefined;
			if (status.code !== 0) { this.#scheduleRenewal(); return undefined; }
			const parsed = JSON.parse(status.stdout) as { Self?: { DNSName?: string } };
			const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
			if (!dnsName || !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(dnsName)) { this.#scheduleRenewal(); return undefined; }
			this.#directOrigin = hubOrigin;
			if (!this.#certDir) {
				const certDir = await mkdtemp(join(tmpdir(), "omp-terminal-tls-"));
				if (this.#closed) { void rm(certDir, { recursive: true, force: true }); return undefined; }
				this.#certDir = certDir;
			}
			const certPath = join(this.#certDir, "terminal.crt");
			const keyPath = join(this.#certDir, "terminal.key");
			const issued = await this.#runTailscale(["cert", "--cert-file", certPath, "--key-file", keyPath, dnsName], 30_000);
			if (this.#closed) return undefined;
			if (issued.code !== 0) { this.#scheduleRenewal(); return undefined; }
			const cert = await readFile(certPath, "utf8");
			if (this.#closed) return undefined;
			const key = await readFile(keyPath, "utf8");
			if (this.#closed) return undefined;
			const certificate = new X509Certificate(cert);
			const certExpiresAt = certificate.validToDate.getTime();
			if (!certificate.checkHost(dnsName) || !Number.isFinite(certExpiresAt) || certExpiresAt <= Date.now()) { this.#expireDirectCertificate(); this.#scheduleRenewal(); return undefined; }
			const tlsFingerprint = createHash("sha256").update(cert).update("\0").update(key).digest("hex");
			if (this.#directServer && tlsFingerprint !== this.#directTlsFingerprint) {
				this.#directUrl = undefined;
				this.#retireDirectServer();
			}
			if (!this.#directServer) {
				const server = Bun.serve<DirectData>({
					hostname: "0.0.0.0",
					port: 0,
					tls: { cert, key },
					fetch: (request, instance) => {
						const url = new URL(request.url);
						const origin = request.headers.get("origin");
						const originAllowed = origin === this.#directOrigin || [...this.#capabilities.values()].some(({ group }) => group.clientOrigin === origin && group.expiresAt > Date.now());
						if (url.pathname !== "/terminal" || !originAllowed) return new Response("forbidden", { status: 403 });
						if (this.#pendingDirectHello >= MAX_UNAUTHENTICATED_CONNECTIONS) return new Response("terminal connection limit reached", { status: 429 });
						const server = instance as DirectServer;
						const data: DirectData = { pendingHello: true, server };
						if (!instance.upgrade(request, { data })) return new Response("websocket upgrade required", { status: 426 });
						this.#pendingDirectHello++;
						this.#directServerConnections.set(server, (this.#directServerConnections.get(server) ?? 0) + 1);
						return undefined;
					},
					websocket: {
						maxPayloadLength: 64 * 1024,
						backpressureLimit: MAX_PENDING_BYTES,
						closeOnBackpressureLimit: true,
						idleTimeout: 60,
						perMessageDeflate: true,
						open: (socket) => {
							if (!socket.data.pendingHello) return;
							socket.data.helloTimer = setTimeout(() => {
								this.#releaseDirectHello(socket);
								socket.close(4003, "terminal hello timed out");
							}, HELLO_TIMEOUT_MS);
							socket.data.helloTimer.unref?.();
						},
						message: (socket, message) => this.#directMessage(socket, message),
						close: (socket) => this.#directClose(socket),
					},
				});
				this.#directServer = server;
				this.#directUrl = `wss://${dnsName}:${server.port}/terminal`;
			}
			this.#directTlsFingerprint = tlsFingerprint;
			this.#directCertExpiresAt = certExpiresAt;
			this.#scheduleRenewal();
			return this.#directUrl;
		} catch {
			this.#scheduleRenewal();
			return this.#directUrl;
		}
	}

	#scheduleRenewal(): void {
		if (this.#renewTimer || this.#closed) return;
		this.#renewTimer = setTimeout(() => {
			this.#renewTimer = undefined;
			void this.#startDirect();
		}, RENEW_MS);
		this.#renewTimer.unref?.();
	}

	#claim(ticket: string, audience: Capability["audience"]): boolean {
		const capability = this.#capabilities.get(ticket);
		if (!capability || capability.audience !== audience) return false;
		const { group } = capability;
		if (group.claimed || group.expiresAt <= Date.now() || this.#claimed.size >= 4) return false;
		group.claimed = true;
		this.#claimed.add(ticket);
		for (const alias of group.tickets) {
			if (this.#capabilities.get(alias)?.group === group) this.#capabilities.delete(alias);
		}
		if (audience === "direct") group.closeRelay?.();
		return true;
	}

	#release(ticket: string): void { this.#claimed.delete(ticket); }

	async open(params: unknown): Promise<{ ok: true; directUrl?: string; directTicket?: string }> {
		const request = params as TerminalRequest;
		if (this.#closed || typeof request?.ticket !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(request.ticket) || typeof request.relayUrl !== "string") throw new Error("invalid terminal open request");
		let relayUrl = new URL(request.relayUrl);
		if (relayUrl.protocol !== "wss:" && relayUrl.protocol !== "ws:") throw new Error("invalid terminal relay URL");
		const hubUrl = process.env.OMP_HUB_URL;
		if (hubUrl && typeof request.clientOrigin === "string") {
			relayUrl = new URL(hubUrl);
			if (relayUrl.protocol === "https:") relayUrl.protocol = "wss:";
			else if (relayUrl.protocol === "http:") relayUrl.protocol = "ws:";
			relayUrl.pathname = `${relayUrl.pathname.replace(/\/$/, "")}/ws/terminal/host`;
			relayUrl.search = "";
			relayUrl.hash = "";
		}
		if (this.#expireDirectCertificate() || !this.#directUrl) void this.#startDirect();
		const ticket = request.ticket;
		const expiresAt = Date.now() + CAPABILITY_TTL_MS;
		const directUrl = this.#directUrl;
		const directTicket = directUrl ? randomBytes(32).toString("base64url") : undefined;
		const group: CapabilityGroup = {
			expiresAt,
			claimed: false,
			tickets: new Set([ticket]),
			...(typeof request.clientOrigin === "string" ? { clientOrigin: request.clientOrigin } : {}),
		};
		this.#capabilities.set(ticket, { group, audience: "relay" });
		if (directTicket) {
			group.tickets.add(directTicket);
			this.#capabilities.set(directTicket, { group, audience: "direct" });
		}
		const expiry = setTimeout(() => {
			for (const alias of group.tickets) {
				if (this.#capabilities.get(alias)?.group === group) this.#capabilities.delete(alias);
			}
		}, CAPABILITY_TTL_MS);
		expiry.unref?.();
		const socket = new WebSocket(relayUrl);
		socket.binaryType = "arraybuffer";
		let stopped = false;
		let attached = false;
		let claimed = false;
		let child: Child | undefined;
		let outstanding = 0;
		let pendingBytes = 0;
		const chunks: Uint8Array[] = [];
		let batchTimer: ReturnType<typeof setTimeout> | undefined;
		let cleanup = () => {};

		const stop = (closeSocket = true) => {
			if (stopped) return;
			stopped = true;
			if (claimed) { this.#release(ticket); claimed = false; }
			child?.terminal.close();
			child?.kill();
			this.#active.delete(cleanup);
			if (closeSocket && socket.readyState < WebSocket.CLOSING) socket.close();
		};

		const flush = () => {
			batchTimer = undefined;
			if (stopped || !attached || !chunks.length) return;
			while (chunks.length && outstanding < MAX_UNACKED_BYTES) {
				const size = Math.min(MAX_OUTPUT_FRAME, pendingBytes, MAX_UNACKED_BYTES - outstanding);
				const body = new Uint8Array(size);
				let offset = 0;
				while (offset < size) {
					const part = chunks[0]!;
					const copied = Math.min(part.byteLength, size - offset);
					body.set(part.subarray(0, copied), offset);
					offset += copied;
					if (copied === part.byteLength) chunks.shift();
					else chunks[0] = part.subarray(copied);
				}
				if (socket.bufferedAmount > MAX_PENDING_BYTES) { stop(); return; }
				socket.send(frame(1, body));
				outstanding += size;
				pendingBytes -= size;
			}
		};

		const enqueue = (data: Uint8Array) => {
			if (stopped || !data.byteLength) return;
			chunks.push(new Uint8Array(data));
			pendingBytes += data.byteLength;
			if (pendingBytes > MAX_PENDING_BYTES) { stop(); return; }
			if (pendingBytes >= MAX_OUTPUT_FRAME) flush();
			if (!batchTimer) batchTimer = setTimeout(flush, BATCH_MS);
		};

		const startChild = () => {
			if (child || stopped) return;
			const spawn = Bun.spawn as unknown as (command: string[], options: { terminal: { cols: number; rows: number; data(terminal: TerminalHandle, data: Uint8Array): void }; env: NodeJS.ProcessEnv }) => Child;
			const env = tmuxEnvironment();
			child = spawn(["tmux", "-L", this.#tmuxSocket, "attach-session"], {
				terminal: { cols: 80, rows: 24, data: (_terminal, data) => enqueue(data) },
				env,
			});
			void child.exited.then((code) => {
				flush();
				if (stopped) return;
				if (socket.readyState === WebSocket.OPEN) {
					const body = new Uint8Array(2);
					new DataView(body.buffer).setInt16(0, code, false);
					socket.send(frame(5, body));
				}
				stop();
			});
		};

		const onFrame = (data: Uint8Array) => {
			if (!attached) {
				if (!this.#claim(ticket, "relay")) { stop(); return; }
				claimed = true;
				attached = true;
				try { startChild(); }
				catch { stop(); }
				return;
			}
			if (data[0] === 2 && child) child.terminal.write(data.subarray(1));
			else if (data[0] === 3 && data.byteLength === 5 && child) {
				const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
				child.terminal.resize(Math.max(1, view.getUint16(1, false)), Math.max(1, view.getUint16(3, false)));
			} else if (data[0] === 4 && data.byteLength === 5) {
				outstanding = Math.max(0, outstanding - new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, false));
				flush();
			} else if (data[0] === 5) stop();
			else stop();
		};

		socket.addEventListener("open", () => {
			const body = new TextEncoder().encode(ticket);
			socket.send(frame(0, new Uint8Array([1, ...body])));
		});
		socket.addEventListener("message", (event) => {
			if (!(event.data instanceof ArrayBuffer)) { stop(); return; }
			onFrame(new Uint8Array(event.data));
		});
		socket.addEventListener("close", () => stop(false));
		socket.addEventListener("error", () => stop());

		cleanup = () => stop();
		group.closeRelay = cleanup;
		this.#active.add(cleanup);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timeout = setTimeout(() => reject(new Error("terminal relay connection timed out")), 5_000);
		socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
		socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("terminal relay connection failed")); }, { once: true });
		try { await promise; }
		catch (error) { cleanup(); throw error; }
		return { ok: true, ...(directUrl ? { directUrl, directTicket } : {}) };
	}

	#releaseDirectHello(socket: ServerWebSocket<DirectData>): void {
		if (!socket.data.pendingHello) return;
		socket.data.pendingHello = false;
		clearTimeout(socket.data.helloTimer);
		socket.data.helloTimer = undefined;
		this.#pendingDirectHello--;
	}

	#directMessage(socket: ServerWebSocket<DirectData>, message: string | Uint8Array): void {
		this.#releaseDirectHello(socket);
		if (typeof message === "string") { socket.close(1003, "binary frames required"); return; }
		const data = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
		if (!socket.data.hello) {
			if (data[0] !== 0 || data[1] !== 1) { socket.close(4003, "terminal hello required"); return; }
			let ticket: string;
			try { ticket = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(2)); }
			catch { socket.close(4003, "invalid terminal ticket"); return; }
			if (this.#directSessions.size >= 4 || !this.#claim(ticket, "direct")) { socket.close(4003, "invalid terminal ticket"); return; }
			socket.data.ticket = ticket;
			socket.data.hello = true;
			socket.send(new Uint8Array([0, 1, 0]));
			try { this.#attachDirect(socket, ticket); }
			catch {
				this.#release(ticket);
				socket.close(1011, "terminal attach failed");
			}
			return;
		}
		this.#directInput(socket, data);
	}

	#attachDirect(socket: ServerWebSocket<DirectData>, ticket: string): void {
		let child: Child | undefined;
		let stopped = false;
		let outstanding = 0;
		let pendingBytes = 0;
		const chunks: Uint8Array[] = [];
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cleanup = () => {};
		const stop = (exitCode?: number) => {
			if (stopped) return;
			if (exitCode !== undefined) flush();
			if (stopped) return;
			stopped = true;
			clearTimeout(timer);
			this.#release(ticket);
			this.#directSessions.delete(ticket);
			this.#active.delete(cleanup);
			if (exitCode !== undefined && socket.readyState === WebSocket.OPEN) {
				const body = new Uint8Array(2);
				new DataView(body.buffer).setInt16(0, exitCode, false);
				socket.send(frame(5, body));
			}
			child?.terminal.close();
			child?.kill();
			if (socket.readyState < WebSocket.CLOSING) socket.close();
		};
		const flush = () => {
			timer = undefined;
			while (!stopped && chunks.length && outstanding < MAX_UNACKED_BYTES) {
				const size = Math.min(MAX_OUTPUT_FRAME, pendingBytes, MAX_UNACKED_BYTES - outstanding);
				const body = new Uint8Array(size);
				let offset = 0;
				while (offset < size) {
					const part = chunks[0]!;
					const copied = Math.min(part.byteLength, size - offset);
					body.set(part.subarray(0, copied), offset);
					offset += copied;
					if (copied === part.byteLength) chunks.shift(); else chunks[0] = part.subarray(copied);
				}
				if (socket.getBufferedAmount() > MAX_PENDING_BYTES) { stop(); return; }
				socket.send(frame(1, body), true);
				pendingBytes -= size;
				outstanding += size;
			}
		};
		const enqueue = (data: Uint8Array) => {
			if (stopped || !data.byteLength) return;
			chunks.push(new Uint8Array(data));
			pendingBytes += data.byteLength;
			if (pendingBytes > MAX_PENDING_BYTES) { stop(); return; }
			if (pendingBytes >= MAX_OUTPUT_FRAME) flush();
			if (!timer) timer = setTimeout(flush, BATCH_MS);
		};
		const input = (data: Uint8Array) => {
			if (data[0] === 2 && child) child.terminal.write(data.subarray(1));
			else if (data[0] === 3 && data.byteLength === 5 && child) {
				const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
				child.terminal.resize(Math.max(1, view.getUint16(1, false)), Math.max(1, view.getUint16(3, false)));
			} else if (data[0] === 4 && data.byteLength === 5) {
				outstanding = Math.max(0, outstanding - new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, false));
				flush();
			} else stop();
		};
		const spawn = Bun.spawn as unknown as (command: string[], options: { terminal: { cols: number; rows: number; data(terminal: TerminalHandle, data: Uint8Array): void }; env: NodeJS.ProcessEnv }) => Child;
		const env = tmuxEnvironment();
		child = spawn(["tmux", "-L", this.#tmuxSocket, "attach-session"], { terminal: { cols: 80, rows: 24, data: (_terminal, data) => enqueue(data) }, env });
		void child.exited.then((code) => stop(code));
		cleanup = () => stop();
		this.#directSessions.set(ticket, { input, close: cleanup });
		this.#active.add(cleanup);
	}

	#directInput(socket: ServerWebSocket<DirectData>, data: Uint8Array): void {
		const ticket = socket.data.ticket;
		const session = ticket ? this.#directSessions.get(ticket) : undefined;
		if (!session) { socket.close(4003, "terminal is not attached"); return; }
		const type = data[0];
		if ((type !== 2 && type !== 3 && type !== 4) || (type === 3 && data.byteLength !== 5) || (type === 4 && data.byteLength !== 5)) {
			socket.close(4003, "invalid terminal frame");
			session.close();
			return;
		}
		session.input(data);
	}

	#directClose(socket: ServerWebSocket<DirectData>): void {
		this.#releaseDirectHello(socket);
		if (socket.data.ticket) {
			const ticket = socket.data.ticket;
			this.#directSessions.get(ticket)?.close();
		}
		const server = socket.data.server;
		socket.data.server = undefined;
		if (server) {
			const count = this.#directServerConnections.get(server) ?? 0;
			if (count > 1) this.#directServerConnections.set(server, count - 1);
			else {
				this.#directServerConnections.delete(server);
				if (this.#drainingDirectServers.delete(server)) server.stop(true);
			}
		}
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#renewTimer);
		for (const close of this.#active) close();
		this.#active.clear();
		this.#directServer?.stop(true);
		this.#directServer = undefined;
		for (const server of this.#drainingDirectServers) server.stop(true);
		this.#drainingDirectServers.clear();
		this.#directServerConnections.clear();
		const certDir = this.#certDir;
		this.#directCertExpiresAt = undefined;
		this.#directTlsFingerprint = undefined;
		this.#certDir = undefined;
		if (certDir) {
			if (this.#directAttempt) void this.#directAttempt.finally(() => rm(certDir, { recursive: true, force: true }));
			else void rm(certDir, { recursive: true, force: true });
		}
		this.#capabilities.clear();
	}
}
