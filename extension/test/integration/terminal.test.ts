import type { ServerWebSocket } from "bun";
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { TerminalService } from "../../src/terminal.js";

const tmuxAvailable = Bun.which("tmux") !== null;
let server: ReturnType<typeof Bun.serve> | undefined;
let service: TerminalService | undefined;
let socketName: string | undefined;
const originalTerminalEnv = new Map<string, string | undefined>();

function prepareTmuxEnvironment(): void {
	for (const [name, value] of [
		["TMUX", undefined],
		["TMUX_PANE", undefined],
		["TERM", "xterm-256color"],
	] as const) {
		if (!originalTerminalEnv.has(name)) {
			originalTerminalEnv.set(name, process.env[name]);
		}
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

function tmux(...args: string[]): string {
	if (!socketName) throw new Error("tmux socket not initialized");
	return execFileSync("tmux", ["-L", socketName, ...args], { encoding: "utf8" });
}

afterEach(() => {
	service?.close();
	service = undefined;
	server?.stop(true);
	server = undefined;
	if (socketName) {
		try {
			tmux("kill-server");
		} catch {}
	}
	socketName = undefined;
	for (const [name, value] of originalTerminalEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	originalTerminalEnv.clear();
});

function asBytes(message: string | Buffer | ArrayBuffer | Uint8Array): Uint8Array {
	if (typeof message === "string") return new TextEncoder().encode(message);
	if (message instanceof ArrayBuffer) return new Uint8Array(message);
	return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

async function nextTerminalFrame(
	queue: Uint8Array[],
	wake: Array<() => void>,
): Promise<Uint8Array> {
	const ready = queue.shift();
	if (ready) return ready;
	const { promise, resolve } = Promise.withResolvers<Uint8Array>();
	wake.push(() => {
		const frame = queue.shift();
		if (frame) resolve(frame);
	});
	return promise;
}

test("rejects malformed terminal tickets before opening a relay", async () => {
	const terminal = new TerminalService("unused");
	service = terminal;
	await expect(
		terminal.open({
			ticket: "not-a-capability",
			relayUrl: "ws://localhost:1/host",
		}),
	).rejects.toThrow("invalid terminal open request");
});

test.skipIf(!tmuxAvailable)(
	"attaches to tmux, forwards terminal input and resize, then detaches on disconnect",
	async () => {
		prepareTmuxEnvironment();
		socketName = `omp-${process.pid}-${Date.now()}`;
		tmux("new-session", "-d", "-s", "terminal-test", "cat");

		const frames: Uint8Array[] = [];
		const wake: Array<() => void> = [];
		const attached = Promise.withResolvers<void>();
		let host: ServerWebSocket<unknown> | undefined;
		const relay = Bun.serve({
			port: 0,
			fetch(request, current) {
				if (new URL(request.url).pathname === "/host" && current.upgrade(request)) return;
				return new Response("not found", { status: 404 });
			},
			websocket: {
				message(socket, message) {
					host = socket;
					const frame = asBytes(message);
					if (frame[0] === 0 && frame[1] === 1) {
						socket.send(new Uint8Array([0, 1, 0]));
						return;
					}
					if (frame[0] === 1) attached.resolve();
					frames.push(frame.subarray(1));
					for (const notify of wake.splice(0)) notify();
				},
			},
		});
		server = relay;

		const terminal = new TerminalService(socketName);
		service = terminal;
		const openResult = await terminal.open({
			ticket: "T".repeat(43),
			relayUrl: `ws://localhost:${relay.port}/host`,
		});
		expect(openResult).toMatchObject({ ok: true });
		await attached.promise;
		if (!host) throw new Error("terminal relay did not receive the host hello");
		const hostSocket = host;

		hostSocket.send(new Uint8Array([3, 0, 120, 0, 40]));
		// Poll tmux's real client size because resize delivery is asynchronous.
		const clientSize = () =>
			tmux(
				"list-clients",
				"-t",
				"terminal-test",
				"-F",
				"#{client_width}x#{client_height}",
			).trim();
		for (let attempt = 0; attempt < 100 && clientSize() !== "120x40"; attempt += 1) {
			await Bun.sleep(10);
		}
		expect(clientSize()).toBe("120x40");

		const marker = "terminal-input-marker";
		hostSocket.send(new Uint8Array([2, ...new TextEncoder().encode(`${marker}\r`)]));
		let received = "";
		for (let attempt = 0; attempt < 100 && !received.includes(marker); attempt += 1) {
			received += new TextDecoder().decode(await nextTerminalFrame(frames, wake));
		}
		expect(received).toContain(marker);

		terminal.close();
		service = undefined;
		for (
			let attempt = 0;
			attempt < 100 &&
			tmux("list-clients", "-t", "terminal-test").trim() !== "";
			attempt += 1
		) {
			await Bun.sleep(10);
		}
		expect(tmux("list-clients", "-t", "terminal-test").trim()).toBe("");
	},
);
