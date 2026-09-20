import { expect, test } from "bun:test";
import { hubWebSocketUrl, makeRequest } from "../../src/protocol.js";

test("hub URLs preserve a path and upgrade HTTP transport to /ws/agent", () => {
	expect(hubWebSocketUrl("https://hub.example/api")).toBe("wss://hub.example/api/ws/agent");
	expect(hubWebSocketUrl("http://localhost:4816")).toBe("ws://localhost:4816/ws/agent");
});

test("requests are framed as JSON-RPC 2.0 with a unique correlation id", () => {
	const request = makeRequest("agent.send", { to: "api:user@hub-host", content: "hello" });
	expect(request.jsonrpc).toBe("2.0");
	expect(request.method).toBe("agent.send");
	expect(request.params).toEqual({ to: "api:user@hub-host", content: "hello" });
	expect(request.id).toMatch(/^[0-9a-f-]{36}$/);
});