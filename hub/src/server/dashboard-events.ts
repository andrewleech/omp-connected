// /ws/dashboard — pushes ONLY the events the server actually knows to be
// true the instant they happen: an agent registering/disconnecting (which
// is also the only signal a host connecting/disconnecting has now that
// host-level Collab discovery is served through the same /ws/agent
// connection). Deliberately NOT a generic event bus: there is no
// ping/heartbeat tick, and Collab *session* state is never pushed here
// (the server only ever learns it by RPC-polling a host) — the webui
// polls for that on its own schedule plus a manual Refresh, avoiding a
// full dashboard refetch (and a reload of the live embedded Collab
// iframe) on anything but a real registration/disconnection.

import { Elysia } from "elysia";
import type { AgentRegistry } from "./agent-registry";
import type { DashboardEvent } from "./types";

interface DashboardWs {
  send(data: string): void;
  raw: object;
}

export function dashboardEventsPlugin(agentRegistry: AgentRegistry) {
  const clients = new Set<DashboardWs>();
  const broadcast = (event: DashboardEvent) => {
    const payload = JSON.stringify(event);
    for (const client of clients) client.send(payload);
  };
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