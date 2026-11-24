import {
  type APIRequestContext,
  type Page,
  expect,
  test,
} from "@playwright/test";

const WRITER = '.session-card[title="Writable room"]';
const VIEWER = '.session-card[title="Read-only room"]';

function group(page: Page, name: string) {
  return page
    .locator(".session-group")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
}

// Agent activity loads after the groups, once the dashboard socket is up.
async function loaded(page: Page): Promise<void> {
  await expect(page.locator(WRITER)).toHaveAttribute(
    "aria-description",
    "Working",
  );
}

async function newGroup(page: Page, card: string, name: string) {
  page.once("dialog", (dialog) => void dialog.accept(name));
  await page.locator(card).click({ button: "right" });
  await page.getByRole("button", { name: "New group…", exact: true }).click();
}

test("group changes in one dashboard appear in another without a reload", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await loaded(page);
  const other = await context.newPage();
  await other.goto("/");
  await loaded(other);

  await newGroup(page, WRITER, "Project");
  for (const view of [page, other])
    await expect(group(view, "Project").locator(WRITER)).toBeVisible();

  await other.locator(VIEWER).click({ button: "right" });
  await other
    .getByRole("button", { name: 'Move to "Project"', exact: true })
    .click();
  await expect(group(page, "Project").locator(VIEWER)).toBeVisible();

  await page.locator(WRITER).click({ button: "right" });
  await page
    .getByRole("button", { name: 'Remove from "Project"', exact: true })
    .click();
  for (const view of [page, other]) {
    await expect(group(view, "Project").locator(WRITER)).toHaveCount(0);
    await expect(group(view, "writer").locator(WRITER)).toBeVisible();
  }

  other.once("dialog", (dialog) => void dialog.accept("Empty"));
  await other
    .getByRole("button", { name: "+ New project group", exact: true })
    .click();
  await expect(group(page, "Empty")).toContainText("No sessions");

  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Delete group Project", exact: true })
    .click();
  for (const view of [page, other]) {
    await expect(group(view, "Project")).toHaveCount(0);
    await expect(group(view, "viewer").locator(VIEWER)).toBeVisible();
  }
});

test("keyboard reordering synchronises the global order between dashboards", async ({
  page,
  context,
  request,
}) => {
  await page.goto("/");
  await loaded(page);
  const other = await context.newPage();
  await other.goto("/");
  await loaded(other);
  await newGroup(page, WRITER, "Project");
  await page.locator(VIEWER).click({ button: "right" });
  await page
    .getByRole("button", { name: 'Move to "Project"', exact: true })
    .click();
  for (const view of [page, other]) {
    await expect(group(view, "Project").locator(".session-card")).toHaveCount(
      2,
    );
  }

  const writer = "writer:label:writer";
  const viewer = "viewer:instance:viewer-room";
  const response = await request.post("/api/groups/reorder", {
    data: { session: writer, anchor: viewer, position: "before" },
  });
  expect(response.status()).toBe(200);
  for (const view of [page, other]) {
    await expect(
      group(view, "Project").locator(".session-card").first(),
    ).toHaveAttribute("title", "Writable room");
  }

  const reorder = page.waitForRequest(
    (req) =>
      req.url().endsWith("/api/groups/reorder") && req.method() === "POST",
  );
  const down = group(page, "Project").locator(
    '[data-order-key="writer:label:writer"][data-order-action="down"]',
  );
  await down.focus();
  await page.keyboard.press("Enter");
  expect((await reorder).postDataJSON()).toEqual({
    session: writer,
    anchor: viewer,
    position: "after",
  });
  for (const view of [page, other]) {
    await expect(
      group(view, "Project").locator(".session-card").first(),
    ).toHaveAttribute("title", "Read-only room");
  }
  await expect
    .poll(async () => {
      const state = (await (await request.get("/api/groups")).json()) as {
        order: string[];
      };
      return state.order;
    })
    .toEqual([viewer, writer]);
});

test("pointer and touch drags reorder sessions within a group", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await loaded(page);
  await newGroup(page, WRITER, "Project");
  await page.locator(VIEWER).click({ button: "right" });
  await page
    .getByRole("button", { name: 'Move to "Project"', exact: true })
    .click();
  const project = group(page, "Project");
  await expect(project.locator(".session-card")).toHaveCount(2);
  expect(
    (
      await request.post("/api/groups/reorder", {
        data: {
          session: "writer:label:writer",
          anchor: "viewer:instance:viewer-room",
          position: "before",
        },
      })
    ).status(),
  ).toBe(200);
  await expect(project.locator(".session-card").first()).toHaveAttribute(
    "title",
    "Writable room",
  );

  const handle = project.locator(
    '[data-order-key="writer:label:writer"][data-order-action="drag"]',
  );
  const viewerRow = project
    .locator(".session-row")
    .filter({ has: page.locator(VIEWER) });
  const start = await handle.boundingBox();
  const target = await viewerRow.boundingBox();
  if (!start || !target)
    throw new Error("Session drag controls have no bounds");
  const mouseMove = page.waitForRequest(
    (req) =>
      req.url().endsWith("/api/groups/reorder") && req.method() === "POST",
  );
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height * 0.75,
    { steps: 5 },
  );
  await page.mouse.up();
  expect((await mouseMove).postDataJSON()).toEqual({
    session: "writer:label:writer",
    anchor: "viewer:instance:viewer-room",
    position: "after",
  });
  await expect(project.locator(".session-card").first()).toHaveAttribute(
    "title",
    "Read-only room",
  );

  const touchStart = await handle.boundingBox();
  const touchTarget = await viewerRow.boundingBox();
  if (!touchStart || !touchTarget)
    throw new Error("Session drag controls have no bounds");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const touchMove = page.waitForRequest(
    (req) =>
      req.url().endsWith("/api/groups/reorder") && req.method() === "POST",
  );
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      {
        x: touchStart.x + touchStart.width / 2,
        y: touchStart.y + touchStart.height / 2,
      },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      {
        x: touchTarget.x + touchTarget.width / 2,
        y: touchTarget.y + touchTarget.height * 0.25,
      },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  expect((await touchMove).postDataJSON()).toEqual({
    session: "writer:label:writer",
    anchor: "viewer:instance:viewer-room",
    position: "before",
  });
  await expect(project.locator(".session-card").first()).toHaveAttribute(
    "title",
    "Writable room",
  );
  await cdp.detach();
});

