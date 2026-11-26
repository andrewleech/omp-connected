import { type FrameLocator, type Page, expect, test } from "@playwright/test";

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
  const dialog = collab.getByRole("dialog", { name: "Send options" });
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

test("Send later can queue the prompt until the session becomes idle", async ({
  page,
}) => {
  const collab = await openWriter(page);
  await collab.locator(".sh-composer-input").fill("review the result");
  await holdSend(page, collab, 900);
  const dialog = collab.getByRole("dialog", { name: "Send options" });
  await dialog.getByRole("button", { name: "When idle" }).click();
  await expect(dialog).toContainText(
    "Sends when the agent becomes idle, or now if already idle.",
  );

  const posted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/sessions/writer-room/scheduled") &&
      request.method() === "POST",
  );
  await dialog.getByRole("button", { name: "Queue" }).click();
  expect((await posted).postDataJSON()).toEqual({
    text: "review the result",
    delayMs: 0,
    whenIdle: true,
  });
  await expect(collab.locator(".omp-sched-item")).toContainText("when idle");
  await expect(collab.locator(".sh-composer-input")).toHaveValue("");
});

test("a short press still sends at once", async ({ page }) => {
  const collab = await openWriter(page);
  await collab.locator(".sh-composer-input").fill("go now");
  await holdSend(page, collab, 100);
  await expect(collab.locator("[data-sent] li")).toHaveText(["go now"]);
  await expect(
    collab.getByRole("dialog", { name: "Send options" }),
  ).toHaveCount(0);
});

