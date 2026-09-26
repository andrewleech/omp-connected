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
    features: ["session.v1"],
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

// The writer session's side of the session.v1 routes: info, model/thinking
// controls and an in-memory directory tree for the Files tab. Loading the
// dashboard page resets it, so every test starts from the same state.
const models = [
  { provider: "anthropic", id: "claude-a", name: "Claude A" },
  { provider: "openai", id: "gpt-b", name: "GPT B" },
];
const writerInfo = {
  cwd: "/work/writer",
  pid: 4242,
  sessionName: "Writable room",
  access: "control",
  idle: true,
  model: models[0],
  thinkingLevel: "medium",
  thinkingLevels: ["off", "low", "medium", "high"],
  contextUsage: { tokens: 42_000, contextWindow: 200_000, percent: 21 },
  models,
};
const files = new Map<string, Uint8Array | "dir">();

function resetWriter(): void {
  writerInfo.model = models[0];
  writerInfo.thinkingLevel = "medium";
  files.clear();
  files.set("docs", "dir");
  files.set("docs/notes.md", new TextEncoder().encode("# notes\n"));
  files.set("README.md", new TextEncoder().encode("hello\n"));
}
resetWriter();

function listing(dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const entries = [...files]
    .filter(
      ([path]) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
    )
    .map(([path, value]) => ({
      name: path.slice(prefix.length),
      type: value === "dir" ? "dir" : "file",
      size: value === "dir" ? 0 : value.length,
      mtimeMs: 1_700_000_000_000,
    }))
    .sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
          ? -1
          : 1,
    );
  return { path: dir, entries };
}

async function writerSessionApi(
  request: Request,
  url: URL,
  route: string,
): Promise<Response> {
  const path = url.searchParams.get("path") ?? "";
  if (route === "/info") return json(writerInfo);
  if (route === "/model" && request.method === "POST") {
    const body = (await request.json()) as { provider: string; id: string };
    const model = models.find(
      (entry) => entry.provider === body.provider && entry.id === body.id,
    );
    if (!model)
      return Response.json({ error: "unknown model" }, { status: 404 });
    writerInfo.model = model;
    return json({ ok: true });
  }
  if (route === "/thinking" && request.method === "POST") {
    writerInfo.thinkingLevel = (
      (await request.json()) as { level: string }
    ).level;
    return json({ ok: true });
  }
  if (route === "/files") {
    if (path && files.get(path) !== "dir")
      return Response.json({ error: "not found" }, { status: 404 });
    return json(listing(path));
  }
  if (route === "/files/upload" && request.method === "PUT") {
    if (files.has(path) && url.searchParams.get("overwrite") !== "1")
      return Response.json(
        { error: `'${path}' already exists` },
        { status: 409 },
      );
    const data = new Uint8Array(await request.arrayBuffer());
    files.set(path, data);
    return json({ ok: true, path, size: data.length });
  }
  if (route === "/files/download") {
    const data = files.get(path);
    if (!data || data === "dir")
      return Response.json({ error: "not found" }, { status: 404 });
    return new Response(Buffer.from(data), {
      headers: { "content-disposition": "attachment" },
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

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
    const writerApi = "/api/hosts/writer/sessions/writer-room";
    if (url.pathname.startsWith(`${writerApi}/`))
      return writerSessionApi(
        request,
        url,
        url.pathname.slice(writerApi.length),
      );
    if (url.pathname.startsWith("/api/hosts/viewer/sessions/"))
      return Response.json(
        {
          error:
            "session's omp-connected extension does not support session.v1; restart the session to update it",
        },
        { status: 501 },
      );
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
    if (url.pathname === "/" || url.pathname === "/index.html") {
      resetWriter();
      return new Response(Bun.file(indexPath), {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === `/${appName}`)
      return new Response(Bun.file(`${webui}/${appName}`), {
        headers: { "content-type": "text/javascript" },
      });
    return new Response("Not found", { status: 404 });
  },
});
