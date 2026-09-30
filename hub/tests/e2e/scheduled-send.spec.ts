import { type Page, expect, test } from "@playwright/test";

async function openWriter(page: Page) {
  await page.goto("/");
  const collab = page.frameLocator("[data-collab-frame]");
  await expect(collab.locator(".sh-composer-input")).toBeVisible();
  // The strip is added on load; wait for it so the hook is in place.
  await expect(collab.locator(".omp-sched-strip")).toBeAttached();
  return collab;
}

/** Presses Send for `ms`, with the mouse, at the button's centre. */
async function holdSend(
  page: Page,
  collab: ReturnType<Page["frameLocator"]>,
  ms: number,
) {
  const box = await collab.locator(".sh-btn-primary").boundingBox();
  if (!box) throw new Error("Send button has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test("holding Send queues the prompt for later instead of sending it", async ({
  page,
}) => {
  const collab = await openWriter(page);
  await collab.locator(".sh-composer-input").fill("check the build");

  await holdSend(page, collab, 900);
  const dialog = collab.getByRole("dialog", { name: "Send later" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("(in 10m)");
  await expect(dialog.getByLabel("time")).toBeHidden();

  const posted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/sessions/writer-room/scheduled") &&
      request.method() === "POST",
  );
  await dialog.getByLabel("minutes").fill("25");
  await dialog.getByRole("button", { name: "Schedule" }).click();
  expect((await posted).postDataJSON()).toEqual({
    text: "check the build",
    delayMs: 25 * 60_000,
  });

  await expect(dialog).toHaveCount(0);
  await expect(collab.locator(".sh-composer-input")).toHaveValue("");
  // The guest's own state followed the clear, not just the textarea.
  await expect(collab.locator(".sh-btn-primary")).toBeDisabled();
  await expect(collab.locator("[data-sent] li")).toHaveCount(0);
  const item = collab.locator(".omp-sched-item");
  await expect(item).toContainText("check the build");
  await expect(item).toContainText("in 25m");

  await item.getByRole("button", { name: "Cancel scheduled prompt" }).click();
  await expect(item).toHaveCount(0);
  expect(
    await (
      await page.request.get("/api/hosts/writer/sessions/writer-room/scheduled")
    ).json(),
  ).toEqual({ prompts: [] });
});

test("a short press still sends at once", async ({ page }) => {
  const collab = await openWriter(page);
  await collab.locator(".sh-composer-input").fill("go now");
  await holdSend(page, collab, 100);
  await expect(collab.locator("[data-sent] li")).toHaveText(["go now"]);
  await expect(collab.getByRole("dialog", { name: "Send later" })).toHaveCount(
    0,
  );
});

test("a clock time is sent as the delay until its next occurrence", async ({
  page,
}) => {
  const collab = await openWriter(page);
  await collab.locator(".sh-composer-input").fill("morning report");
  await holdSend(page, collab, 900);
  const dialog = collab.getByRole("dialog", { name: "Send later" });
  await dialog.getByRole("button", { name: "At", exact: true }).click();
  await expect(dialog.getByLabel("minutes")).toBeHidden();
  await dialog.getByLabel("time").fill("07:30");

  const posted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/scheduled") && request.method() === "POST",
  );
  const expected = await page.evaluate(() => {
    const now = new Date();
    const at = new Date(now);
    at.setHours(7, 30, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    return at.getTime() - now.getTime();
  });
  await dialog.getByRole("button", { name: "Schedule" }).click();
  const { delayMs } = (await posted).postDataJSON() as { delayMs: number };
  expect(Math.abs(delayMs - expected)).toBeLessThan(5_000);
});

test.describe("on a touch screen", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("a held touch on Send opens the popover and sends nothing", async ({
    page,
  }) => {
    const collab = await openWriter(page);
    await collab.locator(".sh-composer-input").fill("from the phone");
    const box = await collab.locator(".sh-btn-primary").boundingBox();
    if (!box) throw new Error("Send button has no box");
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await page.waitForTimeout(900);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });

    await expect(
      collab.getByRole("dialog", { name: "Send later" }),
    ).toBeVisible();
    await page.waitForTimeout(300);
    await expect(collab.locator("[data-sent] li")).toHaveCount(0);
    await expect(collab.locator(".sh-composer-input")).toHaveValue(
      "from the phone",
    );
  });
});
