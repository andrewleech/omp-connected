import { type Page, expect, test } from "@playwright/test";

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

test("imports this browser's former groups into an empty hub once", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "omp-hub-dashboard/v1",
      JSON.stringify({
        version: 1,
        groups: [
          {
            id: "local",
            name: "Imported",
            sessions: ["writer:writer-room:1", "viewer:gone-room:1"],
          },
        ],
        selected: "writer:writer-room:1",
        inspector: "session",
      }),
    );
  });
  await page.goto("/");
  await expect(group(page, "Imported").locator(WRITER)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("omp-hub-dashboard/v1") ?? "{}")
            .groups,
      ),
    )
    .toBeUndefined();
  const hub = (await (await request.get("/api/groups")).json()) as {
    groups: { name: string; sessions: string[] }[];
  };
  expect(hub.groups).toMatchObject([
    { name: "Imported", sessions: ["writer:label:writer"] },
  ]);
});
