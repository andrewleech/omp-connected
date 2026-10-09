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
    features: [
      "session.v1",
      "session.schedule.v1",
      "session.exit.v1",
      "session.fork.v1",
      "session.model_roles.v1",
    ],
  },
  viewer: {
    instanceId: "viewer-room",
    generation: 1,
    access: "view",
    startedAt: 1,
    sessionName: "Read-only room",
    cwd: "/work/viewer",
    participants: 1,
    features: ["session.model_roles.v1"],
  },
};

// The guest's composer markup that the dashboard's scheduled send hooks
// (lib/scheduled-send.ts). Like the real React composer, the prompt lives in
// the page's own state, fed by input events, and Send is disabled while it
// is blank; Send logs the prompt into [data-sent].
const guest = `<!doctype html><html><body style="margin:0;background:#111;color:#fff;font:14px system-ui"><aside data-native-status-bar style="float:right;margin:12px;padding:8px;border:1px solid #65b9e8">project · main · active · model · context · 42 tok/s</aside><main style="padding:64px 12px">Collab control fixture<ol data-sent></ol></main>
<div class="sh-composer" style="position:fixed;left:0;right:0;bottom:0;padding:10px"><div class="sh-composer-inner" style="display:flex;gap:8px"><textarea class="sh-composer-input" aria-label="prompt" style="flex:1"></textarea><div class="sh-composer-actions"><button type="button" class="sh-btn sh-btn-primary">Send</button></div></div></div>
<script>
const input = document.querySelector(".sh-composer-input");
const send = document.querySelector(".sh-btn-primary");
let text = "";
const sync = () => { send.disabled = text.trim() === ""; };
input.addEventListener("input", () => { text = input.value; sync(); });
send.addEventListener("click", () => {
  const item = document.createElement("li");
  item.textContent = text;
  document.querySelector("[data-sent]").append(item);
  text = "";
  input.value = "";
  sync();
});
sync();
</script></body></html>`;

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
const roleModels = [
  {
    provider: "anthropic",
    id: "claude-a",
    name: "Claude A",
    thinkingLevels: ["off", "low", "medium", "high"],
  },
  {
    provider: "openai",
    id: "gpt-b",
    name: "GPT B",
    thinkingLevels: ["off", "low", "medium"],
  },
];
const roleAssignments = new Map<string, string | null>([
  ["default", "anthropic/claude-a:high"],
  ["custom-review", null],
]);
function modelRolesInfo(access: "view" | "control") {
  const projectDefault = roleAssignments.get("default") ?? null;
  const globalDefault = "openai/gpt-b";
  const selector = projectDefault ?? globalDefault;
  const custom = roleAssignments.get("custom-review") ?? null;
  const resolvedModel = selector.startsWith("anthropic/")
    ? { provider: "anthropic", id: "claude-a", name: "Claude A" }
    : { provider: "openai", id: "gpt-b", name: "GPT B" };
  return {
    access,
    storage: "project",
    roles: [
      {
        id: "default",
        name: "Default",
        selector,
        provenance: projectDefault ? "Project setting" : "Global setting",
        globalSelector: globalDefault,
        projectSelector: projectDefault,
        resolvedModel,
        models: roleModels,
      },
      {
        id: "custom-review",
        name: "Custom review",
        selector: custom,
        provenance: custom ? "Project setting" : "Automatic / fallback",
        globalSelector: null,
        projectSelector: custom,
        resolvedModel: { provider: "openai", id: "gpt-b", name: "GPT B" },
        models: roleModels,
      },
    ],
  };
}
const files = new Map<string, Uint8Array | "dir">();
const scheduled: {
  id: string;
  text: string;
  fireAt: number;
  createdAt: number;
}[] = [];

