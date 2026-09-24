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
  await expect(page.getByText("OMPC", { exact: true })).toBeVisible();
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
