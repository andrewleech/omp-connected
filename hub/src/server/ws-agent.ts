// /ws/agent — JSON-RPC 2.0 over one WebSocket per omp-connected extension
// instance. The only inbound
// method a fresh connection may send is agent.register; after that this
// plugin dispatches agent.* methods to AgentRegistry and treats any
// incoming {result: ...}/{error: ...} frame as one of two things: a reply
// to a collab.list/collab.link call this server pushed to serve host-level
// Collab discovery (AgentRegistry.resolveHostCall, checked first), or
// otherwise the extension's delivery receipt for a server-pushed
// agent.message request (AgentRegistry.pushToRecipient uses the message's
// own id, so no separate pending-push table is needed for that case).
//
// agent.register is token-gated only. There is no second, independent
// connection to confirm a registering session's claimed instanceId/cwd
// against — accepting the token is accepting the extension's identity
// claim. See ARCHITECTURE.md's security model section for what that does
// and doesn't protect against.

import { Elysia } from "elysia";
import {
  type AgentConn,
  type AgentRegistry,
  AgentRegistryError,
} from "./agent-registry";
import { RateLimiter } from "./rate-limit";
import {
  AGENT_LABEL_PATTERN,
  AGENT_RPC_ERRORS,
  type AgentRegisterParams,
} from "./types";

interface AgentWs {
  send(data: string): void;
  raw: object;
  close(code?: number, reason?: string): void;
}

interface Registered {
  id: string;
  conn: AgentConn;
}

function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isAgentRegisterParams(value: unknown): value is AgentRegisterParams {
  return (
    !!value &&
    typeof value === "object" &&
    "hostId" in value &&
    typeof value.hostId === "string" &&
    "instanceId" in value &&
    typeof value.instanceId === "string" &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "cwd" in value &&
    typeof value.cwd === "string" &&
    "token" in value &&
    typeof value.token === "string" &&
    (!("label" in value) ||
      value.label === undefined ||
      (typeof value.label === "string" &&
        AGENT_LABEL_PATTERN.test(value.label)))
  );
}

