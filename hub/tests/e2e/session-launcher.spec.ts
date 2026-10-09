import { expect, test } from "@playwright/test";

test("resumes a past conversation with its remembered suffix, excluding it once open", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const rows = dialog.locator(".past-session");
  await expect(rows.nth(0)).toContainText("Recent conversation");
  await expect(rows.nth(1)).toContainText("Older conversation");
  await expect(rows.nth(0)).toHaveAttribute("title", "past-new");
  await rows.nth(0).click();
  await expect(dialog.getByLabel("Path", { exact: true })).toHaveValue(
    "/work/project",
  );
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    "review",
  );
  await dialog
    .getByRole("button", { name: "Resume session", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "project.review", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  await expect(
    page.locator('.past-session[data-session-id="past-new"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('.past-session[data-session-id="past-old"]'),
  ).toBeVisible();
});
test("forks the active session from its sidebar context menu", async ({
  page,
}) => {
  await page.request.post("http://127.0.0.1:4173/__activity?busy=1");
  await page.goto("/");
  const writerCard = page.locator('.session-card[title="Writable room"]');
  await expect(writerCard).toHaveAttribute("aria-description", "Working");
  await writerCard.click({ button: "right" });
  const forkButton = page.getByRole("button", {
    name: "Fork session",
    exact: true,
  });
  await expect(forkButton).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.request.post("http://127.0.0.1:4173/__activity?busy=0");
  await expect(writerCard).toHaveAttribute("aria-description", "Idle");
  await writerCard.click({ button: "right" });
  await expect(forkButton).toBeEnabled();
  const prompt = page
    .waitForEvent("dialog")
    .then((dialog) => dialog.accept("from-sidebar"));
  await forkButton.click();
  await prompt;
  await expect(
    page.getByRole("button", { name: "writer.from-sidebar", exact: true }),
  ).toBeVisible();
});

test("deselects history to start a new conversation and keeps launch collisions in the form", async ({
  page,
}) => {
  await page.goto("/");
  const start = page.getByRole("button", {
    name: "Start session on writer",
    exact: true,
  });
  await start.click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('.past-session[data-session-id="past-old"]').click();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("");
  await dialog
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await dialog.getByLabel("Name", { exact: true }).fill("fresh");
  await dialog
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "other.fresh", exact: true }),
  ).toBeVisible();
  await start.click();
  await dialog.getByLabel("Path", { exact: true }).fill("/work/other");
  await dialog.getByLabel("Name", { exact: true }).fill("fresh");
  await dialog
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("already exists");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("fresh");
  await expect(
    dialog.getByRole("button", { name: "Start session", exact: true }),
  ).toBeEnabled();
});

test("keeps the host launch button when its sessions belong to custom groups", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "omp-hub-dashboard/v1",
      JSON.stringify({
        version: 1,
        groups: [
          { id: "custom", name: "Project", sessions: ["writer:writer-room:1"] },
        ],
        selected: null,
        inspector: "session",
      }),
    ),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Project", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Start session on writer", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("shows host access failures in the mobile popup", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("[data-session-drawer-toggle]").click();
  await page
    .getByRole("button", { name: "Start session on viewer", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "control-shared",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
