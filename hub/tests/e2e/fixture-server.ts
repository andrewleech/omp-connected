const root = new URL("../..", import.meta.url).pathname;
const webui = `${root}dist/webui`;
const indexPath = `${webui}/index.html`;
const appName = (await Bun.file(indexPath).text()).match(
  /src="\/(app\.[^"]+\.js)"/,
)?.[1];

if (!appName)
  throw new Error("Dashboard bundle is missing; run build:webui first");

const sessions = {
  writer: {
    instanceId: "writer-room",
    generation: 1,
    access: "control",
    startedAt: 2,
    sessionName: "Writable room",
    cwd: "/work/writer",
    participants: 2,
  },
  viewer: {
    instanceId: "viewer-room",
    generation: 1,
    access: "view",
    startedAt: 1,
    sessionName: "Read-only room",
    cwd: "/work/viewer",
    participants: 1,
  },
};

const guest = `<!doctype html><html><body style="margin:0;background:#111;color:#fff;font:14px system-ui"><aside data-native-status-bar style="float:right;margin:12px;padding:8px;border:1px solid #65b9e8">project · main · active · model · context · 42 tok/s</aside><main style="padding:64px 12px">Collab control fixture</main></body></html>`;

function json(value: unknown): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}

Bun.serve({
  hostname: "127.0.0.1",
  port: 4173,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/hosts")
      return json([{ hostId: "writer" }, { hostId: "viewer" }]);
    if (url.pathname === "/api/hosts/writer/collab")
      return json({ sessions: [sessions.writer] });
    if (url.pathname === "/api/hosts/viewer/collab")
      return json({ sessions: [sessions.viewer] });
    if (url.pathname.endsWith("/link") && request.method === "POST") {
      const body = (await request.json()) as { access?: string };
      const writable = url.pathname.includes("writer-room");
      if (writable) await Bun.sleep(300);
      return json({
        access: body.access,
        url: `https://guest.invalid/room#fixture-${body.access}`,
      });
    }
    if (url.pathname === "/collab/" || url.pathname === "/collab/index.html")
      return new Response(guest, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/" || url.pathname === "/index.html")
      return new Response(Bun.file(indexPath), {
        headers: { "content-type": "text/html" },
      });
    if (url.pathname === `/${appName}`)
      return new Response(Bun.file(`${webui}/${appName}`), {
        headers: { "content-type": "text/javascript" },
      });
    return new Response("Not found", { status: 404 });
  },
});
