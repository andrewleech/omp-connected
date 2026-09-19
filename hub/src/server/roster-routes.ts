// Thin REST surface over RosterProxy, mounted same-origin with the webui so
// the browser never needs CORS or to know claude-net's origin directly.

import { Elysia } from "elysia";
import type { RosterProxy } from "./roster-proxy";

function callerKey(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  return xff
    ? (xff.split(",")[0]?.trim() ?? "unknown")
    : (request.headers.get("host") ?? "unknown");
}

export function rosterRoutes(roster: RosterProxy) {
  return new Elysia({ prefix: "/api/roster" })
    .get("/agents", async ({ set, request }) => {
      if (!roster.enabled) {
        set.status = 501;
        return {
          error: "CLAUDE_NET_HUB is not configured on this omp-hub instance",
        };
      }
      if (!roster.allow(callerKey(request))) {
        set.status = 429;
        return { error: "Rate limit: roster (30 per 10s)" };
      }
      try {
        return await roster.listAgents();
      } catch (err) {
        set.status = 502;
        return { error: (err as Error).message };
      }
    })

    .get("/teams", async ({ set, request }) => {
      if (!roster.enabled) {
        set.status = 501;
        return {
          error: "CLAUDE_NET_HUB is not configured on this omp-hub instance",
        };
      }
      if (!roster.allow(callerKey(request))) {
        set.status = 429;
        return { error: "Rate limit: roster (30 per 10s)" };
      }
      try {
        return await roster.listTeams();
      } catch (err) {
        set.status = 502;
        return { error: (err as Error).message };
      }
    })

    .post("/send", async ({ body, set, request }) => {
      if (!roster.enabled) {
        set.status = 501;
        return {
          error: "CLAUDE_NET_HUB is not configured on this omp-hub instance",
        };
      }
      if (!roster.allow(callerKey(request))) {
        set.status = 429;
        return { error: "Rate limit: roster (30 per 10s)" };
      }
      const payload = body as { to?: unknown; content?: unknown };
      if (
        typeof payload.to !== "string" ||
        typeof payload.content !== "string"
      ) {
        set.status = 400;
        return { error: "to and content are required strings" };
      }
      try {
        await roster.sendAgentMessage(payload.to, payload.content);
        return { ok: true };
      } catch (err) {
        set.status = 502;
        return { error: (err as Error).message };
      }
    })

    .post("/send_team", async ({ body, set, request }) => {
      if (!roster.enabled) {
        set.status = 501;
        return {
          error: "CLAUDE_NET_HUB is not configured on this omp-hub instance",
        };
      }
      if (!roster.allow(callerKey(request))) {
        set.status = 429;
        return { error: "Rate limit: roster (30 per 10s)" };
      }
      const payload = body as { team?: unknown; content?: unknown };
      if (
        typeof payload.team !== "string" ||
        typeof payload.content !== "string"
      ) {
        set.status = 400;
        return { error: "team and content are required strings" };
      }
      try {
        await roster.sendTeamMessage(payload.team, payload.content);
        return { ok: true };
      } catch (err) {
        set.status = 502;
        return { error: (err as Error).message };
      }
    });
}