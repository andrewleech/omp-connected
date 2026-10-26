import { homedir } from "node:os";
import { join } from "node:path";

// Environment configuration. Fails fast and loud on a missing required
// variable rather than silently falling back to an insecure default.

export interface HubConfig {
  port: number;
  /** Bind address. Unset means Bun's own default (all interfaces) — set
   *  this to a specific Tailnet IP in any deployment reachable beyond
   *  localhost, so the process is never wildcard-bound by accident. */
  host: string | undefined;
  publicOrigin: string | null;
  hostToken: string;
  tlsCert: string | undefined;
  tlsKey: string | undefined;
  /** Collab relay listener port. Unset means the relay does not start. */
  relayPort: number | undefined;
  /** Browser origins allowed to open relay WebSockets. Empty allows any. */
  relayAllowedOrigins: string[];
  /** Directory for the hub's own persistent state (session groups). */
  stateDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const hostToken = env.OMP_HUB_HOST_TOKEN;
  if (!hostToken) throw new Error("OMP_HUB_HOST_TOKEN is required");
  const port = Number(env.OMP_HUB_PORT) || 4816;
  const hostname = env.OMP_HUB_HOSTNAME;
  const tlsCert = env.OMP_HUB_TLS_CERT;
  const tlsKey = env.OMP_HUB_TLS_KEY;
  const publicOrigin =
    hostname && tlsCert && tlsKey
      ? new URL(`https://${hostname}:${port}`).origin
      : null;
  return {
    port,
    host: env.OMP_HUB_HOST,
    publicOrigin,
    hostToken,
    tlsCert,
    tlsKey,
    relayPort: Number(env.OMP_HUB_RELAY_PORT) || undefined,
    relayAllowedOrigins: (env.OMP_HUB_RELAY_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    stateDir:
      env.OMP_HUB_STATE_DIR ||
      join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "omp-hub"),
  };
}