export function wsAgentPlugin(agentRegistry: AgentRegistry, hostToken: string) {
  const registeredByConn = new WeakMap<object, Registered>();
  const sendLimiter = new RateLimiter({ max: 20, windowMs: 10_000 });

  function sendResult(ws: AgentWs, id: string, result: unknown): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  function sendError(
    ws: AgentWs,
    id: string,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data !== undefined ? { data } : {}) },
      }),
    );
  }

  function dispatchRegistered(
    ws: AgentWs,
    id: string,
    method: string,
    params: unknown,
    registered: Registered,
  ): void {
    try {
      switch (method) {
        case "agent.send": {
          if (!sendLimiter.allow(registered.id)) {
            sendError(
              ws,
              id,
              AGENT_RPC_ERRORS.rateLimited,
              "Rate limit: agent.send (20 per 10s)",
            );
            return;
          }
          const p = params as {
            to: string;
            content: string;
            replyTo?: string;
            idempotencyKey: string;
          };
          sendResult(ws, id, agentRegistry.send({ from: registered.id, ...p }));
          return;
        }
        case "agent.send_team": {
          if (!sendLimiter.allow(registered.id)) {
            sendError(
              ws,
              id,
              AGENT_RPC_ERRORS.rateLimited,
              "Rate limit: agent.send_team (20 per 10s)",
            );
            return;
          }
          const p = params as {
            team: string;
            content: string;
            replyTo?: string;
            idempotencyKey: string;
          };
          sendResult(
            ws,
            id,
            agentRegistry.sendTeam({ from: registered.id, ...p }),
          );
          return;
        }
        case "agent.join_team": {
          const p = params as { team: string };
          sendResult(ws, id, agentRegistry.joinTeam(registered.id, p.team));
          return;
        }
        case "agent.leave_team": {
          const p = params as { team: string };
          sendResult(ws, id, agentRegistry.leaveTeam(registered.id, p.team));
          return;
        }
        case "agent.list_agents": {
          sendResult(ws, id, { agents: agentRegistry.listAgents() });
          return;
        }
        case "agent.list_teams": {
          sendResult(ws, id, { teams: agentRegistry.listTeams() });
          return;
        }
        case "agent.get_mailbox": {
          const p = (params ?? {}) as { agent?: string };
          const agentId = p.agent ?? registered.id;
          sendResult(ws, id, {
            agentId,
            messages: agentRegistry.getMailbox(agentId),
          });
          return;
        }
        case "agent.query_events": {
          const p = (params ?? {}) as {
            event?: string;
            since?: number;
            limit?: number;
            agent?: string;
          };
          sendResult(ws, id, agentRegistry.queryEvents(p));
          return;
        }
        default:
          sendError(ws, id, -32601, `unknown method '${method}'`);
      }
    } catch (err) {
      if (err instanceof AgentRegistryError) {
        sendError(ws, id, err.code, err.message, err.data);
      } else {
        sendError(ws, id, -32603, (err as Error).message);
      }
    }
  }

  async function handleRegister(
    ws: AgentWs,
    id: string,
    params: unknown,
  ): Promise<void> {
    if (!isAgentRegisterParams(params)) {
      sendError(ws, id, -32602, "agent.register missing or invalid params");
      ws.close();
      return;
    }
    if (params.token !== hostToken) {
      sendError(ws, id, AGENT_RPC_ERRORS.invalidToken, "invalid token");
      ws.close();
      return;
    }
    const conn: AgentConn = {
      send: (payload) => ws.send(payload),
      close: () => ws.close(),
    };
    let summary: ReturnType<AgentRegistry["register"]>;
    try {
      summary = agentRegistry.register(
        {
          hostId: params.hostId,
          instanceId: params.instanceId,
          pid: params.pid,
          cwd: params.cwd,
          label: params.label,
        },
        conn,
      );
    } catch (err) {
      if (err instanceof AgentRegistryError) {
        sendError(ws, id, err.code, err.message, err.data);
      } else {
        sendError(ws, id, -32603, (err as Error).message);
      }
      ws.close();
      return;
    }
    registeredByConn.set(ws.raw, { id: summary.id, conn });
    sendResult(ws, id, { ok: true, agent: summary });
  }

  return new Elysia().ws("/ws/agent", {
    async message(ws: AgentWs, rawData: unknown) {
      const data = safeJsonParse(rawData);
      if (
        !data ||
        typeof data !== "object" ||
        !("id" in data) ||
        typeof data.id !== "string"
      )
        return;
      const id = data.id;

      // A reply frame from the extension: either a collab.list/collab.link
      // result this server is awaiting on behalf of a host-level query, or
      // otherwise the delivery receipt for a server-pushed agent.message
      // request. Its id is that call's/message's own id.
      if ("result" in data || "error" in data) {
        const errorMessage =
          "error" in data &&
          data.error &&
          typeof data.error === "object" &&
          "message" in data.error &&
          typeof (data.error as { message: unknown }).message === "string"
            ? (data.error as { message: string }).message
            : undefined;
        if (
          agentRegistry.resolveHostCall(
            id,
            "result" in data ? data.result : undefined,
            errorMessage,
          )
        )
          return;
        const registered = registeredByConn.get(ws.raw);
        if (!registered) return;
        if ("result" in data) agentRegistry.ackMessage(registered.id, id);
        return;
      }

      if (!("method" in data) || typeof data.method !== "string") return;
      const method = data.method;
      const params = "params" in data ? data.params : undefined;

      if (method === "agent.register") {
        await handleRegister(ws, id, params);
        return;
      }

      const registered = registeredByConn.get(ws.raw);
      if (!registered) {
        sendError(
          ws,
          id,
          AGENT_RPC_ERRORS.registrationRequired,
          "agent.register must be sent first",
        );
        return;
      }
      dispatchRegistered(ws, id, method, params, registered);
    },

    close(ws: AgentWs) {
      const registered = registeredByConn.get(ws.raw);
      if (!registered) return;
      registeredByConn.delete(ws.raw);
      agentRegistry.unregister(registered.id, registered.conn);
    },
  });
}