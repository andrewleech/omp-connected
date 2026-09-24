import { afterEach, describe, expect, it } from "bun:test";
import { type Socket, connect } from "node:net";
import { type CollabRelay, startCollabRelay } from "../../src/relay/relay";

const ROOM = "RelayRoom_12345";

let relay: CollabRelay | null = null;
const sockets: WebSocket[] = [];

function relayUrl(): string {
  if (!relay) throw new Error("relay not started");
  return relay.url;
}

function socket(path: string): WebSocket {
  const ws = new WebSocket(`${relayUrl().replace("http", "ws")}${path}`);
  sockets.push(ws);
  return ws;
}
function waitEvent<T extends Event>(ws: WebSocket, type: string): Promise<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  ws.addEventListener(type, (event) => resolve(event as T), { once: true });
  return promise;
}

async function waitOpen(ws: WebSocket): Promise<void> {
  await waitEvent(ws, "open");
}

async function waitText(ws: WebSocket): Promise<string> {
  const message = await waitEvent<MessageEvent>(ws, "message");
  return String(message.data);
}

async function waitBinary(ws: WebSocket): Promise<Uint8Array> {
  const message = await waitEvent<MessageEvent>(ws, "message");
  const data = message.data;
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data as ArrayBuffer);
}
function envelope(peerId: number, payload: readonly number[]): Uint8Array {
  const data = new Uint8Array(4 + payload.length);
  new DataView(data.buffer).setUint32(0, peerId, false);
  data.set(payload, 4);
  return data;
}

function peerId(data: Uint8Array): number {
  return new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
}

/** A guest over a raw TCP socket so the test can stop reading, the way a
 *  guest on a slow remote link does while a local host pushes a snapshot. */
async function rawGuest(path: string): Promise<{
  socket: Socket;
  frames(count: number): Promise<Uint8Array[]>;
}> {
  const url = new URL(relayUrl());
  const socket = connect(Number(url.port), url.hostname);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "\r\n",
    ].join("\r\n"),
  );
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  });
  const more = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  while (buffer.indexOf("\r\n\r\n") < 0) await more();
  expect(buffer.toString("latin1")).toStartWith("HTTP/1.1 101");
  buffer = buffer.subarray(buffer.indexOf("\r\n\r\n") + 4);
  return {
    socket,
    async frames(count) {
      const out: Uint8Array[] = [];
      while (out.length < count) {
        // Server frames are unmasked: opcode byte, 7/16/64-bit length.
        if (buffer.length >= 2) {
          let length = (buffer[1] ?? 0) & 0x7f;
          let offset = 2;
          if (length === 126 && buffer.length >= 4) {
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127 && buffer.length >= 10) {
            length = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (length < 126 || offset > 2) {
            if (buffer.length >= offset + length) {
              out.push(buffer.subarray(offset, offset + length));
              buffer = buffer.subarray(offset + length);
              continue;
            }
          }
        }
        await more();
      }
      return out;
    },
  };
}

afterEach(() => {
  for (const ws of sockets.splice(0)) {
    if (
      ws.readyState === WebSocket.CONNECTING ||
      ws.readyState === WebSocket.OPEN
    )
      ws.close();
  }
  relay?.stop();
  relay = null;
});

describe("private Collab relay", () => {
  it("serves the guest client and an unauthenticated liveness endpoint", async () => {
    relay = startCollabRelay({
      webRoot: `${import.meta.dir}/../fixtures/collab-web`,
    });

    const [index, health, traversal] = await Promise.all([
      fetch(`${relayUrl()}/`),
      fetch(`${relayUrl()}/healthz`),
      fetch(`${relayUrl()}/../../package.json`),
    ]);

    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", rooms: 0 });
    expect(traversal.status).toBe(404);
  });

  it("enforces browser origins while allowing native OMP clients without one", async () => {
    relay = startCollabRelay({ allowedOrigins: ["https://dashboard.example"] });

    const rejected = await fetch(`${relayUrl()}/r/${ROOM}?role=host`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: "https://evil.example",
      },
    });
    expect(rejected.status).toBe(403);

    const host = socket(`/r/${ROOM}?role=host`);
    await waitOpen(host);
  });

  it("routes opaque envelopes and reports room lifecycle", async () => {
    relay = startCollabRelay();
    const host = socket(`/r/${ROOM}?role=host`);
    await waitOpen(host);

    const guest = socket(`/r/${ROOM}?role=guest`);
    await waitOpen(guest);
    expect(JSON.parse(await waitText(host))).toEqual({
      t: "peer-joined",
      peer: 1,
    });

    guest.send(envelope(99, [1, 2, 3]));
    const fromGuest = await waitBinary(host);
    expect(peerId(fromGuest)).toBe(1);
    expect([...fromGuest.subarray(4)]).toEqual([1, 2, 3]);

    const broadcast = waitBinary(guest);
    host.send(envelope(0, [9]));
    expect([...(await broadcast)]).toEqual([...envelope(0, [9])]);

    const roomClosed = waitText(guest);
    const guestClose = waitEvent<CloseEvent>(guest, "close");
    host.close();
    expect(JSON.parse(await roomClosed)).toEqual({ t: "room-closed" });
    expect((await guestClose).code).toBe(4001);
  });

  it("rejects duplicate hosts, missing rooms, and room capacity overflow", async () => {
    relay = startCollabRelay({ maxGuestsPerRoom: 1 });
    const host = socket(`/r/${ROOM}?role=host`);
    await waitOpen(host);

    const duplicate = socket(`/r/${ROOM}?role=host`);
    expect((await waitEvent<CloseEvent>(duplicate, "close")).code).toBe(4009);

    const missing = socket("/r/MissingRoom_12345?role=guest");
    expect((await waitEvent<CloseEvent>(missing, "close")).code).toBe(4004);

    const firstGuest = socket(`/r/${ROOM}?role=guest`);
    await waitOpen(firstGuest);
    await waitText(host);
    const overflowing = socket(`/r/${ROOM}?role=guest`);
    expect((await waitEvent<CloseEvent>(overflowing, "close")).code).toBe(4029);
  });

  it("delivers every host frame in order to a guest that falls behind", async () => {
    relay = startCollabRelay();
    const host = socket(`/r/${ROOM}?role=host`);
    await waitOpen(host);
    const joined = waitText(host);
    const guest = await rawGuest(`/r/${ROOM}?role=guest`);
    expect(JSON.parse(await joined)).toEqual({ t: "peer-joined", peer: 1 });

    // 36 MiB, well past Bun's 16 MiB per-socket send buffer, while the guest
    // reads nothing — a multi-MB snapshot to a guest on a slow link.
    guest.socket.pause();
    const frameCount = 40;
    const payload = new Array<number>(900 * 1024).fill(7);
    for (let i = 0; i < frameCount; i++) {
      const frame = envelope(1, payload);
      frame[4] = i;
      host.send(frame);
    }
    while (host.bufferedAmount > 0) await Bun.sleep(10);
    // The relay exposes no signal for "host frames forwarded"; give its event
    // loop a beat to hand the flushed frames to the paused guest's socket.
    await Bun.sleep(200);

    guest.socket.resume();
    const received = await guest.frames(frameCount);
    expect(received.map((frame) => frame[4])).toEqual(
      Array.from({ length: frameCount }, (_, i) => i),
    );
    guest.socket.destroy();
  }, 30_000);
});
