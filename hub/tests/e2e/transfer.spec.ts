import { type Locator, type Page, expect, test } from "@playwright/test";

const PLAN_URL = "**/api/hosts/writer/sessions/writer-room/transfer/plan";

/** Opens the writer's context menu once the agent is idle; returns the Send to host item. */
async function openTransferMenu(page: Page) {
  await page.goto("/");
  const card = page.locator('.session-card[title="Writable room"]');
  // The fixture's agent starts busy, which disables the menu item.
  await expect(card).toHaveAttribute("aria-description", "Working");
  await page.request.post("/__activity?busy=0");
  await expect(card).toHaveAttribute("aria-description", "Idle");
  await card.click({ button: "right" });
  return page.getByRole("button", { name: "Send to host", exact: true });
}

/** Opens the dialog, picks the destination and waits for the conflict box. */
async function planToBuildbox(page: Page) {
  const item = await openTransferMenu(page);
  await expect(item).toBeVisible();
  await expect(item).toBeEnabled();
  await item.click();
  const dialog = page.locator("dialog[data-transfer-dialog]");
  await expect(dialog).toBeVisible();
  await dialog
    .locator(".transfer-destinations button")
    .filter({ hasText: "buildbox" })
    .click();
  await expect(dialog.locator(".transfer-conflict-box")).toBeVisible();
  return dialog;
}

const choice = (dialog: Locator, value: string) =>
  dialog.locator(`input[name="transfer-project-choice"][value="${value}"]`);

test("the conflict box offers three choices and gates Update on its preview", async ({
  page,
}) => {
  const planRequests: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/transfer/plan"))
      planRequests.push(request.postDataJSON());
  });
  // Hold the Update plan so the loading state can be observed.
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  await page.route(PLAN_URL, async (route) => {
    const body = route.request().postDataJSON() as { projectMode?: string };
    if (body.projectMode === "update") await gate;
    await route.continue();
  });

  const dialog = await planToBuildbox(page);
  await expect(dialog.locator("h2")).toContainText("to another host");
  await expect(dialog.locator(".transfer-conflict-box legend")).toHaveText(
    "The project already exists at /home/dev/writer",
  );

  const labels = dialog.locator(".transfer-choice");
  await expect(labels).toHaveCount(3);
  await expect(labels.nth(0)).toContainText("Update project with rsync");
  await expect(labels.nth(1)).toContainText(
    "Leave project untouched; transfer session only",
  );
  await expect(labels.nth(2)).toContainText("Cancel");
  await expect(choice(dialog, "session-only")).toBeChecked();
  await expect(choice(dialog, "update")).not.toBeChecked();
  await expect(choice(dialog, "cancel")).not.toBeChecked();
  await expect(dialog.locator(".transfer-preview")).toHaveCount(0);
  const actions = dialog.locator(".transfer-actions");
  await expect(
    actions.getByRole("button", {
      name: "Send session only to buildbox",
      exact: true,
    }),
  ).toBeEnabled();

  await choice(dialog, "update").click();
  const update = actions.getByRole("button", {
    name: "Update project and send to buildbox",
    exact: true,
  });
  await expect(dialog.locator(".transfer-project .transfer-note")).toHaveText(
    "Loading the project preview…",
  );
  await expect(dialog.locator(".transfer-preview")).toHaveCount(0);
  await expect(update).toBeDisabled();

  release();
  const preview = dialog.locator(".transfer-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Change preview");
  await expect(preview).toContainText(
    "2 additions, 1 replacement, 0 mode changes, 3 destination-only entries kept, 1.5 KiB to copy",
  );
  await expect(choice(dialog, "update")).toBeChecked();
  await expect(update).toBeEnabled();
  expect(planRequests).toEqual([
    { destination: "buildbox" },
    { destination: "buildbox", projectMode: "update" },
  ]);
});

test("choosing Cancel closes the dialog without committing", async ({
  page,
}) => {
  const commits: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/transfer/commit"))
      commits.push(request.url());
  });
  const dialog = await planToBuildbox(page);

  await choice(dialog, "cancel").click();
  await expect(choice(dialog, "cancel")).toBeChecked();
  await dialog
    .locator(".transfer-actions")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  await expect(dialog).toBeHidden();
  expect(commits).toEqual([]);
  expect(await (await page.request.get("/api/transfers")).json()).toEqual([]);
});

test("committing an update shows progress until the transfer completes", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const dialog = await planToBuildbox(page);

  await choice(dialog, "update").click();
  await expect(dialog.locator(".transfer-preview")).toBeVisible();
  const send = dialog
    .locator(".transfer-actions")
    .getByRole("button", {
      name: "Update project and send to buildbox",
      exact: true,
    });
  await expect(send).toBeEnabled();

  const committed = page.waitForRequest((request) =>
    request.url().endsWith("/transfer/commit"),
  );
  await send.click();
  expect((await committed).postDataJSON()).toEqual({
    destination: "buildbox",
    planId: expect.stringMatching(/^plan-\d+$/),
    planDigest: expect.stringMatching(/^digest-\d+$/),
    projectMode: "update",
    acceptIncomplete: false,
  });

  await expect(dialog.locator("h2")).toHaveText("Sending to buildbox");
  const timeline = dialog.locator(".transfer-timeline");
  await expect(timeline).toBeVisible();
  await expect(timeline.locator('li[aria-current="step"]')).toContainText(
    "Stopping the source session",
  );
  await expect(dialog).toContainText("Copying project");

  const completed = timeline.locator("li", { hasText: "Completed" });
  await expect(completed).toHaveAttribute("data-status", "done", {
    timeout: 30_000,
  });
  await expect(timeline.locator('li[data-status="done"]')).toHaveCount(8);
  await expect(timeline.locator('li[aria-current="step"]')).toHaveCount(0);
  await expect(dialog).toContainText(
    "The session continues on the destination.",
  );
  await expect(dialog).not.toContainText("Copying project");
});
