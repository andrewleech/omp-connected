// Narrow, one-way HTTP client of claude-net's existing public REST surface.
// omp-hub never shares source with claude-net; this is the only coupling,
// and it's read-mostly plus two message sends, entirely swappable by
// pointing CLAUDE_NET_HUB elsewhere. No CORS is required anywhere because
// the browser only ever talks to omp-hub same-origin; this proxy makes the
// server-to-server call.

import { RateLimiter } from "./rate-limit";

export interface AgentSummary {
  fullName: string;
  shortName: string;
  status: "online" | "offline";
}

export interface TeamSummary {
  name: string;
  members: string[];
}

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

const CACHE_TTL_MS = 4_000;

export class RosterProxy {
  private agentsCache: CacheEntry<AgentSummary[]> | undefined;
  private teamsCache: CacheEntry<TeamSummary[]> | undefined;
  private limiter = new RateLimiter({ max: 30, windowMs: 10_000 });

  constructor(private readonly claudeNetHub: string | undefined) {}

  get enabled(): boolean {
    return this.claudeNetHub !== undefined;
  }

  async listAgents(): Promise<AgentSummary[]> {
    if (
      this.agentsCache &&
      Date.now() - this.agentsCache.fetchedAt < CACHE_TTL_MS
    )
      return this.agentsCache.value;
    const value = await this.getJson<AgentSummary[]>("/api/agents");
    this.agentsCache = { value, fetchedAt: Date.now() };
    return value;
  }

  async listTeams(): Promise<TeamSummary[]> {
    if (
      this.teamsCache &&
      Date.now() - this.teamsCache.fetchedAt < CACHE_TTL_MS
    )
      return this.teamsCache.value;
    const value = await this.getJson<TeamSummary[]>("/api/teams");
    this.teamsCache = { value, fetchedAt: Date.now() };
    return value;
  }

  async sendAgentMessage(to: string, content: string): Promise<void> {
    await this.postJson("/api/send", { to, content });
  }

  async sendTeamMessage(team: string, content: string): Promise<void> {
    await this.postJson("/api/send_team", { team, content });
  }

  /** Applies to every roster-proxy call from a single caller key (the
   *  dashboard's own client IP) — this server becomes a new amplifying
   *  chokepoint once multiple dashboard tabs poll through it, even though
   *  claude-net's own /api/agents etc. have no rate limiting of their own. */
  allow(callerKey: string): boolean {
    return this.limiter.allow(callerKey);
  }

  private origin(): string {
    if (!this.claudeNetHub)
      throw new Error(
        "CLAUDE_NET_HUB is not configured on this omp-hub instance",
      );
    return this.claudeNetHub;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.origin()}${path}`);
    if (!response.ok)
      throw new Error(`claude-net ${path} returned ${response.status}`);
    return (await response.json()) as T;
  }

  private async postJson(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.origin()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`claude-net ${path} returned ${response.status}`);
  }
}