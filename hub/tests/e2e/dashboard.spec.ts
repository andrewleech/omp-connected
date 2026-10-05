import { expect, test } from "@playwright/test";

test("opens writable sessions in Collab control by default", async ({
  page,
}) => {
  await page.goto("/");

  const frame = page.locator("[data-collab-frame]");
  await expect(frame).toHaveAttribute("src", /\/collab\/#fixture-control$/);
  await expect(
    page
      .frameLocator("[data-collab-frame]")
      .locator("[data-native-status-bar]"),
  ).toBeVisible();
  await expect(page.getByText("OMP Connected", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View", exact: true }),
  ).toHaveCount(0);
});

test("does not install a stale control result after selecting a view-only room", async ({
  page,
}) => {
  const staleControlLink = page.waitForResponse(
    (response) =>
      response.url().includes("/api/hosts/writer/collab/writer-room/link") &&
      response.request().method() === "POST",
  );
  await page.goto("/");
  await page.getByRole("button", { name: "viewer view", exact: true }).click();

  await expect(page.locator(".tail-viewer")).toBeVisible();
  await staleControlLink;
  await expect(page.locator(".tail-viewer")).toBeVisible();
  await expect(page.locator("[data-collab-frame]")).toBeHidden();
});
test("mobile drawers return focus and do not replace the control iframe", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".topbar-brand")).toHaveText("ompc");
  await expect(page.locator("[data-topbar-session]")).not.toHaveText(
    "No session",
  );
  const bar = await page.locator(".topbar").boundingBox();
  const left = await page.locator("[data-session-drawer-toggle]").boundingBox();
  const right = await page
    .locator("[data-inspector-drawer-toggle]")
    .boundingBox();
  const title = await page.locator(".topbar-session").boundingBox();
  if (!bar || !left || !right || !title) throw new Error("topbar not laid out");
  expect(left.x).toBeLessThan(title.x);
  expect(right.x).toBeGreaterThan(title.x + title.width - 1);
  expect(right.x + right.width).toBeGreaterThan(bar.width - 20);
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toHaveCount(0);
  const frame = page.locator("[data-collab-frame]");
  await expect(frame).toHaveAttribute("src", /\/collab\/#fixture-control$/);
  const initialSource = await frame.getAttribute("src");
  if (!initialSource) throw new Error("Control iframe has no source");

  const sessions = page.getByRole("button", { name: "Sessions", exact: true });
  await sessions.click();
  await expect(sessions).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: "Close", exact: true }).first(),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sessions).toHaveAttribute("aria-expanded", "false");
  await expect(sessions).toBeFocused();

  const inspector = page.getByRole("button", {
    name: "Inspector",
    exact: true,
  });
  await inspector.click();
  await page.locator("[data-inspector-drawer-close]").click();
  await expect(inspector).toHaveAttribute("aria-expanded", "false");
  await expect(frame).toHaveAttribute("src", initialSource);
  await expect(
    page
      .frameLocator("[data-collab-frame]")
      .locator("[data-native-status-bar]"),
  ).toBeVisible();
});

test("clicking the open session's card keeps its Collab document", async ({
  page,
}) => {
  await page.goto("/");
  const frame = page.locator("[data-collab-frame]");
  await expect(frame).toHaveAttribute("src", /\/collab\/#fixture-control$/);
  const collab = page.frameLocator("[data-collab-frame]");
  await expect(collab.locator("[data-native-status-bar]")).toBeVisible();
  // A marker on the loaded document: any reload or blanking loses it.
  await collab.locator("body").evaluate((body) => {
    body.dataset.reselectMarker = "kept";
  });
  // Re-selecting blanks the frame and requests a new link synchronously in
  // the click handler, so both are observable as soon as click() resolves.
  let linkRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/collab/writer-room/link")) linkRequests++;
  });
  const card = page.getByRole("button", { name: "writer", exact: true });

  await card.click();
  expect(await frame.getAttribute("src")).toMatch(
    /\/collab\/#fixture-control$/,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  const sessions = page.getByRole("button", { name: "Sessions", exact: true });
  await sessions.click();
  await expect(sessions).toHaveAttribute("aria-expanded", "true");
  await card.click();
  await expect(sessions).toHaveAttribute("aria-expanded", "false");
  expect(await frame.getAttribute("src")).toMatch(
    /\/collab\/#fixture-control$/,
  );
  expect(linkRequests).toBe(0);
  await expect(collab.locator("body")).toHaveAttribute(
    "data-reselect-marker",
    "kept",
  );
});

test("clicking a session whose room failed to open retries it", async ({
  page,
}) => {
  let failures = 1;
  await page.route("**/api/hosts/writer/collab/writer-room/link", (route) =>
    failures-- > 0
      ? route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "relay unavailable" }),
        })
      : route.fallback(),
  );
  await page.goto("/");
  const frame = page.locator("[data-collab-frame]");
  await expect(page.getByText("relay unavailable")).toBeVisible();
  await expect(frame).not.toHaveAttribute("src", /fixture-control/);

  await page.getByRole("button", { name: "writer", exact: true }).click();
  await expect(frame).toHaveAttribute("src", /\/collab\/#fixture-control$/);
});

test("session dots follow the agent's working/idle state live", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const writer = page.getByRole("button", { name: "writer", exact: true });
  await expect(writer.locator(".activity-dot.working")).toBeVisible();
  // A session with no registered agent has no dot.
  await expect(
    page
      .getByRole("button", { name: "viewer view", exact: true })
      .locator(".activity-dot"),
  ).toHaveCount(0);

  await request.post("/__activity?busy=0");
  await expect(writer.locator(".activity-dot.idle")).toBeVisible();
  await expect(writer.locator(".activity-dot.working")).toHaveCount(0);
  // The workspace iframe is untouched by the dot update.
  await expect(page.locator("[data-collab-frame]")).toHaveAttribute(
    "src",
    /\/collab\/#fixture-control$/,
  );
});

test("the dashboard reconnects and resyncs dots after the event stream drops", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const writer = page.getByRole("button", { name: "writer", exact: true });
  await expect(writer.locator(".activity-dot.working")).toBeVisible();
  await request.post("/__drop?busy=0");
  await expect(writer.locator(".activity-dot.idle")).toBeVisible({
    timeout: 10_000,
  });
});

test("sessions from responsive hosts show while another host's listing is still pending", async ({
  page,
}) => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/hosts/viewer/collab", async (route) => {
    await hold;
    await route.fallback();
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "writer", exact: true }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("button", { name: "viewer view", exact: true }),
  ).toBeVisible();
});
