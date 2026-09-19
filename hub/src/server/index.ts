import { staticPlugin } from "@elysiajs/static";
import { Elysia } from "elysia";
import { loadConfig } from "./config";
import { dashboardEventsPlugin } from "./dashboard-events";
import { HostRegistry } from "./host-registry";
import { hostRpcRoutes } from "./host-rpc-routes";
import { wsHostPlugin } from "./ws-host";

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
}

export interface Hub {
  registry: HostRegistry;
  stop(): void;
}

export function createHub(options: CreateHubOptions = {}): Hub {
  const env = loadConfig();
  const port = options.port ?? env.port;
  const host = options.host ?? env.host;
  const hostToken = options.hostToken ?? env.hostToken;
  const webuiRoot = options.webuiRoot ?? `${import.meta.dir}/../../dist/webui`;

  const registry = new HostRegistry();

  const app = new Elysia()
    .get("/health", () => ({
      status: "ok",
      version: "0.1.0",
      hosts: registry.list().length,
    }))
    .get(
      "/collab/",
      () =>
        new Response(Bun.file(`${webuiRoot}/collab/index.html`), {
          headers: { "content-type": "text/html" },
        }),
    )
    .use(hostRpcRoutes(registry))
    .use(wsHostPlugin(registry, hostToken))
    .use(dashboardEventsPlugin(registry))
    .use(
      staticPlugin({
        assets: webuiRoot,
        prefix: "/",
        alwaysStatic: true,
        indexHTML: true,
        directive: "public",
        maxAge: 3600,
      }),
    );

  const tls =
    options.tls ??
    (env.tlsCert && env.tlsKey
      ? { cert: env.tlsCert, key: env.tlsKey }
      : undefined);
  app.listen({
    port,
    ...(host ? { hostname: host } : {}),
    ...(tls
      ? { tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) } }
      : {}),
  });
  console.log(
    `omp-hub listening on ${host ?? "0.0.0.0"}:${port}${tls ? " (TLS enabled)" : ""}`,
  );

  return {
    registry,
    stop: () => app.stop(),
  };
}

if (import.meta.main) {
  createHub();
}