test("a session keeps its group after its room is hosted again", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await loaded(page);
  await newGroup(page, WRITER, "Project");
  const writer = group(page, "Project").locator(WRITER);
  await expect(writer).toHaveAttribute(
    "data-session-key",
    "writer:writer-room:1",
  );

  await request.post("/__relaunch");
  await expect(writer).toHaveAttribute(
    "data-session-key",
    "writer:writer-room:2",
    { timeout: 10_000 },
  );
});

test("a session keeps its group while its agent's ompc name is unknown", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await loaded(page);
  await newGroup(page, WRITER, "Project");
  await expect(group(page, "Project").locator(WRITER)).toBeVisible();
  expect(
    (
      (await (await request.get("/api/groups")).json()) as {
        groups: { sessions: string[] }[];
      }
    ).groups[0]?.sessions,
  ).toEqual(["writer:label:writer"]);

  // The dashboard reconnects and reloads the listing, now without the name.
  const relisted = page.waitForResponse(
    async (response) =>
      response.url().endsWith("/api/hosts/writer/collab") &&
      !((await response.json()) as { sessions: { ompcLabel?: string }[] })
        .sessions[0]?.ompcLabel,
    { timeout: 10_000 },
  );
  await request.post("/__forget-label");
  await relisted;
  // Let the dashboard apply the listing before checking it changed nothing.
  await page.waitForTimeout(300);
  await expect(group(page, "Project").locator(WRITER)).toBeVisible();
  await expect(group(page, "writer").locator(WRITER)).toHaveCount(0);
});

// Seeds this browser's pre-hub groups once (init scripts also run on reloads).
async function seedLegacyGroups(page: Page, sessions: string[]) {
  await page.addInitScript((members) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "omp-hub-dashboard/v1",
      JSON.stringify({
        version: 1,
        groups: [{ id: "local", name: "Imported", sessions: members }],
        selected: "writer:writer-room:1",
        inspector: "session",
      }),
    );
  }, sessions);
}

function storedLegacyGroups(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("omp-hub-dashboard/v1") ?? "{}").groups,
  );
}

async function hubGroups(request: APIRequestContext) {
  return (
    (await (await request.get("/api/groups")).json()) as {
      groups: { name: string; sessions: string[] }[];
    }
  ).groups;
}

test("imports this browser's former groups into an empty hub once", async ({
  page,
  request,
}) => {
  await seedLegacyGroups(page, [
    "writer:writer-room:1",
    // A listed host without the session, and a host with no connected agent.
    "viewer:gone-room:1",
    "retired:room:1",
  ]);
  await page.goto("/");
  await expect(group(page, "Imported").locator(WRITER)).toBeVisible();
  await expect.poll(() => storedLegacyGroups(page)).toBeUndefined();
  expect(await hubGroups(request)).toMatchObject([
    { name: "Imported", sessions: ["writer:label:writer"] },
  ]);
});

test("a group change while the import waits for a host imports first", async ({
  page,
  request,
}) => {
  // viewer is connected but cannot list, so its member keeps the import waiting.
  await page.route("**/api/hosts/viewer/collab", (route) =>
    route.fulfill({ status: 504, json: { error: "agent RPC timed out" } }),
  );
  await seedLegacyGroups(page, ["writer:writer-room:1", "viewer:gone-room:1"]);
  await page.goto("/");
  await loaded(page);
  expect(await hubGroups(request)).toEqual([]);
  expect(await storedLegacyGroups(page)).toHaveLength(1);

  page.once("dialog", (dialog) => void dialog.accept("Fresh"));
  await page
    .getByRole("button", { name: "+ New project group", exact: true })
    .click();
  await expect(group(page, "Fresh")).toBeVisible();
  await expect(group(page, "Imported").locator(WRITER)).toBeVisible();
  expect(await hubGroups(request)).toMatchObject([
    { name: "Imported", sessions: ["writer:label:writer"] },
    { name: "Fresh", sessions: [] },
  ]);
  expect(await storedLegacyGroups(page)).toBeUndefined();
});
