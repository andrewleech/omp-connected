// /ws/host — JSON-RPC 2.0 over one WebSocket per connected omp-host
// sidecar. The only inbound method a host ever sends is `host.register`;
// after that, this server drives collab.list/collab.link *at* the host and
// the host replies with a plain JSON-RPC result/error using the same id.
//
// Unlike claude-net's old /ws/host (implicitly trusted by Tailscale-only
// network position), registration requires a shared-secret token — this
// server is reachable more broadly than that assumption safely covers.

import { Elysia } from "elysia";
import type { HostConn, HostRegistry } from "./host-registry";
import type { HostRegisterParams } from "./types";

interface HostWs {
  send(data: string): void;
  raw: object;
  close(code?: number, reason?: string): void;
}

interface Registered {
  hostId: string;
  conn: HostConn;
}

const registeredByConn = new WeakMap<object, Registered>();

function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isHostRegisterParams(value: unknown): value is HostRegisterParams {
  return (
    !!value &&
    typeof value === "object" &&
    "hostId" in value &&
    typeof value.hostId === "string" &&
    "user" in value &&
    typeof value.user === "string" &&
    "hostname" in value &&
    typeof value.hostname === "string" &&
    "ompVersion" in value &&
    typeof value.ompVersion === "string" &&
    "token" in value &&
    typeof value.token === "string"
  );
}

export function wsHostPlugin(registry: HostRegistry, hostToken: string) {
  return new Elysia().ws("/ws/host", {
    message(ws: HostWs, rawData: unknown) {
      const data = safeJsonParse(rawData);
      if (
        !data ||
        typeof data !== "object" ||
        !("id" in data) ||
        typeof data.id !== "string"
      )
        return;
      const id = data.id;

      if ("method" in data && data.method === "host.register") {
        const params = "params" in data ? data.params : undefined;
        if (!isHostRegisterParams(params)) {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: "host.register missing required params",
              },
            }),
          );
          ws.close();
          return;
        }
        if (params.token !== hostToken) {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32001, message: "invalid host token" },
            }),
          );
          ws.close();
          return;
        }
        const conn: HostConn = {
          send: (payload) => ws.send(payload),
          close: () => ws.close(),
        };
        const summary = registry.register(
          {
            hostId: params.hostId,
            user: params.user,
            hostname: params.hostname,
            ompVersion: params.ompVersion,
          },
          conn,
        );
        registeredByConn.set(ws.raw, { hostId: summary.hostId, conn });
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { ok: true, hostId: summary.hostId },
          }),
        );
        return;
      }

      // A JSON-RPC result/error from the host, replying to a collab.list /
      // collab.link call this server made earlier.
      const registered = registeredByConn.get(ws.raw);
      if (!registered) return; // frames before registration are ignored
      const hostId = registered.hostId;

      if ("result" in data) {
        registry.resolve(hostId, id, data.result, undefined);
        return;
      }
      if (
        "error" in data &&
        data.error &&
        typeof data.error === "object" &&
        "message" in data.error &&
        typeof data.error.message === "string"
      ) {
        registry.resolve(hostId, id, undefined, data.error.message);
        return;
      }
    },

    close(ws: HostWs) {
      const registered = registeredByConn.get(ws.raw);
      if (!registered) return;
      registeredByConn.delete(ws.raw);
      registry.unregister(registered.hostId, registered.conn);
    },
  });
}