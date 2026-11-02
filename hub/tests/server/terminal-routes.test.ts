import { afterEach, describe, expect, test } from "bun:test";
import { type Socket, connect } from "node:net";
import { type AgentConn, AgentRegistry } from "@/server/agent-registry";
import { terminalRoutes } from "@/server/terminal-routes";
import { Elysia } from "elysia";

const HOST_ID = "user@terminal-test";
const INSTANCE_ID = "inst-terminal";
let stopServer: (() => void) | undefined;
const sockets: Socket[] = [];

function start(options: { access?: string; features?: string[] } = {}) {
  const registry = new AgentRegistry();
  const conn: AgentConn = {
    send(data) {
      const request = JSON.parse(data) as { id: string; method: string };
      queueMicrotask(() => {
        const result =
          request.method === "collab.list"
            ? {
                sessions: [
                  {
                    instanceId: INSTANCE_ID,
                    access: options.access ?? "control",
                  },
                ],
              }
            : { ok: true };
        registry.resolveHostCall(request.id, result, undefined);
      });
    },
    close() {},
  };
  registry.register(
    {
      hostId: HOST_ID,
      instanceId: INSTANCE_ID,
      pid: 1,
      cwd: "/tmp/terminal-test",
      features: options.features ?? ["terminal.v1"],
    },
    conn,
  );

  const app = new Elysia().use(terminalRoutes(registry));
  app.listen(0);
  const port = app.server?.port;
  if (!port) throw new Error("server did not report a port");
  stopServer = () => app.stop();
  return { baseUrl: `http://localhost:${port}` };
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  stopServer?.();
  stopServer = undefined;
});

async function createTicket(
  baseUrl: string,
): Promise<{ ticket: string; url: string }> {
  const response = await fetch(
    `${baseUrl}/api/agents/${HOST_ID}:${INSTANCE_ID}/terminal`,
    {
      method: "POST",
      headers: { origin: baseUrl },
    },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ticket: string; url: string };
  return body;
}

interface Frame {
  opcode: number;
  payload: Buffer;
}

