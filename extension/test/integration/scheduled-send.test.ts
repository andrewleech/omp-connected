import { afterEach, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** The access level this session's own Collab host entry publishes. */
let access: "view" | "control" = "control";

mock.module("../../src/collab-registry.js", () => ({
	getCollabRegistry: async () => ({
		listCollabHosts: async () => [{ instanceId: "inst-1", pid: process.pid, access }],
	}),
}));

// Imported after mock.module so index.ts binds the stubbed Collab registry.
const { registerOmpConnected } = await import("../../src/index.js");

type Handler = (event?: unknown, ctx?: unknown) => unknown;
type Reply = { id: string; result?: unknown; error?: { code: number; message: string } };

const servers: ReturnType<typeof Bun.serve>[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
const savedEnv = { url: process.env.OMP_HUB_URL, token: process.env.OMP_HUB_HOST_TOKEN };

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const server of servers.splice(0)) server.stop(true);
	process.env.OMP_HUB_URL = savedEnv.url;
	process.env.OMP_HUB_HOST_TOKEN = savedEnv.token;
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("omp-connected.process-hub")];
	access = "control";
});

/**
 * One registered owner session behind a fake hub. `push` sends the extension
 * a hub request and resolves with its reply; `sent` records each
 * sendUserMessage call and `notices` each TUI notification.
 */
async function ownerSession(options: { idle: boolean }) {
	let hubSocket: { send(data: string): void } | undefined;
	const registered = Promise.withResolvers<void>();
	const replies = new Map<string, (reply: Reply) => void>();
	const server = Bun.serve({
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(socket, message) {
				const frame = JSON.parse(String(message)) as Reply & { method?: string };
				if (frame.method === "agent.register") {
					hubSocket = socket;
					socket.send(
						JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { ok: true, agent: { id: "host:inst-1" } } }),
					);
					registered.resolve();
					return;
				}
				replies.get(frame.id)?.(frame);
			},
		},
	});
	servers.push(server);
	process.env.OMP_HUB_URL = `http://localhost:${server.port}`;
	process.env.OMP_HUB_HOST_TOKEN = "secret-token";

	const handlers = new Map<string, Handler>();
	const sent: { text: string; options: unknown }[] = [];
	const notices: { message: string; type: string }[] = [];
	let onSent: () => void = () => undefined;
	let onNotice: () => void = () => undefined;
	const anyType = new Proxy({}, { get: () => () => ({}) });
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: () => undefined,
		registerMessageRenderer: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: (text: string, options?: unknown) => {
			sent.push({ text, options });
			onSent();
		},
		logger: { warn: () => undefined },
		typebox: { Type: anyType },
	};
	const ctx = {
		hasUI: true,
		isIdle: () => options.idle,
		ui: {
			setStatus: () => undefined,
			notify: (message: string, type: string) => {
				notices.push({ message, type });
				onNotice();
			},
		},
	};
	registerOmpConnected(pi as unknown as ExtensionAPI);
	await handlers.get("session_start")?.({}, ctx);
	await registered.promise;
	cleanups.push(async () => handlers.get("session_shutdown")?.());

	let nextId = 0;
	return {
		sent,
		notices,
		emit: async (event: string) => handlers.get(event)?.({}, ctx),
		push(method: string, params: unknown): Promise<Reply> {
			const id = `hub-${++nextId}`;
			const reply = new Promise<Reply>((resolve) => replies.set(id, resolve));
			hubSocket?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
			return reply;
		},
		nextSend: () => new Promise<void>((resolve) => (onSent = resolve)),
		nextNotice: () => new Promise<void>((resolve) => (onNotice = resolve)),
	};
}

test("a due prompt on an idle session is sent as a plain prompt, which starts a turn", async () => {
	const session = await ownerSession({ idle: true });
	const delivered = session.nextSend();
	const reply = await session.push("session.schedule_prompt", { text: "run the tests", delayMs: 0 });
	expect(reply.result).toMatchObject({ text: "run the tests" });
	await delivered;
	expect(session.sent).toEqual([{ text: "run the tests", options: undefined }]);
});

test("a due prompt on a busy session queues behind the current turn", async () => {
	const session = await ownerSession({ idle: false });
	const delivered = session.nextSend();
	await session.push("session.schedule_prompt", { text: "then this", delayMs: 0 });
	await delivered;
	expect(session.sent).toEqual([{ text: "then this", options: { deliverAs: "followUp" } }]);
});

test("a prompt whose session is no longer shared with control is dropped, not sent", async () => {
	const session = await ownerSession({ idle: true });
	// Warm the gate's cached "control" with one prompt, then revoke it: the
	// gate still accepts the next prompt, and only the fresh check made when
	// that one falls due sees the change.
	await session.push("session.schedule_prompt", { text: "much later", delayMs: 60_000 });
	access = "view";
	const reported = session.nextNotice();
	const reply = await session.push("session.schedule_prompt", { text: "rm -rf later", delayMs: 0 });
	expect(reply.error).toBeUndefined();
	await reported;
	expect(session.sent).toEqual([]);
	expect(session.notices).toEqual([
		{
			message:
				"omp-connected: a scheduled prompt could not be sent: the session is no longer shared with control access, so it was dropped",
			type: "error",
		},
	]);
});

test("switching the session to another conversation drops what was waiting", async () => {
	const session = await ownerSession({ idle: true });
	await session.push("session.schedule_prompt", { text: "for the old conversation", delayMs: 60_000 });
	await session.emit("session_switch");
	expect((await session.push("session.scheduled", {})).result).toEqual({ prompts: [] });
	expect(session.notices).toEqual([
		{ message: "omp-connected: 1 scheduled prompt was dropped because the session was switched", type: "warning" },
	]);
});
