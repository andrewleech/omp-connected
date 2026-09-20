import type { ServerWebSocket } from "bun";
import { afterEach, expect, test } from "bun:test";
import { HubTransport } from "../../src/hub-transport.js";

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function startHub(onMessage: (socket: ServerWebSocket<unknown>, request: Record<string, unknown>) => void) {
	const server = Bun.serve({
		port: 0,
		fetch(request, server) {
			if (new URL(request.url).pathname === "/ws/agent" && server.upgrade(request)) return;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(socket, message) {
				onMessage(socket, JSON.parse(String(message)) as Record<string, unknown>);
			},
		},
	});
	servers.push(server);
	return server;
}

function respond(socket: ServerWebSocket<unknown>, id: unknown, result: unknown) {
	socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

test("register() sends the shared token and resolves the server's agent summary", async () => {
	let socket: ServerWebSocket<unknown> | undefined;
	const hub = startHub((client, request) => {
		socket = client;
		expect(request.method).toBe("agent.register");
		const params = request.params as Record<string, unknown>;
		expect(params.token).toBe("secret-token");
		respond(client, request.id, {
			ok: true,
			agent: { id: "user@hub-host:inst-1", hostId: "user@hub-host", instanceId: "inst-1", label: "api" },
		});
	});
	const transport = new HubTransport(`http://localhost:${hub.port}`, "secret-token", () => undefined);

	const result = await transport.register({ hostId: "user@hub-host", instanceId: "inst-1", pid: 4242, cwd: "/tmp/test" });
	expect(result.agent.id).toBe("user@hub-host:inst-1");
	expect(socket).toBeDefined();
	transport.close();
});

test("a server-pushed agent.message request is delivered inbound and acked", async () => {
	let socket: ServerWebSocket<unknown> | undefined;
	const acks: unknown[] = [];
	const hub = startHub((client, request) => {
		socket = client;
		if (request.method === "agent.register") {
			respond(client, request.id, { ok: true, agent: { id: "a" } });
			return;
		}
		if (request.id === "msg-1" && "result" in request) acks.push(request.result);
	});
	const inbound: string[] = [];
	const transport = new HubTransport(`http://localhost:${hub.port}`, "secret-token", (message) =>
		inbound.push(message.content),
	);
	await transport.register({ hostId: "user@hub-host", instanceId: "inst-1", pid: 4242, cwd: "/tmp/test" });

	socket?.send(
		JSON.stringify({
			jsonrpc: "2.0",
			id: "msg-1",
			method: "agent.message",
			params: {
				messageId: "msg-1",
				from: "peer:user@hub-host",
				to: "user@hub-host:inst-1",
				type: "message",
				content: "hello",
				timestamp: "2026-09-20T00:00:00Z",
			},
		}),
	);

	for (let attempt = 0; attempt < 10 && (inbound.length === 0 || acks.length === 0); attempt += 1) {
		await Bun.sleep(10);
	}
	expect(inbound).toEqual(["hello"]);
	expect(acks).toEqual([{ received: true }]);
	transport.close();
});

test("transport rejects pending work on close and reconnects through a new socket", async () => {
	let connections = 0;
	const hub = startHub((socket, request) => {
		connections += 1;
		if (connections === 1 && request.method === "agent.send") return; // drop the first send, simulating a stall
		respond(socket, request.id, { connection: connections });
	});
	const transport = new HubTransport(`http://localhost:${hub.port}`, "secret-token", () => undefined);

	const pending = transport.request("agent.send", { to: "peer", content: "wait", idempotencyKey: "k1" });
	await Bun.sleep(20);
	transport.close();
	await expect(pending).rejects.toThrow("transport closed");
	expect(await transport.request("agent.register", { hostId: "a", instanceId: "b", pid: 1, token: "t" })).toEqual({
		connection: 2,
	});
	transport.close();
});

test("a JSON-RPC error response rejects the pending request with its message", async () => {
	const hub = startHub((socket, request) => {
		socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "invalid token" } }));
	});
	const transport = new HubTransport(`http://localhost:${hub.port}`, "wrong-token", () => undefined);

	await expect(transport.register({ hostId: "user@hub-host", instanceId: "inst-1", pid: 1, cwd: "/tmp" })).rejects.toThrow(
		"invalid token",
	);
	transport.close();
});

test("a server-pushed collab.list request is answered with the registry result", async () => {
	let socket: ServerWebSocket<unknown> | undefined;
	const collabReplies: unknown[] = [];
	const hub = startHub((client, request) => {
		socket = client;
		if (request.method === "agent.register") {
			respond(client, request.id, { ok: true, agent: { id: "a" } });
			return;
		}
		// Capture collab reply frames
		if ("result" in request || "error" in request) collabReplies.push(request);
	});
	const transport = new HubTransport(`http://localhost:${hub.port}`, "secret-token", () => undefined);
	await transport.register({ hostId: "user@hub-host", instanceId: "inst-1", pid: 4242, cwd: "/tmp/test" });

	// Push a collab.list request — the transport answers via the
	// collab-registry helper. The registry is importable in this workspace
	// (node_modules has @oh-my-pi/pi-coding-agent), so we get a result
	// with a sessions array (empty — no OMP host is actually running).
	socket?.send(
		JSON.stringify({ jsonrpc: "2.0", id: "collab-1", method: "collab.list", params: {} }),
	);

	for (let attempt = 0; attempt < 20 && collabReplies.length === 0; attempt += 1) {
		await Bun.sleep(10);
	}
	expect(collabReplies).toHaveLength(1);
	const reply = collabReplies[0] as Record<string, unknown>;
	expect(reply.id).toBe("collab-1");
	expect(reply).toHaveProperty("result");
	const result = reply.result as { sessions: unknown[] };
	expect(Array.isArray(result.sessions)).toBe(true);
	transport.close();
});

test("a server-pushed collab.link request with invalid params returns an error", async () => {
	let socket: ServerWebSocket<unknown> | undefined;
	const collabReplies: unknown[] = [];
	const hub = startHub((client, request) => {
		socket = client;
		if (request.method === "agent.register") {
			respond(client, request.id, { ok: true, agent: { id: "a" } });
			return;
		}
		if ("result" in request || "error" in request) collabReplies.push(request);
	});
	const transport = new HubTransport(`http://localhost:${hub.port}`, "secret-token", () => undefined);
	await transport.register({ hostId: "user@hub-host", instanceId: "inst-1", pid: 4242, cwd: "/tmp/test" });

	// Push collab.link with missing params — should get an error back
	socket?.send(
		JSON.stringify({ jsonrpc: "2.0", id: "link-1", method: "collab.link", params: { instanceId: "x" } }),
	);

	for (let attempt = 0; attempt < 20 && collabReplies.length === 0; attempt += 1) {
		await Bun.sleep(10);
	}
	expect(collabReplies).toHaveLength(1);
	const reply = collabReplies[0] as Record<string, unknown>;
	expect(reply.id).toBe("link-1");
	expect(reply).toHaveProperty("error");
	transport.close();
});