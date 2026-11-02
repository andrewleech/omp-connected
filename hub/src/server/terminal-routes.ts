import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { Context } from "elysia";
import { Elysia } from "elysia";
import type { ElysiaWS } from "elysia/ws";
import { AgentCallError, type AgentRegistry } from "./agent-registry";
import { RateLimiter } from "./rate-limit";
import { TERMINAL_FEATURE } from "./types";

const TICKET_TTL_MS = 30_000;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_SOCKET_BUFFER = 1024 * 1024;
const TERMINAL_LIMIT = 4;
const MAX_PENDING_HELLOS = 64;
const HELLO_TIMEOUT_MS = 5_000;
type Role = "client" | "host";
interface Ticket {
  key: string;
  agentId: string;
  expiresAt: number;
  client?: Socket;
  host?: Socket;
  paired: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
}
interface SocketData {
  ticket?: Ticket;
  role?: Role;
  hello: boolean;
  pendingHello?: boolean;
  helloTimer?: ReturnType<typeof setTimeout>;
}
type Socket = ServerWebSocket<SocketData>;
type WsContext = ElysiaWS<Context<{ params: { role: string } }>>;

function isSameOrigin(
  request: Request,
  publicOrigin?: string | null,
  allowedOrigins: string[] = [],
): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin).origin;
    return (
      parsed === (publicOrigin ?? new URL(request.url).origin) ||
      allowedOrigins.some((allowed) => {
        try {
          return new URL(allowed).origin === parsed;
        } catch {
          return false;
        }
      })
    );
  } catch {
    return false;
  }
}

