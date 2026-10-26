import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@/server/agent-registry";
import { dashboardEventsPlugin } from "@/server/dashboard-events";
import { SessionGroupStore, sessionGroupRoutes } from "@/server/session-groups";
import type { DashboardEvent, SessionGroup } from "@/server/types";
import { Elysia } from "elysia";

const base = "http://localhost/api/groups";
const WRITER = "user@host-a:label:writer";
const VIEWER = "user@host-b:instance:viewer-room";

interface Routes {
  handle(request: Request): Promise<Response>;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-hub-groups-"));
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

function post(path: string, body: unknown): Request {
  return new Request(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function call(
  app: Routes,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.handle(request);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function createGroup(
  app: Routes,
  name: string,
  session?: string,
): Promise<SessionGroup> {
  const result = await call(app, post("", { name, session }));
  expect(result.status).toBe(200);
  return result.body.group as SessionGroup;
}

test("groups survive a restart through the state file", async () => {
  const app = sessionGroupRoutes(new SessionGroupStore(dir));
  const project = await createGroup(app, "  Project  ", WRITER);
  const empty = await createGroup(app, "Empty");
  expect(project.name).toBe("Project");
  expect(
    (await call(app, post("/assign", { session: VIEWER, groupId: project.id })))
      .status,
  ).toBe(200);

  const saved = JSON.parse(
    readFileSync(join(dir, "session-groups.json"), "utf8"),
  );
  expect(saved).toMatchObject({ version: 1, revision: 3 });
  expect(readdirSync(dir)).toEqual(["session-groups.json"]);

  const restarted = sessionGroupRoutes(new SessionGroupStore(dir));
  const reloaded = (await call(restarted, new Request(base))).body;
  expect(reloaded.revision).toBe(3);
  expect(reloaded.groups).toEqual([
    { id: project.id, name: "Project", sessions: [WRITER, VIEWER] },
    { id: empty.id, name: "Empty", sessions: [] },
  ]);
});

test("a missing state directory means no groups until the first change", async () => {
  const stateDir = join(dir, "nested", "omp-hub");
  const store = new SessionGroupStore(stateDir);
  expect(store.snapshot()).toEqual({ revision: 0, groups: [] });
  store.create("Project");
  expect(readdirSync(stateDir)).toEqual(["session-groups.json"]);
});

for (const [label, content] of [
  ["not JSON", "{not json"],
  ["wrong shape", JSON.stringify({ version: 1, groups: [{ id: 3 }] })],
  [
    "a member in two groups",
    JSON.stringify({
      version: 1,
      groups: [
        { id: "a", name: "A", sessions: [WRITER] },
        { id: "b", name: "B", sessions: [WRITER] },
      ],
    }),
  ],
] as const) {
  test(`a corrupt state file (${label}) is moved aside and the hub starts empty`, () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(join(dir, "session-groups.json"), content);
      const store = new SessionGroupStore(dir);
      expect(store.snapshot()).toEqual({ revision: 0, groups: [] });
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^session-groups\.json\.corrupt-\d+$/);
      expect(readFileSync(join(dir, files[0] ?? ""), "utf8")).toBe(content);
      expect(error).toHaveBeenCalledTimes(1);

      store.create("Fresh");
      expect(new SessionGroupStore(dir).snapshot().groups).toMatchObject([
        { name: "Fresh" },
      ]);
    } finally {
      error.mockRestore();
    }
  });
}

test("rejects invalid names, keys and group ids", async () => {
  const app = sessionGroupRoutes(new SessionGroupStore(dir));
  const group = await createGroup(app, "Project");
  for (const body of [
    {},
    { name: "" },
    { name: "   " },
    { name: 7 },
    { name: "x".repeat(65) },
    { name: "tab\there" },
    { name: "Ok", session: "writer-room" },
    { name: "Ok", session: "host:writer:1" },
    { name: "Ok", session: "host:label:has space" },
    { name: "Ok", session: null },
  ])
    expect((await call(app, post("", body))).status).toBe(400);
  for (const body of [
    { session: "nope", groupId: group.id },
    { session: WRITER, groupId: 5 },
    { session: WRITER },
  ])
    expect((await call(app, post("/assign", body))).status).toBe(400);
  const missing = await call(
    app,
    post("/assign", { session: WRITER, groupId: "missing" }),
  );
  expect(missing.status).toBe(404);
  expect((await call(app, new Request(base))).body.groups).toEqual([group]);
});

test("assignments from two clients at once both land", async () => {
  const store = new SessionGroupStore(dir);
  const first = sessionGroupRoutes(store);
  const second = sessionGroupRoutes(store);
  const project = await createGroup(first, "Project");
  const other = await createGroup(second, "Other");
  const results = await Promise.all([
    call(first, post("/assign", { session: WRITER, groupId: project.id })),
    call(second, post("/assign", { session: VIEWER, groupId: other.id })),
  ]);
  expect(results.map((result) => result.status)).toEqual([200, 200]);
  const expected = [
    { id: project.id, name: "Project", sessions: [WRITER] },
    { id: other.id, name: "Other", sessions: [VIEWER] },
  ];
  expect(store.snapshot()).toEqual({ revision: 4, groups: expected });
  expect(new SessionGroupStore(dir).snapshot().groups).toEqual(expected);
});

test("a session belongs to at most one group and can leave all of them", async () => {
  const store = new SessionGroupStore(dir);
  const app = sessionGroupRoutes(store);
  const project = await createGroup(app, "Project", WRITER);
  const other = await createGroup(app, "Other", WRITER);
  expect(store.snapshot().groups).toEqual([
    { id: project.id, name: "Project", sessions: [] },
    { id: other.id, name: "Other", sessions: [WRITER] },
  ]);
  await call(app, post("/assign", { session: WRITER, groupId: null }));
  expect(store.snapshot().groups.flatMap((group) => group.sessions)).toEqual(
    [],
  );
});

test("imports browser groups only while the hub has none", async () => {
  const store = new SessionGroupStore(dir);
  const app = sessionGroupRoutes(store);
  const imported = await call(
    app,
    post("/import", {
      groups: [
        { name: "Project", sessions: [WRITER, VIEWER] },
        { name: "Again", sessions: [WRITER] },
      ],
    }),
  );
  expect(imported.status).toBe(200);
  expect(store.snapshot().groups).toMatchObject([
    { name: "Project", sessions: [WRITER, VIEWER] },
    { name: "Again", sessions: [] },
  ]);
  const again = await call(
    app,
    post("/import", { groups: [{ name: "Late", sessions: [] }] }),
  );
  expect(again.status).toBe(409);
  expect(store.snapshot().groups).toHaveLength(2);
  expect(
    (
      await call(
        sessionGroupRoutes(new SessionGroupStore(join(dir, "other"))),
        post("/import", { groups: [{ name: "Bad", sessions: ["x"] }] }),
      )
    ).status,
  ).toBe(400);
});

test("a failed write answers 500 and keeps the previous groups", async () => {
  const store = new SessionGroupStore(dir);
  const app = sessionGroupRoutes(store);
  const project = await createGroup(app, "Project");
  const error = spyOn(console, "error").mockImplementation(() => {});
  chmodSync(dir, 0o500);
  try {
    const result = await call(
      app,
      post("/assign", { session: WRITER, groupId: project.id }),
    );
    expect(result.status).toBe(500);
    expect(store.snapshot()).toEqual({ revision: 1, groups: [project] });
  } finally {
    error.mockRestore();
  }
});

test("group changes are rate limited", async () => {
  const app = sessionGroupRoutes(new SessionGroupStore(dir));
  const statuses: number[] = [];
  for (let index = 0; index < 31; index++)
    statuses.push((await call(app, post("", { name: `G${index}` }))).status);
  expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
  expect(statuses[30]).toBe(429);
});

test("every change pushes the full list to dashboard sockets", async () => {
  const store = new SessionGroupStore(dir);
  const app = new Elysia()
    .use(sessionGroupRoutes(store))
    .use(dashboardEventsPlugin(new AgentRegistry(), store));
  app.listen(0);
  try {
    const socket = new WebSocket(
      `ws://localhost:${app.server?.port}/ws/dashboard`,
    );
    const opened = Promise.withResolvers<void>();
    socket.onopen = () => opened.resolve();
    await opened.promise;
    const received = Promise.withResolvers<DashboardEvent>();
    socket.onmessage = (event) =>
      received.resolve(JSON.parse(String(event.data)));
    const response = await fetch(
      `http://localhost:${app.server?.port}/api/groups`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Project", session: WRITER }),
      },
    );
    const { group } = (await response.json()) as { group: SessionGroup };
    expect(await received.promise).toEqual({
      event: "groups.changed",
      revision: 1,
      groups: [{ id: group.id, name: "Project", sessions: [WRITER] }],
    });
    socket.close();
  } finally {
    app.stop();
  }
});