test("a clock time is sent as the delay until its next occurrence", async ({
  page,
}) => {
  const collab = await openWriter(page);
  await collab.locator(".sh-composer-input").fill("morning report");
  await holdSend(page, collab, 900);
  const dialog = collab.getByRole("dialog", { name: "Send options" });
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

type Collab = FrameLocator;

/** Sets the stub guest's embed API state (see fixture-server.ts). */
async function guestState(
  collab: Collab,
  patch: { sideRequests?: boolean; failWith?: string },
) {
  await collab.locator("body").evaluate((_, state) => {
    Object.assign(
      (window as unknown as { guestStub: object }).guestStub,
      state,
    );
  }, patch);
}

test("Side request is offered only while the guest supports it", async ({
  page,
}) => {
  const collab = await openWriter(page);
  await collab.locator(".sh-composer-input").fill("look into the flake");

  await holdSend(page, collab, 900);
  const dialog = collab.getByRole("dialog", { name: "Send options" });
  await expect(dialog.getByRole("button", { name: "In" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Side request" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await guestState(collab, { sideRequests: true });
  await holdSend(page, collab, 900);
  await expect(
    dialog.getByRole("button", { name: "Side request" }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "When idle" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "At", exact: true }),
  ).toBeVisible();
});

test("Start runs a side request, clears the popover and leaves the scheduler alone", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/scheduled") && request.method() === "POST")
      posts.push(request.url());
  });
  const collab = await openWriter(page);
  await guestState(collab, { sideRequests: true });
  await collab.locator(".sh-composer-input").fill("audit the retry logic");

  await holdSend(page, collab, 900);
  const dialog = collab.getByRole("dialog", { name: "Send options" });
  await dialog.getByRole("button", { name: "Side request" }).click();
  await expect(dialog).toContainText("independent subagent");
  await expect(dialog).toContainText("shares the workspace");
  await expect(dialog.getByLabel("minutes")).toBeHidden();
  await expect(dialog.getByLabel("time")).toBeHidden();
  await dialog.getByRole("button", { name: "Start" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(collab.locator("[data-side] li")).toHaveText([
    "audit the retry logic",
  ]);
  await expect(collab.locator(".sh-composer-input")).toHaveValue("");
  await expect(collab.locator("[data-sent] li")).toHaveCount(0);
  await expect(collab.locator(".omp-sched-item")).toHaveCount(0);
  expect(posts).toEqual([]);
});

test("a failed side request shows the reason and keeps the popover and the draft", async ({
  page,
}) => {
  const collab = await openWriter(page);
  await guestState(collab, {
    sideRequests: true,
    failWith: "The host could not start the child.",
  });
  await collab.locator(".sh-composer-input").fill("try this elsewhere");

  await holdSend(page, collab, 900);
  const dialog = collab.getByRole("dialog", { name: "Send options" });
  await dialog.getByRole("button", { name: "Side request" }).click();
  await dialog.getByRole("button", { name: "Start" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "The host could not start the child.",
  );
  await expect(dialog).toBeVisible();
  await expect(collab.locator(".sh-composer-input")).toHaveValue(
    "try this elsewhere",
  );
  await expect(collab.locator("[data-side] li")).toHaveCount(0);

  await guestState(collab, { failWith: "" });
  await dialog.getByRole("button", { name: "Start" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(collab.locator("[data-side] li")).toHaveText([
    "try this elsewhere",
  ]);
});

test("images block both scheduling and a side request", async ({ page }) => {
  const collab = await openWriter(page);
  await guestState(collab, { sideRequests: true });
  await collab.locator(".sh-composer-input").fill("what is in this picture");
  await collab.locator(".sh-composer-inner").evaluate((inner) => {
    const chip = document.createElement("span");
    chip.className = "sh-attachment";
    chip.textContent = "shot.png";
    inner.append(chip);
  });

  await holdSend(page, collab, 900);
  const dialog = collab.getByRole("dialog", { name: "Send options" });
  await expect(dialog.getByText("Images can't be scheduled")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Schedule" })).toBeDisabled();

  await dialog.getByRole("button", { name: "Side request" }).click();
  await expect(
    dialog.getByText("Images can't be sent with a side request"),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Start" })).toBeDisabled();

  await collab.locator(".sh-attachment").evaluate((chip) => chip.remove());
  await expect(dialog.getByRole("button", { name: "Start" })).toBeEnabled();
});

test("Start is disabled with a reason when the guest loses side requests", async ({
  page,
}) => {
  const collab = await openWriter(page);
  await guestState(collab, { sideRequests: true });
  await collab.locator(".sh-composer-input").fill("while connected");

  await holdSend(page, collab, 900);
  const dialog = collab.getByRole("dialog", { name: "Send options" });
  await dialog.getByRole("button", { name: "Side request" }).click();
  await expect(dialog.getByRole("button", { name: "Start" })).toBeEnabled();

  await guestState(collab, { sideRequests: false });
  await expect(dialog.getByRole("button", { name: "Start" })).toBeDisabled();
  await expect(dialog).toContainText("Side requests are unavailable");
  // The scheduling modes stay usable.
  await dialog.getByRole("button", { name: "In" }).click();
  await expect(dialog.getByRole("button", { name: "Schedule" })).toBeEnabled();
});

test("Escape closes the popover without starting anything", async ({
  page,
}) => {
  const collab = await openWriter(page);
  await guestState(collab, { sideRequests: true });
  await collab.locator(".sh-composer-input").fill("never mind");
  await holdSend(page, collab, 900);
  const dialog = collab.getByRole("dialog", { name: "Send options" });
  await dialog.getByRole("button", { name: "Side request" }).click();
  await dialog.getByRole("button", { name: "Side request" }).press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(collab.locator("[data-side] li")).toHaveCount(0);
  await expect(collab.locator(".sh-composer-input")).toHaveValue("never mind");
});

test.describe("a session without the schedule feature", () => {
  test("offers only Side request when the guest supports it", async ({
    page,
  }) => {
    const listed: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/scheduled")) listed.push(request.method());
    });
    await page.request.post("/__without-schedule");
    const collab = await openWriter(page);
    await guestState(collab, { sideRequests: true });
    await collab.locator(".sh-composer-input").fill("only a side task");

    await holdSend(page, collab, 900);
    const dialog = collab.getByRole("dialog", { name: "Send options" });
    await expect(dialog).toContainText("independent subagent");
    await expect(dialog.getByRole("button", { name: "In" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "When idle" })).toHaveCount(
      0,
    );
    await expect(
      dialog.getByRole("button", { name: "Side request" }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(collab.locator("[data-side] li")).toHaveText([
      "only a side task",
    ]);
    expect(listed).toEqual([]);
  });

  test("a held Send without guest support sends as usual", async ({ page }) => {
    await page.request.post("/__without-schedule");
    const collab = await openWriter(page);
    await collab.locator(".sh-composer-input").fill("plain send");
    await holdSend(page, collab, 900);
    await expect(
      collab.getByRole("dialog", { name: "Send options" }),
    ).toHaveCount(0);
    await expect(collab.locator("[data-sent] li")).toHaveText(["plain send"]);
  });
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
      collab.getByRole("dialog", { name: "Send options" }),
    ).toBeVisible();
    await page.waitForTimeout(300);
    await expect(collab.locator("[data-sent] li")).toHaveCount(0);
    await expect(collab.locator(".sh-composer-input")).toHaveValue(
      "from the phone",
    );
  });
});
