import { afterEach, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

mock.module("../../src/collab-registry.js", () => ({
	getCollabRegistry: async () => ({
		listCollabHosts: async () => [{ instanceId: "inst-1", pid: process.pid }],
	}),
}));

// Imported after mock.module so index.ts binds the stubbed Collab registry.
const { registerOmpConnected } = await import("../../src/index.js");

type Handler = () => unknown;
type Tool = { name: string; execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }> };

/** The slice of ExtensionAPI the extension touches, recording what it registers. */
function fakeSession() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const anyType = new Proxy({}, { get: () => () => ({}) });
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerMessageRenderer: () => undefined,
		sendMessage: () => undefined,
		logger: { warn: () => undefined },
		typebox: { Type: anyType },
	};
	registerOmpConnected(pi as unknown as ExtensionAPI);
	return {
		emit: async (event: string) => handlers.get(event)?.(),
		identity: async () => JSON.parse((await tools.get("ompc_identity")!.execute("t", {})).content[0].text),
	};
}

const servers: ReturnType<typeof Bun.serve>[] = [];
const savedEnv = { url: process.env.OMP_HUB_URL, token: process.env.OMP_HUB_HOST_TOKEN };

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	process.env.OMP_HUB_URL = savedEnv.url;
	process.env.OMP_HUB_HOST_TOKEN = savedEnv.token;
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("omp-connected.process-hub")];
});

test("a subagent in the same process shares the parent's hub registration instead of claiming it again", async () => {
	const registrations: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(socket, message) {
				const request = JSON.parse(String(message)) as { id: string; method: string; params: unknown };
				if (request.method !== "agent.register") return;
				registrations.push(request.params);
				socket.send(
					JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, agent: { id: "host:inst-1" } } }),
				);
			},
		},
	});
	servers.push(server);
	process.env.OMP_HUB_URL = `http://localhost:${server.port}`;
	process.env.OMP_HUB_HOST_TOKEN = "secret-token";

	const parent = fakeSession();
	const subagent = fakeSession();
	await parent.emit("session_start");
	await subagent.emit("session_start");

	expect(registrations).toHaveLength(1);
	expect(await subagent.identity()).toMatchObject({ registered: true, id: "host:inst-1" });

	// The subagent finishing must not tear down the parent's connection.
	await subagent.emit("session_shutdown");
	expect(await parent.identity()).toMatchObject({ registered: true });

	await parent.emit("session_shutdown");
});

test("the owning session reports turn start/end to the hub and a subagent's turns are ignored", async () => {
	const activity: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(socket, message) {
				const request = JSON.parse(String(message)) as { id: string; method: string; params: unknown };
				if (request.method === "agent.activity") activity.push(request.params);
				const result = request.method === "agent.register" ? { ok: true, agent: { id: "host:inst-1" } } : { ok: true };
				socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
			},
		},
	});
	servers.push(server);
	process.env.OMP_HUB_URL = `http://localhost:${server.port}`;
	process.env.OMP_HUB_HOST_TOKEN = "secret-token";
	const settled = () => Bun.sleep(100);

	const parent = fakeSession();
	const subagent = fakeSession();
	await parent.emit("session_start");
	await subagent.emit("session_start");
	await settled();
	expect(activity).toEqual([{ busy: false }]);

	await parent.emit("agent_start");
	await subagent.emit("agent_start");
	await subagent.emit("agent_end");
	await parent.emit("agent_end");
	await settled();
	expect(activity).toEqual([{ busy: false }, { busy: true }, { busy: false }]);

	await parent.emit("session_shutdown");
});
