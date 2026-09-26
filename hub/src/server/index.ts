import { hostname as osHostname } from "node:os";
import { resolve as resolvePath } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import { Elysia } from "elysia";
import { type CollabRelay, startCollabRelay } from "../relay/relay";
import { AgentRegistry } from "./agent-registry";
import { agentRpcRoutes } from "./agent-rpc-routes";
import { collabRpcRoutes } from "./collab-rpc-routes";
import { loadConfig } from "./config";
import { dashboardEventsPlugin } from "./dashboard-events";
import { MAX_UPLOAD_BYTES, sessionRpcRoutes } from "./session-rpc-routes";
import { wsAgentPlugin } from "./ws-agent";

export interface CreateHubOptions {
  port?: number;
  host?: string;
  hostToken?: string;
  tls?: { cert: string; key: string };
  /** Root that holds the built webui (index.html + assets) and the vendored
   *  collab-web guest under `collab/`. Defaults to `dist/webui` next to the
   *  built server, produced by `scripts/build-webui.ts` /
   *  `scripts/build-vendor-collab.sh`. */
  webuiRoot?: string;
  /** Collab relay listener. Defaults to `OMP_HUB_RELAY_PORT`; `false`
   *  disables it. Shares the hub's bind host and TLS. */
  relay?: { port: number; allowedOrigins?: readonly string[] } | false;
}

export interface Hub {
  agentRegistry: AgentRegistry;
  stop(): void;
}

export function createHub(options: CreateHubOptions = {}): Hub {
  const env = loadConfig();
  const port = options.port ?? env.port;
  const host = options.host ?? env.host;
  const hostToken = options.hostToken ?? env.hostToken;
  const webuiRoot = options.webuiRoot ?? `${import.meta.dir}/../../dist/webui`;

  const agentRegistry = new AgentRegistry();

  const app = new Elysia()
    .get("/health", () => ({
      status: "ok",
      version: "0.1.0",
      hosts: agentRegistry.listHostIds().length,
      agents: agentRegistry.listAgents().length,
    }))
    .get(
      "/collab/",
      () =>
        new Response(Bun.file(`${webuiRoot}/collab/index.html`), {
          headers: { "content-type": "text/html" },
        }),
    )
    // Fixed-name PWA files must revalidate on every load so installed
    // clients see updates, so they're served here and excluded from the
    // static plugin below, which stamps its day-long max-age on them.
    .get("/sw.js", () => revalidatedFile(`${webuiRoot}/sw.js`))
    .get("/manifest.webmanifest", () =>
      revalidatedFile(`${webuiRoot}/manifest.webmanifest`),
    )
    .use(collabRpcRoutes(agentRegistry))
    .use(sessionRpcRoutes(agentRegistry))
    .use(agentRpcRoutes(agentRegistry, osHostname()))
    .use(wsAgentPlugin(agentRegistry, hostToken))
    .use(dashboardEventsPlugin(agentRegistry))
    .onBeforeHandle(({ request, set }) => {
      // index.html must always revalidate so the browser picks up
      // new hashed JS filenames on deploy.
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname.endsWith(".html")) {
        set.headers["cache-control"] = "no-cache";
      }
    })
    .use(
      staticPlugin({
        assets: webuiRoot,
        prefix: "/",
        alwaysStatic: true,
        indexHTML: true,
        directive: "public",
        maxAge: 86400,
        // String patterns match when they contain the file's absolute path.
        ignorePatterns: REVALIDATED_FILES.map((file) =>
          resolvePath(webuiRoot, file),
        ),
      }),
    );

  const tls =
    options.tls ??
    (env.tlsCert && env.tlsKey
      ? { cert: env.tlsCert, key: env.tlsKey }
      : undefined);
  app.listen({
    port,
    // Above the upload cap, so the upload route sees an oversized streamed
    // body and answers 413 itself (aborting the partial upload) before
    // Bun's own limit cuts the connection.
    maxRequestBodySize: MAX_UPLOAD_BYTES + 16 * 1024 * 1024,
    ...(host ? { hostname: host } : {}),
    ...(tls
      ? { tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) } }
      : {}),
  });
  console.log(
    `omp-hub listening on ${host ?? "0.0.0.0"}:${port}${tls ? " (TLS enabled)" : ""}`,
  );

  const relayOptions =
    options.relay ??
    (env.relayPort
      ? { port: env.relayPort, allowedOrigins: env.relayAllowedOrigins }
      : false);
  let relay: CollabRelay | undefined;
  if (relayOptions) {
    relay = startCollabRelay({
      hostname: host,
      port: relayOptions.port,
      webRoot: `${webuiRoot}/collab`,
      allowedOrigins: relayOptions.allowedOrigins,
      tls,
    });
    console.log(`collab relay listening on ${relay.url}`);
  }

  return {
    agentRegistry,
    stop: () => {
      relay?.stop();
      app.stop();
    },
  };
}

const REVALIDATED_FILES = ["sw.js", "manifest.webmanifest"];

function revalidatedFile(path: string): Response {
  // Bun.file infers content-type from the extension (sw.js ->
  // text/javascript, .webmanifest -> application/manifest+json).
  return new Response(Bun.file(path), {
    headers: { "cache-control": "no-cache" },
  });
}

if (import.meta.main) {
  createHub();
}