const launched: (typeof sessions.writer & {
  label: string;
  sessionId: string;
})[] = [];
const history = [
  {
    sessionId: "past-new",
    cwd: "/work/project",
    title: "Recent conversation",
    modifiedAt: 1_800_000_000_000,
    name: "review",
  },
  {
    sessionId: "past-old",
    cwd: "/work/other",
    title: "Older conversation",
    modifiedAt: 1_700_000_000_000,
  },
];
let writerExited = false;
function resetWriter(): void {
  writerExited = false;
  launched.length = 0;
  writerInfo.model = models[0];
  roleAssignments.set("default", "anthropic/claude-a:high");
  roleAssignments.set("custom-review", null);
  writerInfo.thinkingLevel = "medium";
  files.clear();
  scheduled.length = 0;
  files.set("docs", "dir");
  files.set("docs/notes.md", new TextEncoder().encode("# notes\n"));
  files.set(
    "README.md",
    new TextEncoder().encode(
      "# Hello\n\nsome **bold** text <script>window.parent.document.title='pwned'</script>\n\n[site](https://example.com) [local](other.md)\n",
    ),
  );
  files.set("run.sh", new TextEncoder().encode("#!/bin/sh\necho hi\n"));
  files.set("blob.dat", new Uint8Array([1, 2, 0, 3, 255]));
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
  if (route === "/exit" && request.method === "POST") {
    writerExited = true;
    return json({ ok: true });
  }
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
  if (route === "/scheduled" && request.method === "GET")
    return json({ prompts: scheduled });
  if (route === "/scheduled" && request.method === "POST") {
    const body = (await request.json()) as { text: string; delayMs: number };
    const now = Date.now();
    const prompt = {
      id: `p${now}${scheduled.length}`,
      text: body.text,
      fireAt: now + body.delayMs,
      createdAt: now,
    };
    scheduled.push(prompt);
    return json(prompt);
  }
  if (route.startsWith("/scheduled/") && request.method === "DELETE") {
    const at = scheduled.findIndex(
      (prompt) => prompt.id === route.slice("/scheduled/".length),
    );
    if (at === -1)
      return Response.json({ error: "not found" }, { status: 404 });
    scheduled.splice(at, 1);
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

// The writer session's agent registration; the viewer has none, so it shows
// no activity dot. A test flips `busy` through POST /__activity.
let writerBusy = true;
const dashboardSockets = new Set<{ send(data: string): void; close(): void }>();

Bun.serve({
  hostname: "127.0.0.1",
  port: 4173,
  websocket: {
    open: (socket) => {
      dashboardSockets.add(socket);
    },
    close: (socket) => {
      dashboardSockets.delete(socket);
    },
    message: () => {},
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws/dashboard" && server.upgrade(request)) return;
    if (url.pathname === "/api/agents")
      return json({
        agents: [
          {
            id: "writer:writer-room",
            hostId: "writer",
            instanceId: "writer-room",
            label: "Writable room",
            cwd: "/work/writer",
            pid: 4242,
            connectedAt: new Date(0).toISOString(),
            teams: [],
            features: ["session.v1"],
            busy: writerBusy,
          },
        ],
      });
    // Changes the state without telling the dashboard, then drops its sockets.
    if (url.pathname === "/__drop" && request.method === "POST") {
      writerBusy = url.searchParams.get("busy") === "1";
      for (const socket of dashboardSockets) socket.close();
      return json({ ok: true });
    }
    if (url.pathname === "/__activity" && request.method === "POST") {
      writerBusy = url.searchParams.get("busy") === "1";
      const event = JSON.stringify({
        event: "agent.activity",
        agentId: "writer:writer-room",
        busy: writerBusy,
      });
      for (const socket of dashboardSockets) socket.send(event);
      return json({ ok: true });
    }
    if (url.pathname === "/api/hosts")
      return json([{ hostId: "writer" }, { hostId: "viewer" }]);
    if (url.pathname === "/api/hosts/writer/collab")
      return json({
        sessions: [...(writerExited ? [] : [sessions.writer]), ...launched],
      });
    if (url.pathname === "/api/hosts/viewer/collab")
      return json({ sessions: [sessions.viewer] });
    if (url.pathname === "/api/hosts/writer/session-history")
      return json({
        sessions: history.filter(
          (entry) =>
            !launched.some((session) => session.sessionId === entry.sessionId),
        ),
      });
    if (url.pathname === "/api/hosts/viewer/session-history")
      return Response.json(
        {
          error:
            "This host needs a control-shared OMP session to list or start sessions.",
        },
        { status: 403 },
      );
    if (
      url.pathname === "/api/hosts/writer/sessions" &&
      request.method === "POST"
    ) {
      const body = (await request.json()) as {
        cwd: string;
        name: string;
        sessionId?: string;
      };
      const label =
        body.cwd.split("/").pop() + (body.name ? `.${body.name}` : "");
      if (launched.some((session) => session.label === label))
        return Response.json(
          { error: "This ompc name already exists." },
          { status: 409 },
        );
      const session = {
        ...sessions.writer,
        cwd: body.cwd,
        label,
        instanceId: `launched-${launched.length}`,
        sessionId: body.sessionId ?? `new-${launched.length}`,
        sessionName: body.sessionId
          ? (history.find((session) => session.sessionId === body.sessionId)
              ?.title ?? "")
          : "New conversation",
      };
      launched.push(session);
      return json({ ok: true, label });
    }
    const forkMatch = url.pathname.match(
      /^\/api\/hosts\/writer\/sessions\/writer-room\/fork$/,
    );
    if (forkMatch && request.method === "POST") {
      const body = (await request.json()) as { name: string };
      const label = `writer.${body.name}`;
      if (launched.some((session) => session.label === label))
        return Response.json(
          { error: "This ompc name already exists." },
          { status: 409 },
        );
      launched.push({
        ...sessions.writer,
        label,
        instanceId: `launched-${launched.length}`,
        sessionId: `fork-${launched.length}`,
        sessionName: "Forked conversation",
      });
      return json({ ok: true, label });
    }

    const rolesMatch = url.pathname.match(
      /^\/api\/hosts\/(writer|viewer)\/sessions\/(writer-room|viewer-room)\/model-roles$/,
    );
    if (rolesMatch) {
      const access = rolesMatch[1] === "writer" ? "control" : "view";
      if (request.method === "GET") return json(modelRolesInfo(access));
      if (request.method === "POST") {
        if (access !== "control")
          return Response.json(
            { error: "control access required" },
            { status: 403 },
          );
        const body = (await request.json()) as {
          role: string;
          selector: string | null;
        };
        if (!roleAssignments.has(body.role))
          return Response.json({ error: "unknown role" }, { status: 400 });
        roleAssignments.set(body.role, body.selector);
        return json(modelRolesInfo(access));
      }
    }
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
      writerBusy = true;
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
