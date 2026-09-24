// REST surface for the collab broker. Forwards to whichever agent
// connection is currently live for a hostId (AgentRegistry.callOnHost) and
// awaits its JSON-RPC reply — there is no separate host-registration
// connection to relay through.

import { Elysia } from "elysia";
import type { AgentRegistry } from "./agent-registry";
import { RateLimiter } from "./rate-limit";

const COLLAB_TIMEOUT_MS = 5_000;
const COLLAB_INSTANCE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Capability URLs are short-lived: a link that leaks or goes unused has a
 *  bounded blast radius. */
const COLLAB_LINK_TTL_MS = 90_000;

export function collabRpcRoutes(agentRegistry: AgentRegistry) {
  const collabLimiter = new RateLimiter({ max: 20, windowMs: 10_000 });

  return new Elysia({ prefix: "/api/hosts" })
    .get("/", () => agentRegistry.listHostIds().map((hostId) => ({ hostId })))

    .get("/:id/collab", async ({ params, set }) => {
      const hostId = params.id;
      if (!agentRegistry.listHostIds().includes(hostId)) {
        set.status = 404;
        return { error: `host '${hostId}' not connected` };
      }
      if (!collabLimiter.allow(hostId)) {
        set.status = 429;
        set.headers["retry-after"] = "1";
        return { error: "Rate limit: collab (20 per 10s)" };
      }
      try {
        const result = await agentRegistry.callOnHost(
          hostId,
          "collab.list",
          {},
          COLLAB_TIMEOUT_MS,
        );
        // Attach each session's registered label (the ompc session name)
        // so the dashboard shows the same name as the agent tools.
        const labels = new Map(
          agentRegistry
            .listAgents()
            .filter((agent) => agent.hostId === hostId)
            .map((agent) => [agent.instanceId, agent.label]),
        );
        return {
          sessions: result.sessions.map((session) => {
            const label = labels.get(session.instanceId);
            return label === undefined ? session : { ...session, label };
          }),
        };
      } catch (err) {
        set.status = 504;
        return { error: (err as Error).message };
      }
    })

    .post("/:id/collab/:instanceId/link", async ({ params, body, set }) => {
      const hostId = params.id;
      const instanceId = params.instanceId;
      const payload = body as { generation?: unknown; access?: unknown };
      if (!COLLAB_INSTANCE_ID_RE.test(instanceId)) {
        set.status = 400;
        return { error: "Invalid Collab instance ID" };
      }
      if (
        typeof payload.generation !== "number" ||
        !Number.isSafeInteger(payload.generation) ||
        payload.generation < 0
      ) {
        set.status = 400;
        return { error: "generation must be a non-negative integer" };
      }
      if (payload.access !== "view" && payload.access !== "control") {
        set.status = 400;
        return { error: "access must be view or control" };
      }
      if (!agentRegistry.listHostIds().includes(hostId)) {
        set.status = 404;
        return { error: `host '${hostId}' not connected` };
      }
      if (!collabLimiter.allow(hostId)) {
        set.status = 429;
        set.headers["retry-after"] = "1";
        return { error: "Rate limit: collab (20 per 10s)" };
      }
      try {
        const result = await agentRegistry.callOnHost(
          hostId,
          "collab.link",
          {
            instanceId,
            generation: payload.generation,
            access: payload.access,
          },
          COLLAB_TIMEOUT_MS,
        );
        if (!result.url || !result.access) {
          set.status = 400;
          return { error: "Host did not return a Collab link" };
        }
        return {
          access: result.access,
          url: result.url,
          expiresAt: result.expiresAt ?? Date.now() + COLLAB_LINK_TTL_MS,
        };
      } catch (err) {
        set.status = 504;
        return { error: (err as Error).message };
      }
    });
}