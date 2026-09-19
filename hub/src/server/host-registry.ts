// Registry of connected omp-host sidecars. Deliberately lean: the only two
// RPCs this project ever needs are collab.list and collab.link. This is a
// from-scratch reimplementation, not a port of claude-net's HostRegistry —
// that class also carries Claude-Code-launch concepts (recentCwds,
// allowDangerousSkip, mirror-session orphan handling) that have no OMP
// analog and are deliberately not reproduced here.

import type {
  CollabLinkParams,
  CollabLinkResult,
  CollabListParams,
  CollabListResult,
  DashboardEvent,
  HostSummary,
} from "./types";

export interface HostConn {
  send(data: string): void;
  close(): void;
}

interface HostEntry {
  hostId: string;
  user: string;
  hostname: string;
  ompVersion: string;
  connectedAt: Date;
  conn: HostConn;
}

interface PendingCall {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export type CollabMethod = "collab.list" | "collab.link";

export interface CollabMethodParams {
  "collab.list": CollabListParams;
  "collab.link": CollabLinkParams;
}

export interface CollabMethodResult {
  "collab.list": CollabListResult;
  "collab.link": CollabLinkResult;
}

export class HostRegistry {
  private hosts = new Map<string, HostEntry>();
  /** Keyed by `${hostId}:${id}`. */
  private pending = new Map<string, PendingCall>();
  private onChangeFn: (event: DashboardEvent) => void = () => {};

  onChange(fn: (event: DashboardEvent) => void): void {
    this.onChangeFn = fn;
  }

  /** Registers a host, replacing (and closing) any prior connection for the
   *  same hostId — a fresh registration is authoritative. */
  register(
    params: {
      hostId: string;
      user: string;
      hostname: string;
      ompVersion: string;
    },
    conn: HostConn,
  ): HostSummary {
    const existing = this.hosts.get(params.hostId);
    if (existing) {
      this.rejectPendingFor(
        existing.hostId,
        new Error(`host '${existing.hostId}' re-registered`),
      );
      try {
        existing.conn.close();
      } catch {
        // already closing
      }
    }
    const entry: HostEntry = {
      hostId: params.hostId,
      user: params.user,
      hostname: params.hostname,
      ompVersion: params.ompVersion,
      connectedAt: new Date(),
      conn,
    };
    this.hosts.set(entry.hostId, entry);
    const summary = this.toSummary(entry);
    this.onChangeFn({ event: "host.connected", host: summary });
    return summary;
  }

  /** Removes a host by identity (its live connection). Idempotent. Rejects
   *  any RPCs still awaiting that host's reply. */
  unregister(hostId: string, conn: HostConn): void {
    const entry = this.hosts.get(hostId);
    if (!entry || entry.conn !== conn) return;
    this.hosts.delete(hostId);
    this.rejectPendingFor(hostId, new Error(`host '${hostId}' disconnected`));
    this.onChangeFn({ event: "host.disconnected", hostId });
  }

  get(hostId: string): boolean {
    return this.hosts.has(hostId);
  }

  list(): HostSummary[] {
    return [...this.hosts.values()].map((entry) => this.toSummary(entry));
  }

  /** Calls a method on a connected host and awaits its JSON-RPC reply. */
  async call<M extends CollabMethod>(
    hostId: string,
    method: M,
    params: CollabMethodParams[M],
    timeoutMs: number,
  ): Promise<CollabMethodResult[M]> {
    const entry = this.hosts.get(hostId);
    if (!entry) throw new Error(`host '${hostId}' not connected`);
    const id = crypto.randomUUID();
    const key = `${hostId}:${id}`;
    return new Promise<CollabMethodResult[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`host RPC ${method} timed out`));
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.pending.set(key, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      try {
        entry.conn.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(err as Error);
      }
    });
  }

  /** Called by the WS handler when a JSON-RPC result/error arrives from a host. */
  resolve(
    hostId: string,
    id: string,
    result: unknown | undefined,
    error: string | undefined,
  ): void {
    const key = `${hostId}:${id}`;
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (error !== undefined) pending.reject(new Error(error));
    else pending.resolve(result);
  }

  private rejectPendingFor(hostId: string, error: Error): void {
    const prefix = `${hostId}:`;
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private toSummary(entry: HostEntry): HostSummary {
    return {
      hostId: entry.hostId,
      user: entry.user,
      hostname: entry.hostname,
      ompVersion: entry.ompVersion,
      connectedAt: entry.connectedAt.toISOString(),
    };
  }
}