export function terminalRoutes(
  agentRegistry: AgentRegistry,
  publicOrigin?: string | null,
  allowedOrigins: string[] = [],
) {
  const tickets = new Map<string, Ticket>();
  const limiter = new RateLimiter({ max: 20, windowMs: 10_000 });
  const byAgent = new Map<string, number>();
  const urlFor = (request: Request, path: string) => {
    const url = new URL(publicOrigin ?? request.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = path;
    url.search = "";
    return url.toString();
  };
  const remove = (ticket: Ticket) => {
    if (tickets.get(ticket.key) !== ticket) return;
    tickets.delete(ticket.key);
    clearTimeout(ticket.expiryTimer);
    const active = Math.max(0, (byAgent.get(ticket.agentId) ?? 1) - 1);
    if (active) byAgent.set(ticket.agentId, active);
    else byAgent.delete(ticket.agentId);
    ticket.client?.close(4001, "terminal closed");
    ticket.host?.close(4001, "terminal closed");
  };
  let pendingHellos = 0;
  const releasePendingHello = (socket: Socket) => {
    if (!socket.data.pendingHello) return;
    socket.data.pendingHello = false;
    clearTimeout(socket.data.helloTimer);
    socket.data.helloTimer = undefined;
    pendingHellos--;
  };
  const pair = (ticket: Ticket) => {
    if (ticket.paired || !ticket.client?.data.hello || !ticket.host?.data.hello)
      return;
    ticket.paired = true;
    clearTimeout(ticket.expiryTimer);
    const accepted = new Uint8Array([0, 1, 0]);
    ticket.client.send(accepted);
    ticket.host.send(accepted);
  };
  const socketHandlers = {
    maxPayloadLength: MAX_FRAME_BYTES,
    idleTimeout: 60,
    perMessageDeflate: true,
    backpressureLimit: MAX_SOCKET_BUFFER,
    closeOnBackpressureLimit: true,
    beforeHandle({ request, set, params }: Context) {
      if (params.role !== "client" && params.role !== "host") {
        set.status = 404;
        return "not found";
      }
      if (
        params.role === "client" &&
        !isSameOrigin(request, publicOrigin, allowedOrigins)
      ) {
        set.status = 403;
        return "same-origin websocket required";
      }
    },
    open(ws: WsContext) {
      const socket = ws.raw as unknown as Socket;
      if (pendingHellos >= MAX_PENDING_HELLOS) {
        socket.close(1013, "terminal connection limit reached");
        return;
      }
      pendingHellos++;
      socket.data.pendingHello = true;
      socket.data.role = ws.data.params.role as Role;
      socket.data.hello = false;
      socket.data.helloTimer = setTimeout(() => {
        releasePendingHello(socket);
        socket.close(4003, "terminal hello timed out");
      }, HELLO_TIMEOUT_MS);
      socket.data.helloTimer.unref?.();
    },
    message(ws: WsContext, frame: unknown) {
      const socket = ws.raw as unknown as Socket;
      releasePendingHello(socket);
      if (typeof frame === "string") {
        socket.close(1003, "binary terminal frames required");
        return;
      }
      if (!(frame instanceof Uint8Array)) {
        socket.close(1003, "binary terminal frames required");
        return;
      }
      if (frame.byteLength === 0 || frame.byteLength > MAX_FRAME_BYTES) {
        socket.close(
          frame.byteLength > MAX_FRAME_BYTES ? 1009 : 4003,
          frame.byteLength > MAX_FRAME_BYTES
            ? "terminal frame too large"
            : "invalid terminal frame",
        );
        return;
      }
      const data = new Uint8Array(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength,
      );
      if (!socket.data.hello) {
        if (data[0] !== 0 || data[1] !== 1) {
          socket.close(4003, "terminal hello required");
          return;
        }
        let key: string;
        try {
          key = new TextDecoder("utf-8", { fatal: true }).decode(
            data.subarray(2),
          );
        } catch {
          socket.close(4003, "invalid terminal ticket");
          return;
        }
        const ticket = tickets.get(key);
        if (!ticket || ticket.expiresAt <= Date.now()) {
          socket.close(4003, "invalid terminal ticket");
          return;
        }
        const role = socket.data.role;
        if (!role || ticket[role]) {
          socket.close(4009, "terminal route already attached");
          return;
        }
        ticket[role] = socket;
        socket.data.ticket = ticket;
        socket.data.hello = true;
        pair(ticket);
        return;
      }
      const ticket = socket.data.ticket;
      if (!ticket || !ticket.paired) {
        socket.close(4003, "terminal is not paired");
        return;
      }
      const type = data[0];
      if (
        type === undefined ||
        type === 0 ||
        type > 5 ||
        (type === 3 && data.byteLength !== 5) ||
        (type === 4 && data.byteLength !== 5) ||
        (type === 5 && data.byteLength !== 3)
      ) {
        socket.close(4003, "invalid terminal frame");
        return;
      }
      const role = socket.data.role;
      if (
        (role === "client" && type !== 2 && type !== 3 && type !== 4) ||
        (role === "host" && type !== 1 && type !== 5)
      ) {
        socket.close(4003, "terminal frame direction is invalid");
        return;
      }
      const peer = socket.data.role === "host" ? ticket.client : ticket.host;
      if (!peer) return;
      if (
        peer.getBufferedAmount() > MAX_SOCKET_BUFFER ||
        socket.getBufferedAmount() > MAX_SOCKET_BUFFER
      ) {
        remove(ticket);
        return;
      }
      peer.send(frame, true);
      if (type === 5) remove(ticket);
    },
    close(ws: WsContext) {
      const socket = ws.raw as unknown as Socket;
      releasePendingHello(socket);
      if (socket.data.ticket) remove(socket.data.ticket);
    },
  };

  return new Elysia()
    .post("/api/agents/:id/terminal", async ({ params, request, set }) => {
      if (!isSameOrigin(request, publicOrigin, allowedOrigins)) {
        set.status = 403;
        return { error: "same-origin request required" };
      }
      const agentId = params.id;
      const agent = agentRegistry.liveAgent(agentId);
      if (!agent) {
        set.status = 404;
        return { error: "agent not connected" };
      }
      if (
        !agent.features.includes(TERMINAL_FEATURE) ||
        !agent.terminal?.available
      ) {
        set.status = 501;
        return { error: "terminal is unavailable for this session" };
      }
      if (!limiter.allow(agentId)) {
        set.status = 429;
        set.headers["retry-after"] = "1";
        return { error: "terminal rate limit exceeded" };
      }
      const active = byAgent.get(agentId) ?? 0;
      if (active >= TERMINAL_LIMIT) {
        set.status = 429;
        return { error: "terminal limit reached" };
      }
      byAgent.set(agentId, active + 1);
      let ticket: Ticket | undefined;
      try {
        const listing = await agentRegistry.callOnHost(
          agent.hostId,
          "collab.list",
          {},
          15_000,
        );
        const session = listing.sessions.find(
          (entry) => entry.instanceId === agent.instanceId,
        );
        if (!session || session.access !== "control") {
          set.status = 403;
          return { error: "terminal requires Collab control access" };
        }
        const key = randomBytes(32).toString("base64url");
        const issuedTicket: Ticket = {
          key,
          agentId,
          expiresAt: Date.now() + TICKET_TTL_MS,
          paired: false,
        };
        ticket = issuedTicket;
        tickets.set(key, issuedTicket);
        issuedTicket.expiryTimer = setTimeout(
          () => remove(issuedTicket),
          TICKET_TTL_MS,
        );
        issuedTicket.expiryTimer.unref?.();
        const clientOrigin = request.headers.get("origin");
        const result = await agentRegistry.callOnAgent(
          agentId,
          "terminal.open",
          {
            ticket: key,
            relayUrl: urlFor(request, "/ws/terminal/host"),
            ...(clientOrigin ? { clientOrigin } : {}),
          },
          10_000,
        );
        return {
          url: urlFor(request, "/ws/terminal/client"),
          ticket: key,
          ...(result.directUrl && result.directTicket
            ? { directUrl: result.directUrl, directTicket: result.directTicket }
            : {}),
        };
      } catch (error) {
        if (ticket) remove(ticket);
        if (error instanceof AgentCallError)
          set.status = error.kind === "timeout" ? 504 : 502;
        else set.status = 502;
        return {
          error:
            error instanceof Error ? error.message : "terminal open failed",
        };
      } finally {
        if (!ticket) {
          const remaining = Math.max(0, (byAgent.get(agentId) ?? 1) - 1);
          if (remaining) byAgent.set(agentId, remaining);
          else byAgent.delete(agentId);
        }
      }
    })
    .ws("/ws/terminal/:role", socketHandlers);
}
