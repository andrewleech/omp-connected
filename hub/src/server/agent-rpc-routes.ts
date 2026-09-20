// REST surface for the dashboard: list agents and send a message as the
// reserved operator principal. The dashboard is never a registered agent
// connection — it can only send as `operator@<hub-host>`, never spoof a
// real agent's identity.

import { Elysia } from "elysia";
import { type AgentRegistry, AgentRegistryError } from "./agent-registry";
import { RateLimiter } from "./rate-limit";

export function agentRpcRoutes(agentRegistry: AgentRegistry, hubHost: string) {
  const sendLimiter = new RateLimiter({ max: 20, windowMs: 10_000 });
  const operatorId = `operator@${hubHost}`;

  return new Elysia({ prefix: "/api/agents" })
    .get("/", () => ({ agents: agentRegistry.listAgents() }))

    .post("/:id/send", ({ params, body, set }) => {
      const agentId = params.id;
      const payload = body as {
        content?: unknown;
        replyTo?: unknown;
        idempotencyKey?: unknown;
      };
      if (typeof payload.content !== "string" || !payload.content) {
        set.status = 400;
        return { error: "content is required" };
      }
      if (
        typeof payload.idempotencyKey !== "string" ||
        !payload.idempotencyKey
      ) {
        set.status = 400;
        return { error: "idempotencyKey is required" };
      }
      if (
        payload.replyTo !== undefined &&
        typeof payload.replyTo !== "string"
      ) {
        set.status = 400;
        return { error: "replyTo must be a string" };
      }

      const resolved = agentRegistry.resolve(agentId);
      if (resolved.kind === "not_found") {
        set.status = 404;
        return { error: `agent '${agentId}' not found` };
      }
      if (resolved.kind === "ambiguous") {
        set.status = 409;
        return {
          error: `address '${agentId}' is ambiguous`,
          candidates: resolved.data.candidates,
        };
      }
      if (!sendLimiter.allow(operatorId)) {
        set.status = 429;
        set.headers["retry-after"] = "1";
        return { error: "Rate limit: agent send (20 per 10s)" };
      }

      try {
        return agentRegistry.send({
          from: operatorId,
          to: resolved.agent.id,
          content: payload.content,
          ...(payload.replyTo !== undefined
            ? { replyTo: payload.replyTo }
            : {}),
          idempotencyKey: payload.idempotencyKey,
        });
      } catch (err) {
        if (err instanceof AgentRegistryError) {
          set.status = 409;
          return { error: err.message };
        }
        throw err;
      }
    });
}