async function rawWebSocket(
  url: string,
  origin: string,
): Promise<{
  socket: Socket;
  send(payload: Uint8Array): void;
  nextFrame(): Promise<Frame>;
}> {
  const parsed = new URL(url);
  const socket = connect(Number(parsed.port), parsed.hostname);
  sockets.push(socket);
  const connected = Promise.withResolvers<void>();
  socket.once("connect", connected.resolve);
  socket.once("error", connected.reject);
  await connected.promise;
  const frames: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const {
    promise: upgradePromise,
    resolve: upgradeResolve,
    reject: upgradeReject,
  } = Promise.withResolvers<void>();
  const dispatch = (frame: Frame) => {
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const headers = buffer.subarray(0, end).toString("latin1");
      buffer = buffer.subarray(end + 4);
      if (!headers.startsWith("HTTP/1.1 101")) {
        upgradeReject?.(new Error(`websocket upgrade failed: ${headers}`));
        return;
      }
      upgraded = true;
      upgradeResolve?.();
    }
    while (buffer.length >= 2) {
      const opcode = (buffer[0] ?? 0) & 0x0f;
      let length = (buffer[1] ?? 0) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const longLength = buffer.readBigUInt64BE(2);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("oversized frame");
        }
        length = Number(longLength);
        offset = 10;
      }
      const masked = ((buffer[1] ?? 0) & 0x80) !== 0;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(offset - 4, offset);
        payload = Buffer.from(
          payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0)),
        );
      }
      dispatch({ opcode, payload: Buffer.from(payload) });
      buffer = buffer.subarray(offset + length);
    }
  });
  socket.write(
    [
      `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
      `Host: ${parsed.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Origin: ${origin}`,
      "\r\n",
    ].join("\r\n"),
  );
  await upgradePromise;

  return {
    socket,
    send(payload) {
      const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
      let header: Buffer;
      if (payload.byteLength < 126) {
        header = Buffer.from([0x82, 0x80 | payload.byteLength]);
      } else if (payload.byteLength <= 0xffff) {
        header = Buffer.from([
          0x82,
          0x80 | 126,
          payload.byteLength >> 8,
          payload.byteLength & 0xff,
        ]);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x82;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
      }
      const data = Buffer.from(payload);
      for (let i = 0; i < data.length; i++) {
        data[i] = (data[i] ?? 0) ^ (mask[i % 4] ?? 0);
      }
      socket.write(Buffer.concat([header, mask, data]));
    },
    nextFrame() {
      const frame = frames.shift();
      if (frame) return Promise.resolve(frame);
      const { promise, resolve } = Promise.withResolvers<Frame>();
      waiters.push(resolve);
      return promise;
    },
  };
}

function hello(ticket: string): Uint8Array {
  const text = new TextEncoder().encode(ticket);
  return new Uint8Array([0, 1, ...text]);
}

function webSocketUrl(url: string, role: "client" | "host"): string {
  const endpoint = new URL(url);
  endpoint.protocol = "ws:";
  endpoint.pathname = `/ws/terminal/${role}`;
  return endpoint.toString();
}

describe("terminal relay routes", () => {
  test("requires same-origin access and Collab control before issuing a capability", async () => {
    const { baseUrl } = start({ access: "view" });
    const crossOrigin = await fetch(
      `${baseUrl}/api/agents/${HOST_ID}:${INSTANCE_ID}/terminal`,
      {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      },
    );
    expect(crossOrigin.status).toBe(403);

    const denied = await fetch(
      `${baseUrl}/api/agents/${HOST_ID}:${INSTANCE_ID}/terminal`,
      {
        method: "POST",
        headers: { origin: baseUrl },
      },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: "terminal requires Collab control access",
    });
  });

  test("rejects invalid or replayed tickets", async () => {
    const { baseUrl } = start();
    const { ticket, url } = await createTicket(baseUrl);

    const invalid = await rawWebSocket(webSocketUrl(url, "host"), baseUrl);
    invalid.send(hello("not-a-capability"));
    const invalidClose = await invalid.nextFrame();
    expect(invalidClose.opcode).toBe(8);
    expect(invalidClose.payload.readUInt16BE(0)).toBe(4003);

    const expired = await createTicket(baseUrl);
    const previousNow = Date.now;
    Date.now = () => previousNow() + 31_000;
    try {
      const stale = await rawWebSocket(
        webSocketUrl(expired.url, "host"),
        baseUrl,
      );
      stale.send(hello(expired.ticket));
      expect((await stale.nextFrame()).payload.readUInt16BE(0)).toBe(4003);
    } finally {
      Date.now = previousNow;
    }

    const hostUrl = webSocketUrl(url, "host");
    const first = await rawWebSocket(hostUrl, baseUrl);
    first.send(hello(ticket));
    const second = await rawWebSocket(hostUrl, baseUrl);
    second.send(hello(ticket));
    expect((await second.nextFrame()).payload.readUInt16BE(0)).toBe(4009);
  });

  test("pairs and closes terminal protocol frames", async () => {
    const { baseUrl } = start();
    const { ticket, url } = await createTicket(baseUrl);
    const client = await rawWebSocket(webSocketUrl(url, "client"), baseUrl);
    const host = await rawWebSocket(webSocketUrl(url, "host"), baseUrl);
    client.send(hello(ticket));
    host.send(hello(ticket));
    expect([...(await client.nextFrame()).payload]).toEqual([0, 1, 0]);
    expect([...(await host.nextFrame()).payload]).toEqual([0, 1, 0]);

    const resize = new Uint8Array([3, 0, 120, 0, 40]);
    client.send(resize);
    expect([...(await host.nextFrame()).payload]).toEqual([...resize]);
    const input = new Uint8Array([2, 0, 0xff, 1]);
    client.send(input);
    expect([...(await host.nextFrame()).payload]).toEqual([...input]);
    const ack = new Uint8Array([4, 0, 0, 0, 4]);
    client.send(ack);
    expect([...(await host.nextFrame()).payload]).toEqual([...ack]);
    const exit = new Uint8Array([5, 0, 0]);
    host.send(exit);
    expect([...(await client.nextFrame()).payload]).toEqual([...exit]);
    expect((await client.nextFrame()).payload.readUInt16BE(0)).toBe(4001);

    const badCapability = await createTicket(baseUrl);
    const badClient = await rawWebSocket(
      webSocketUrl(badCapability.url, "client"),
      baseUrl,
    );
    const badHost = await rawWebSocket(
      webSocketUrl(badCapability.url, "host"),
      baseUrl,
    );
    badClient.send(hello(badCapability.ticket));
    badHost.send(hello(badCapability.ticket));
    await badClient.nextFrame();
    await badHost.nextFrame();
    badHost.send(new Uint8Array([3, 1]));
    expect((await badHost.nextFrame()).payload.readUInt16BE(0)).toBe(4003);
    expect((await badClient.nextFrame()).payload.readUInt16BE(0)).toBe(4001);
  });

  test("enforces the websocket frame size limit", async () => {
    const { baseUrl } = start();
    const { url } = await createTicket(baseUrl);
    const client = await rawWebSocket(webSocketUrl(url, "client"), baseUrl);
    client.send(new Uint8Array(64 * 1024 + 1));
    const close = await client.nextFrame();
    expect(close.opcode).toBe(8);
    expect(close.payload.readUInt16BE(0)).toBe(1009);
  });
});
