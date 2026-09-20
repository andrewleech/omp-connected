// /ws/dashboard — pushes ONLY the events the server actually knows to be
// true the instant they happen: a host or agent connecting/disconnecting.
// Deliberately NOT a generic event bus: there is no ping/heartbeat tick,
// and Collab *session* state is never pushed here (the server only ever
// learns it by RPC-polling a host) — the webui polls for that on its own
// schedule plus a manual Refresh. This is the fix for the broadcast-storm
// bug found in claude-net's predecessor (every hub event, including a 5s
// heartbeat, triggered a full dashboard refetch and reloaded a live
// embedded iframe).

import { Elysia } from "elysia";
import type { AgentRegistry } from "./agent-registry";
import type { HostRegistry } from "./host-registry";
import type { DashboardEvent } from "./types";

interface DashboardWs {
  send(data: string): void;
  raw: object;
}

export function dashboardEventsPlugin(
  hostRegistry: HostRegistry,
  agentRegistry: AgentRegistry,
) {
  const clients = new Set<DashboardWs>();
  const broadcast = (event: DashboardEvent) => {
    const payload = JSON.stringify(event);
    for (const client of clients) client.send(payload);
  };
  hostRegistry.onChange(broadcast);
  agentRegistry.onChange(broadcast);

  return new Elysia().ws("/ws/dashboard", {
    open(ws: DashboardWs) {
      clients.add(ws);
    },
    close(ws: DashboardWs) {
      clients.delete(ws);
    },
    message() {
      // The dashboard never sends anything meaningful on this socket today.
    },
  });
}