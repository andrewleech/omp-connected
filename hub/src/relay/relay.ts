import { resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ENVELOPE_HEADER_LENGTH = 4;
const ROOM_CLOSED = JSON.stringify({ t: "room-closed" });
const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_GUESTS_PER_ROOM = 32;
const DEFAULT_MAX_ROOMS = 256;

interface SocketData {
  roomId: string;
  role: "host" | "guest";
  peerId: number;
}

type RelaySocket = ServerWebSocket<SocketData>;

interface Room {
  host: RelaySocket;
  guests: Map<number, RelaySocket>;
  nextPeerId: number;
}

export interface CollabRelayOptions {
  hostname?: string;
  port?: number;
  webRoot?: string;
  allowedOrigins?: readonly string[];
  maxGuestsPerRoom?: number;
  maxRooms?: number;
  tls?: {
    cert: string;
    key: string;
  };
}

export interface CollabRelay {
  url: string;
  port: number;
  stop(): void;
}

/**
 * Content-blind relay for OMP Collab rooms.
 *
 * It only routes encrypted envelopes. Room keys and application frames never
 * leave the host or guest processes.
 */
export function startCollabRelay(
  options: CollabRelayOptions = {},
): CollabRelay {
  const rooms = new Map<string, Room>();
  const webRoot = resolve(
    options.webRoot ?? `${import.meta.dir}/../hub/omp-collab`,
  );
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const maxGuestsPerRoom =
    options.maxGuestsPerRoom ?? DEFAULT_MAX_GUESTS_PER_ROOM;
  const maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;

  const fetch = async (
    request: Request,
    server: Server<SocketData>,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok", rooms: rooms.size });
    }

    const roomId = ROOM_PATH_RE.exec(url.pathname)?.[1];
    const role = url.searchParams.get("role");
    if (roomId && (role === "host" || role === "guest")) {
      const origin = request.headers.get("origin");
      if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
        return new Response("forbidden origin", { status: 403 });
      }
      if (
        server.upgrade(request, {
          data: { roomId, role, peerId: 0 },
        })
      )
        return;
      return new Response("websocket upgrade required", { status: 426 });
    }

    if (url.pathname.startsWith("/r/"))
      return new Response("not found", { status: 404 });
    return serveStatic(webRoot, url.pathname);
  };

  const websocket = {
    maxPayloadLength: MAX_FRAME_BYTES,
    idleTimeout: 120,
    open(ws: RelaySocket): void {
      const { roomId, role } = ws.data;
      if (role === "host") {
        if (rooms.has(roomId)) {
          ws.close(4009, "a host is already connected for this room");
          return;
        }
        if (rooms.size >= maxRooms) {
          ws.close(1013, "relay room capacity reached");
          return;
        }
        rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        ws.close(4004, "no such room");
        return;
      }
      if (room.guests.size >= maxGuestsPerRoom) {
        ws.close(4029, "room is full");
        return;
      }

      const peerId = room.nextPeerId++;
      ws.data.peerId = peerId;
      room.guests.set(peerId, ws);
      room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
    },
    message(ws: RelaySocket, message: string | Uint8Array): void {
      if (
        typeof message === "string" ||
        message.byteLength < ENVELOPE_HEADER_LENGTH
      )
        return;
      const room = rooms.get(ws.data.roomId);
      if (!room) return;

      if (ws.data.role === "host") {
        const peerId = new DataView(
          message.buffer,
          message.byteOffset,
          ENVELOPE_HEADER_LENGTH,
        ).getUint32(0, false);
        if (peerId === 0) {
          for (const guest of room.guests.values()) guest.send(message);
        } else {
          room.guests.get(peerId)?.send(message);
        }
        return;
      }

      new DataView(
        message.buffer,
        message.byteOffset,
        ENVELOPE_HEADER_LENGTH,
      ).setUint32(0, ws.data.peerId, false);
      room.host.send(message);
    },
    close(ws: RelaySocket): void {
      const room = rooms.get(ws.data.roomId);
      if (!room) return;

      if (ws.data.role === "host") {
        if (room.host !== ws) return;
        rooms.delete(ws.data.roomId);
        for (const guest of room.guests.values()) {
          guest.send(ROOM_CLOSED);
          guest.close(4001, "room closed");
        }
        room.guests.clear();
        return;
      }

      if (room.guests.delete(ws.data.peerId)) {
        room.host.send(
          JSON.stringify({ t: "peer-left", peer: ws.data.peerId }),
        );
      }
    },
  };

  const server = options.tls
    ? Bun.serve({
        hostname: options.hostname ?? "127.0.0.1",
        port: options.port ?? 7466,
        tls: {
          cert: Bun.file(options.tls.cert),
          key: Bun.file(options.tls.key),
        },
        fetch,
        websocket,
      })
    : Bun.serve({
        hostname: options.hostname ?? "127.0.0.1",
        port: options.port ?? 7466,
        fetch,
        websocket,
      });

  const port = server.port;
  if (port === undefined) throw new Error("relay did not expose a bound port");
  return {
    url: `${options.tls ? "https" : "http"}://${options.hostname ?? "127.0.0.1"}:${port}`,
    port,
    stop(): void {
      for (const room of rooms.values()) {
        for (const guest of room.guests.values()) {
          guest.send(ROOM_CLOSED);
          guest.close(4001, "room closed");
        }
        room.host.close(1001, "relay shutting down");
      }
      rooms.clear();
      server.stop(true);
    },
  };
}

async function serveStatic(
  webRoot: string,
  pathname: string,
): Promise<Response> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(webRoot, relativePath);
  if (filePath !== webRoot && !filePath.startsWith(`${webRoot}/`)) {
    return new Response("not found", { status: 404 });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, {
    headers: { "content-type": contentType(filePath) },
  });
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

if (import.meta.main) {
  const cert = process.env.COLLAB_RELAY_TLS_CERT;
  const key = process.env.COLLAB_RELAY_TLS_KEY;
  if (!cert || !key)
    throw new Error(
      "COLLAB_RELAY_TLS_CERT and COLLAB_RELAY_TLS_KEY are required",
    );

  const origins = (process.env.COLLAB_RELAY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const relay = startCollabRelay({
    hostname: process.env.COLLAB_RELAY_HOST ?? "0.0.0.0",
    port: Number(process.env.COLLAB_RELAY_PORT) || 7466,
    webRoot: process.env.COLLAB_RELAY_WEB_ROOT,
    allowedOrigins: origins,
    tls: { cert, key },
  });
  console.log(`collab relay listening on ${relay.url}`);
}