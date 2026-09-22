// Environment configuration. Fails fast and loud on a missing required
// variable rather than silently falling back to an insecure default.

export interface HubConfig {
  port: number;
  /** Bind address. Unset means Bun's own default (all interfaces) — set
   *  this to a specific Tailnet IP in any deployment reachable beyond
   *  localhost, so the process is never wildcard-bound by accident. */
  host: string | undefined;
  hostToken: string;
  tlsCert: string | undefined;
  tlsKey: string | undefined;
  /** Collab relay listener port. Unset means the relay does not start. */
  relayPort: number | undefined;
  /** Browser origins allowed to open relay WebSockets. Empty allows any. */
  relayAllowedOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const hostToken = env.OMP_HUB_HOST_TOKEN;
  if (!hostToken) throw new Error("OMP_HUB_HOST_TOKEN is required");
  return {
    port: Number(env.OMP_HUB_PORT) || 4816,
    host: env.OMP_HUB_HOST,
    hostToken,
    tlsCert: env.OMP_HUB_TLS_CERT,
    tlsKey: env.OMP_HUB_TLS_KEY,
    relayPort: Number(env.OMP_HUB_RELAY_PORT) || undefined,
    relayAllowedOrigins: (env.OMP_HUB_RELAY_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}