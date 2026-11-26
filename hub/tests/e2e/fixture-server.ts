import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionGroupStore,
  sessionGroupRoutes,
} from "../../src/server/session-groups";

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
      "session.agent_roles.v1",
      "session.usage.v1",
      "files.temp_upload.v1",
      "session.auth.v1",
      "session.transfer.v1",
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

// The guest's composer markup that the dashboard's send options hook
// (lib/scheduled-send.ts). Like the real React composer, the prompt lives in
// the page's own state, fed by input events, and Send is disabled while it
// is blank; Send logs the prompt into [data-sent]. The stub also provides
// the guest's embed API, window.ompCollabGuest: tests drive window.guestStub
// (sideRequests, failWith) from the page; a successful submitSideRequest()
// logs the draft into [data-side] and clears the composer like the real guest.
const guest = `<!doctype html><html><body style="margin:0;background:#111;color:#fff;font:14px system-ui"><aside data-native-status-bar style="float:right;margin:12px;padding:8px;border:1px solid #65b9e8">project · main · active · model · context · 42 tok/s</aside><main style="padding:64px 12px">Collab control fixture<ol data-sent></ol><ol data-side></ol></main>
<div class="sh-composer" style="position:fixed;left:0;right:0;bottom:0;padding:10px"><div class="sh-composer-inner" style="display:flex;gap:8px"><textarea class="sh-composer-input" aria-label="prompt" style="flex:1"></textarea><div class="sh-composer-actions"><button type="button" class="sh-btn sh-btn-primary">Send</button></div></div></div>
<script>
const input = document.querySelector(".sh-composer-input");
const composer = document.querySelector(".sh-composer");
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
const dropCount = document.createElement("output");
dropCount.dataset.dropCount = "0";
document.body.append(dropCount);
document.addEventListener("drop", () => {
  dropCount.dataset.dropCount = String(Number(dropCount.dataset.dropCount) + 1);
});
const imageAttachments = document.createElement("output");
imageAttachments.dataset.imageAttachments = "0";
document.body.append(imageAttachments);
composer.addEventListener("drop", (event) => {
  const count = [...(event.dataTransfer?.files ?? [])].filter((file) =>
    file.type.toLowerCase().startsWith("image/"),
  ).length;
  imageAttachments.dataset.imageAttachments = String(
    Number(imageAttachments.dataset.imageAttachments) + count,
  );
});
const guestStub = { sideRequests: false, failWith: "", calls: 0 };
window.guestStub = guestStub;
window.ompCollabGuest = {
  get sideRequests() { return guestStub.sideRequests; },
  async submitSideRequest() {
    if (!guestStub.sideRequests) throw new Error("Side requests are not available.");
    if (text.trim() === "") throw new Error("Type a request first.");
    guestStub.calls += 1;
    const sent = text;
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (guestStub.failWith) throw new Error(guestStub.failWith);
    const item = document.createElement("li");
    item.textContent = sent;
    document.querySelector("[data-side]").append(item);
    if (text === sent) { text = ""; input.value = ""; sync(); }
    return { agentId: "side-" + guestStub.calls };
  },
};
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
  cacheUsage: { hitTokens: 30_000, missTokens: 10_000 },
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
function agentRolesInfo() {
  const claudeA = { provider: "anthropic", id: "claude-a", name: "Claude A" };
  const base = {
    description: "",
    source: "bundled",
    filePath: null,
    disabled: false,
    overrideModel: null,
  };
  return {
    agents: [
      {
        ...base,
        name: "reviewer",
        description: "Reviews code",
        frontmatterModel: ["@default"],
        origin: "frontmatter",
        role: "default",
        patterns: ["anthropic/claude-a:high"],
        resolvedModel: claudeA,
        thinking: "high",
      },
      {
        ...base,
        name: "pinned-agent",
        source: "user",
        frontmatterModel: ["openai/gpt-b"],
        origin: "frontmatter",
        role: null,
        patterns: ["openai/gpt-b"],
        resolvedModel: { provider: "openai", id: "gpt-b", name: "GPT B" },
        thinking: null,
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
  whenIdle?: true;
}[] = [];

const launched: (typeof sessions.writer & {
  label: string;
  ompcLabel: string;
  sessionId: string;
})[] = [];

interface FakeAccount {
  credentialId: number;
  label: string;
  detail: string;
  type: "api_key" | "oauth";
  active: boolean;
}
interface FakeLogin {
  loginId: string;
  providerId: string;
  state: string;
  url?: string;
  instructions?: string;
  progress: string[];
  prompt?: { message: string; placeholder?: string; secret: boolean };
  identity?: string;
  error?: string;
  polls: number;
}
// Provider credentials and the single login in flight for the Login tab.
const authAccounts = new Map<string, FakeAccount[]>();
const authLogins = new Map<string, FakeLogin>();
let authSeq = 0;
const authProviders = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openrouter", name: "OpenRouter" },
];

function authPublic(login: FakeLogin) {
  const { polls: _polls, ...status } = login;
  return status;
}
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
// Send to host: one configured destination, plans that report an existing
// destination project, and one operation that advances a state on every
// GET /api/transfers/:id until it completes.
const transferDestination = { name: "buildbox", hostId: "buildbox-host" };
const transferSequence = [
  "source-stopping",
  "source-stopping",
  "publishing",
  "completed",
] as const;
const transferPlans = new Map<string, { digest: string; mode: string }>();
let transferPlanSeq = 0;
let transfer: {
  id: string;
  destination: string;
  projectMode: string;
  planDigest: string;
  startedAt: number;
  // Index into transferSequence; -1 until the first poll.
  index: number;
} | null = null;

function resetTransfers(): void {
  transferPlans.clear();
  transferPlanSeq = 0;
  transfer = null;
}

function transferView() {
  if (!transfer) throw new Error("No transfer");
  const current = transfer;
  const state =
    current.index < 0 ? "prepared" : transferSequence[current.index];
  const at = (step: number) =>
    new Date(current.startedAt + step * 1000).toISOString();
  return {
    id: current.id,
    sessionId: "sess-fixture-1",
    host: "writer",
    instance: "writer-room",
    destination: current.destination,
    state,
    lastConfirmedState: state,
    history: [
      { state: "prepared", at: at(0) },
      ...transferSequence
        .slice(0, current.index + 1)
        .map((step, i) => ({ state: step, at: at(i + 1) })),
    ],
    planDigest: current.planDigest,
    projectMode: current.projectMode,
    progress:
      state === "completed"
        ? undefined
        : { message: "Copying project", bytesDone: 512, bytesTotal: 1024 },
    workerStarted: true,
    createdAt: at(0),
    updatedAt: at(current.index + 1),
    commands: [],
    finished: state === "completed",
  };
}

async function transferApi(
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  const scoped = "/api/hosts/writer/sessions/writer-room/transfer/";
  if (url.pathname === "/api/transfers" && request.method === "GET")
    return json(transfer ? [transferView()] : []);
  const operation = url.pathname.match(/^\/api\/transfers\/([^/]+)$/);
  if (operation && request.method === "GET") {
    if (!transfer || transfer.id !== decodeURIComponent(operation[1] ?? ""))
      return Response.json({ error: "unknown transfer" }, { status: 404 });
    transfer.index = Math.min(transfer.index + 1, transferSequence.length - 1);
    return json(transferView());
  }
  if (!url.pathname.startsWith(scoped) || request.method !== "POST")
    return undefined;
  const route = url.pathname.slice(scoped.length);
  if (route === "destinations")
    return json({ enabled: true, destinations: [transferDestination] });
  if (route === "plan") {
    const body = (await request.json()) as {
      destination: string;
      projectMode?: string;
    };
    if (body.destination !== transferDestination.name)
      return Response.json({ error: "unknown destination" }, { status: 400 });
    const mode = body.projectMode ?? "session-only";
    const seq = ++transferPlanSeq;
    const planId = `plan-${seq}`;
    const digest = `digest-${seq}`;
    transferPlans.set(planId, { digest, mode });
    return json({
      planId,
      digest,
      plan: {
        mode,
        entries:
          mode === "update"
            ? [
                { path: "src/new.ts", action: "add", kind: "file", bytes: 512 },
                {
                  path: "src/more.ts",
                  action: "add",
                  kind: "file",
                  bytes: 512,
                },
                {
                  path: "package.json",
                  action: "replace",
                  kind: "file",
                  bytes: 512,
                },
              ]
            : [],
        unchanged: 40,
        destinationOnly: 3,
        totalBytes: mode === "update" ? 1536 : 0,
        conflicts: [],
        warnings: [],
      },
      preflight: {
        destinationExists: true,
        sourceProject: "/work/writer",
        destinationProject: "/home/dev/writer",
        sessionId: "sess-fixture-1",
        title: "Writable room",
        launcherName: "writer",
        children: 0,
        archiveBytes: 2_097_152,
        missingBlobs: [],
        externalReferences: [],
        skippedSymlinks: [],
        gitDirty: false,
        knownUsers: [],
        warnings: [],
        blockers: [],
        runtimeVersion: "omp 1.2.3",
        runtimeCompatible: true,
      },
    });
  }
  if (route === "commit") {
    const body = (await request.json()) as {
      destination: string;
      planId: string;
      planDigest: string;
      projectMode: string;
    };
    const plan = transferPlans.get(body.planId);
    if (
      body.destination !== transferDestination.name ||
      !plan ||
      plan.digest !== body.planDigest ||
      plan.mode !== body.projectMode
    )
      return Response.json(
        { error: "plan does not match the request" },
        { status: 400 },
      );
    if (transfer && transfer.index < transferSequence.length - 1)
      return Response.json(
        { error: "a transfer is already running" },
        { status: 409 },
      );
    transfer = {
      id: "transfer-1",
      destination: body.destination,
      projectMode: body.projectMode,
      planDigest: body.planDigest,
      startedAt: Date.now(),
      index: -1,
    };
    return json({ operationId: transfer.id });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

let withoutScheduleNext = false;
function setWriterSchedule(on: boolean): void {
  const features = sessions.writer.features;
  const at = features.indexOf("session.schedule.v1");
  if (on && at < 0) features.push("session.schedule.v1");
  else if (!on && at >= 0) features.splice(at, 1);
}
let writerExited = false;
// The writer's agent registered as ompc session "writer"; POST /__forget-label
// lists it without that name, as a restarted hub does until it re-registers.
let writerOmpcLabelKnown = true;
function resetWriter(): void {
  writerExited = false;
  writerOmpcLabelKnown = true;
  resetTransfers();
  sessions.writer.generation = 1;
  launched.length = 0;
  writerInfo.model = models[0];
  roleAssignments.set("default", "anthropic/claude-a:high");
  roleAssignments.set("custom-review", null);
  writerInfo.thinkingLevel = "medium";
  files.clear();
  scheduled.length = 0;
  authLogins.clear();
  authAccounts.clear();
  authAccounts.set("anthropic", [
    {
      credentialId: 1,
      label: "work@example.com",
      detail: "OAuth",
      type: "oauth",
      active: true,
    },
  ]);
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
  if (route === "/auth" && request.method === "GET") {
    return json({
      providers: authProviders.map((provider) => {
        const accounts = authAccounts.get(provider.id) ?? [];
        return {
          ...provider,
          available: true,
          authenticated: accounts.length > 0,
          accounts,
        };
      }),
    });
  }
  if (route === "/auth/logins" && request.method === "POST") {
    const body = (await request.json()) as { providerId?: string };
    if (!authProviders.some((provider) => provider.id === body.providerId))
      return Response.json({ error: "unknown provider" }, { status: 400 });
    if (
      [...authLogins.values()].some(
        (l) => l.state === "awaiting_auth" || l.state === "awaiting_input",
      )
    )
      return Response.json({ error: "login in flight" }, { status: 409 });
    authSeq += 1;
    const login: FakeLogin = {
      loginId: `login-${authSeq}`,
      providerId: body.providerId as string,
      state: "awaiting_auth",
      url: "https://auth.example.com/authorize?state=fixture",
      instructions: "Sign in, then copy the redirect URL.",
      progress: ["Waiting for sign-in"],
      polls: 0,
    };
    authLogins.set(login.loginId, login);
    return json(authPublic(login));
  }
  const authLogin = route.match(/^\/auth\/logins\/([^/]+)(\/input)?$/);
  if (authLogin) {
    const login = authLogins.get(authLogin[1] as string);
    if (!login) return Response.json({ error: "not found" }, { status: 404 });
    if (!authLogin[2] && request.method === "GET") {
      login.polls += 1;
      if (login.state === "awaiting_auth" && login.polls >= 1) {
        login.state = "awaiting_input";
        login.prompt = {
          message: "Paste the redirect URL or API key",
          placeholder: "http://localhost:1455/callback?code=...",
          secret: true,
        };
      }
      return json(authPublic(login));
    }
    if (authLogin[2] && request.method === "POST") {
      if (login.state !== "awaiting_input")
        return Response.json({ error: "no pending prompt" }, { status: 400 });
      const body = (await request.json()) as { value: string };
      if (body.value === "") {
        login.state = "failed";
        login.error = "Empty input";
      } else {
        login.state = "done";
        login.identity = "fixture identity";
        login.progress.push("Login complete");
        const accounts = authAccounts.get(login.providerId) ?? [];
        accounts.push({
          credentialId: accounts.length + 10,
          label: "fixture identity",
          detail: "OAuth",
          type: "oauth",
          active: accounts.length === 0,
        });
        authAccounts.set(login.providerId, accounts);
      }
      login.prompt = undefined;
      return json({ ok: true });
    }
    if (!authLogin[2] && request.method === "DELETE") {
      if (login.state !== "done" && login.state !== "failed") {
        login.state = "cancelled";
        login.prompt = undefined;
      }
      return json({ ok: true });
    }
  }
  const authAccount = route.match(/^\/auth\/accounts\/([^/]+)\/(\d+)$/);
  if (authAccount && request.method === "DELETE") {
    const providerId = authAccount[1] as string;
    const accounts = authAccounts.get(providerId) ?? [];
    const at = accounts.findIndex(
      (account) => account.credentialId === Number(authAccount[2]),
    );
    if (at === -1)
      return Response.json({ error: "not found" }, { status: 404 });
    accounts.splice(at, 1);
    authAccounts.set(providerId, accounts);
    return json({ ok: true, remainingSource: null });
  }
  if (route === "/usage") {
    const generatedAt = Date.now();
    return json({
      generatedAt,
      reports: [
        {
          provider: "anthropic",
          fetchedAt: generatedAt - 30_000,
          limits: [
            {
              label: "Weekly",
              unit: "percent",
              used: 42,
              limit: 100,
              remaining: 58,
              usedFraction: 0.42,
              status: "ok",
              window: {
                label: "7 Day",
                resetsAt: generatedAt + 3_600_000,
                resetLabel: "Resets",
              },
            },
          ],
        },
      ],
    });
  }
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
    const body = (await request.json()) as {
      text: string;
      delayMs: number;
      whenIdle?: boolean;
    };
    const now = Date.now();
    const prompt = {
      id: `p${now}${scheduled.length}`,
      text: body.text,
      fireAt: now + body.delayMs,
      createdAt: now,
      ...(body.whenIdle ? { whenIdle: true as const } : {}),
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
    const uploadedPath =
      url.searchParams.get("destination") === "temp" ? `/tmp/${path}` : path;
    if (files.has(uploadedPath) && url.searchParams.get("overwrite") !== "1")
      return Response.json(
        { error: `'${uploadedPath}' already exists` },
        { status: 409 },
      );
    const data = new Uint8Array(await request.arrayBuffer());
    files.set(uploadedPath, data);
    return json({ ok: true, path: uploadedPath, size: data.length });
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

// Session groups use the hub's own store and routes. Loading the dashboard
// page starts them over with an empty state dir.
let groupsDir = "";
let groupStore: SessionGroupStore;
function freshGroups() {
  if (groupsDir) rmSync(groupsDir, { recursive: true, force: true });
  groupsDir = mkdtempSync(join(tmpdir(), "omp-hub-e2e-groups-"));
  groupStore = new SessionGroupStore(groupsDir, {
    ompcLabel(hostId, instanceId) {
      if (hostId !== "writer") return undefined;
      if (instanceId === "writer-room") return "writer";
      return launched.find((session) => session.instanceId === instanceId)
        ?.ompcLabel;
    },
    onChange() {
      return () => {};
    },
  });
  groupStore.onChange((list) => {
    const event = JSON.stringify({ event: "groups.changed", ...list });
    for (const socket of dashboardSockets) socket.send(event);
  });
  return sessionGroupRoutes(groupStore);
}
let groupRoutes = freshGroups();

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
    if (
      url.pathname === "/api/groups" ||
      url.pathname.startsWith("/api/groups/")
    )
      return groupRoutes.handle(request);
    // Hosts the writer's room again under a new generation, then drops the
    // dashboard sockets so the dashboard reconnects and reloads the listing.
    if (url.pathname === "/__relaunch" && request.method === "POST") {
      sessions.writer.generation++;
      for (const socket of dashboardSockets) socket.close();
      return json({ ok: true });
    }
    if (url.pathname === "/__forget-label" && request.method === "POST") {
      writerOmpcLabelKnown = false;
      for (const socket of dashboardSockets) socket.close();
      return json({ ok: true });
    }
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
            features: [...sessions.writer.features],
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
    // The next dashboard page load lists the writer without
    // session.schedule.v1, as a session whose extension predates scheduling.
    if (url.pathname === "/__without-schedule" && request.method === "POST") {
      withoutScheduleNext = true;
      return json({ ok: true });
    }
    if (url.pathname === "/api/hosts")
      return json([{ hostId: "writer" }, { hostId: "viewer" }]);
    if (url.pathname === "/api/hosts/writer/collab") {
      const listed = [
        ...(writerExited
          ? []
          : [
              {
                ...sessions.writer,
                ...(writerOmpcLabelKnown ? { ompcLabel: "writer" } : {}),
              },
            ]),
        ...launched,
      ];
      groupStore.observe("writer", listed);
      return json({ sessions: listed });
    }
    if (url.pathname === "/api/hosts/viewer/collab") {
      groupStore.observe("viewer", [sessions.viewer]);
      return json({ sessions: [sessions.viewer] });
    }
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
        reservedLabels?: string[];
      };
      const directory = body.cwd.split("/").pop() ?? "";
      const base = directory + (body.name ? `.${body.name}` : "");
      let label = base;
      let suffix = 2;
      while (body.reservedLabels?.includes(label)) {
        const number = String(suffix++);
        const available = 64 - directory.length - 1;
        if (number.length > available)
          return Response.json(
            {
              error:
                "The directory name leaves no room for a distinct session name. Choose a shorter directory name.",
            },
            { status: 400 },
          );
        const prefix = body.name.slice(
          0,
          Math.max(0, available - number.length - 1),
        );
        label = `${directory}.${prefix ? `${prefix}-${number}` : number}`;
      }
      if (launched.some((session) => session.label === label))
        return Response.json(
          { error: "This ompc name already exists." },
          { status: 409 },
        );
      const session = {
        ...sessions.writer,
        cwd: body.cwd,
        label,
        ompcLabel: label,
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
        ompcLabel: label,
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
    if (
      url.pathname === "/api/hosts/writer/sessions/writer-room/agent-roles" &&
      request.method === "GET"
    )
      return json(agentRolesInfo());
    const transferResponse = await transferApi(request, url);
    if (transferResponse) return transferResponse;
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
      setWriterSchedule(!withoutScheduleNext);
      withoutScheduleNext = false;
      groupRoutes = freshGroups();
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
