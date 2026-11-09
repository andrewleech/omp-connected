import { expect, test } from "@playwright/test";

test("Session tab searches available models and switches its model", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Session", exact: true }).click();
  const pane = page.locator("[data-session-pane]");

  await expect(pane.locator('[data-info="guests"]')).toHaveText("2");
  await expect(pane.locator('[data-info="pid"]')).toHaveText("4242");
  await expect(pane.locator('[data-info="context"]')).toContainText(
    "42k / 200k tokens (21%)",
  );

  const modelSearch = pane.getByRole("combobox", { name: "Search models" });
  await modelSearch.fill("OPENAI");
  await expect(
    pane.getByRole("option", { name: "GPT B (openai)", exact: true }),
  ).toBeVisible();
  await expect(
    pane.getByRole("option", { name: "Claude A (anthropic)", exact: true }),
  ).not.toBeVisible();
  await modelSearch.press("Enter");
  await expect(pane.locator('[data-info="model"]')).toHaveText(
    "GPT B (openai)",
  );
  await expect(modelSearch).toBeEnabled();
  await expect(modelSearch).toHaveValue("GPT B");
});

test("Session tab shows provider quota windows in a usage popup", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Session", exact: true }).click();
  const pane = page.locator("[data-session-pane]");
  const usageButton = pane.getByRole("button", { name: "Usage" });
  await expect(usageButton).toBeEnabled();
  await usageButton.click();

  const dialog = page.getByRole("dialog", { name: /Provider usage/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("anthropic");
  await expect(dialog).toContainText("Account 1");
  await expect(dialog).toContainText("Weekly");
  await expect(dialog).toContainText("42% used");
  await expect(dialog).toContainText("Resets");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).not.toBeVisible();
});

test("Session tab keeps typed compact instructions across a fleet poll", async ({
  page,
}) => {
  test.setTimeout(40_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Session", exact: true }).click();
  const input = page.getByLabel("Compact instructions");
  await input.fill("keep the api notes");
  await input.focus();
  // The 15 s session-list poll re-renders the whole dashboard shell.
  const poll = await page.waitForResponse(
    (response) => response.url().endsWith("/api/hosts/viewer/collab"),
    { timeout: 20_000 },
  );
  await poll.finished();
  await page.waitForTimeout(200);
  await expect(input).toHaveValue("keep the api notes");
  await expect(input).toBeFocused();
});

test("a session without session.v1 asks for a restart", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "viewer view", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator("[data-files-pane]")).toContainText(
    "restart this session to enable them",
  );
});

test("Files tab browses, uploads and asks before overwriting", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const pane = page.locator("[data-files-pane]");
  const list = pane.getByRole("list", { name: "Files" });

  await expect(list.locator("[data-name]")).toHaveText([
    /docs/,
    /blob\.dat/,
    /README\.md/,
    /run\.sh/,
  ]);
  await expect(
    list.locator('[data-name="README.md"] a.file-name'),
  ).toHaveAttribute(
    "href",
    "/api/hosts/writer/sessions/writer-room/files/download?path=README.md",
  );

  await list.getByRole("button", { name: "docs/" }).click();
  await expect(list.locator("[data-name]")).toHaveText([/notes\.md/]);
  await expect(pane.locator("[aria-current=location]")).toHaveText("docs");

  await pane.locator("[data-files-upload-input]").setInputFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("first"),
  });
  await expect(
    pane.locator('[data-upload-name="report.txt"][data-state="done"]'),
  ).toBeVisible();
  await expect(list.locator('[data-name="report.txt"]')).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  const overwrite = page.waitForRequest((request) =>
    request.url().includes("path=docs%2Freport.txt&overwrite=1"),
  );
  await pane.locator("[data-files-upload-input]").setInputFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("second, longer"),
  });
  await overwrite;
  await expect(list.locator('[data-name="report.txt"]')).toContainText("14 B");
});
test("Files tab copies successful paths when a temp upload is cancelled", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const pane = page.locator("[data-files-pane]");
  let signalFirstUpload!: () => void;
  let releaseFirstUpload!: () => void;
  const firstUploadIntercepted = new Promise<void>((resolve) => {
    signalFirstUpload = resolve;
  });
  const firstUploadGate = new Promise<void>((resolve) => {
    releaseFirstUpload = resolve;
  });
  await page.route("**/files/upload*", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path !== "scratch.txt") {
      await route.continue();
      return;
    }
    signalFirstUpload();
    await firstUploadGate;
    try {
      await route.continue();
    } catch {
      return;
    }
  });
  const uploads = [
    pane.locator('[data-upload-name="scratch.txt"]'),
    pane.locator('[data-upload-name="second.txt"]'),
    pane.locator('[data-upload-name="third.txt"]'),
  ];
  const request = page.waitForRequest((item) =>
    item.url().includes("destination=temp"),
  );
  const geometry = await pane.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["temporary data"], "scratch.txt", { type: "text/plain" }),
    );
    transfer.items.add(
      new File(["more temporary data"], "second.txt", { type: "text/plain" }),
    );
    transfer.items.add(
      new File(["last temporary data"], "third.txt", { type: "text/plain" }),
    );
    element.dispatchEvent(
      new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        clientY: 0,
        dataTransfer: transfer,
      }),
    );
    const hint = document.querySelector(".drop-hint");
    const sessionZone = document.querySelector(".drop-zone-session");
    const tempZone = document.querySelector(".drop-zone-temp");
    if (
      !(hint instanceof HTMLElement) ||
      !(sessionZone instanceof HTMLElement) ||
      !(tempZone instanceof HTMLElement)
    )
      throw new Error("Drop zones not found");
    const hintRect = hint.getBoundingClientRect();
    const sessionRect = sessionZone.getBoundingClientRect();
    const tempRect = tempZone.getBoundingClientRect();
    const x = hintRect.left + hintRect.width / 2;
    const y = tempRect.top + 1;
    const hit = document.elementFromPoint(x, y);
    if (!(hit instanceof Element)) throw new Error("No drop hit target");
    const hitTarget = hit.closest(".inspector-body");
    if (!(hitTarget instanceof HTMLElement))
      throw new Error("Overlay blocks the underlying drop target");
    for (const type of ["dragover", "drop"])
      hitTarget.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: transfer,
        }),
      );
    const inspector = element.closest(".inspector");
    if (!(inspector instanceof HTMLElement))
      throw new Error("Inspector not found");
    const inspectorRect = inspector.getBoundingClientRect();
    return {
      height: hintRect.height,
      sessionHeight: sessionRect.height,
      tempHeight: tempRect.height,
      top: hintRect.top,
      bottom: hintRect.bottom,
      inspectorTop: inspectorRect.top,
      inspectorBottom: inspectorRect.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.inspectorTop);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.inspectorBottom);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.sessionHeight / geometry.tempHeight).toBeCloseTo(2, 0);
  await request;
  await firstUploadIntercepted;
  await expect(uploads[0]).toHaveAttribute("data-state", "uploading");
  await uploads[0].getByRole("button", { name: "Cancel" }).click();
  releaseFirstUpload();
  await expect(uploads[0]).toHaveAttribute("data-state", "cancelled");
  await expect(uploads[1]).toHaveAttribute("data-state", "done");
  await expect(uploads[2]).toHaveAttribute("data-state", "done");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("/tmp/second.txt\n/tmp/third.txt");
});

test("Files tab session-folder drops copy paths but picker uploads do not", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const pane = page.locator("[data-files-pane]");
  await page.evaluate(() =>
    navigator.clipboard.writeText("preserve clipboard"),
  );
  await pane.locator("[data-files-upload-input]").setInputFiles({
    name: "picker.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("picker"),
  });
  const pickerUpload = pane.locator(
    '[data-upload-name="picker.txt"][data-state="done"]',
  );
  await expect(pickerUpload).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("preserve clipboard");

  const sessionUpload = pane.locator(
    '[data-upload-name="session-drop.txt"][data-state="done"]',
  );
  const request = page.waitForRequest(
    (item) =>
      item.url().includes("path=session-drop.txt") &&
      !item.url().includes("destination=temp"),
  );
  await pane.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["session data"], "session-drop.txt", { type: "text/plain" }),
    );
    element.dispatchEvent(
      new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        clientY: 0,
        dataTransfer: transfer,
      }),
    );
    const hint = document.querySelector(".drop-hint");
    if (!(hint instanceof HTMLElement))
      throw new Error("Drop overlay not found");
    const rect = hint.getBoundingClientRect();
    for (const type of ["dragover", "drop"])
      element.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientY: rect.top + rect.height * 0.3,
          dataTransfer: transfer,
        }),
      );
  });
  await request;
  await expect(sessionUpload).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("/work/writer/session-drop.txt");
});

test("a text file opens in a viewer with rendered and raw views and a download link", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const list = page
    .locator("[data-files-pane]")
    .getByRole("list", { name: "Files" });
  const viewer = page.locator("[data-file-viewer]");

  await list.locator('[data-name="README.md"] a.file-name').click();
  await expect(viewer).toBeVisible();
  await expect(
    viewer.getByRole("heading", { name: "README.md" }),
  ).toBeVisible();
  const rendered = viewer.frameLocator("iframe");
  await expect(rendered.getByRole("heading", { name: "Hello" })).toBeVisible();
  await expect(rendered.locator("strong")).toHaveText("bold");
  await expect(rendered.getByRole("link", { name: "site" })).toHaveAttribute(
    "target",
    "_blank",
  );
  // A relative link has nowhere to go, and embedded script never runs.
  await expect(rendered.locator('a[href="other.md"]')).toHaveCount(0);
  await expect(page).not.toHaveTitle("pwned");
  await expect(viewer.locator("iframe")).toHaveAttribute("sandbox", "");
  await expect(viewer.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    /\/api\/hosts\/writer\/sessions\/writer-room\/files\/download\?path=README\.md$/,
  );

  await viewer.getByRole("button", { name: "Raw" }).click();
  await expect(viewer.locator("pre")).toContainText("# Hello");
  await expect(viewer.locator("iframe")).toBeHidden();
  await viewer.getByRole("button", { name: "Rendered" }).click();
  await expect(rendered.getByRole("heading", { name: "Hello" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  // A shell script has no rendered form, only text.
  await list.locator('[data-name="run.sh"] a.file-name').click();
  await expect(viewer.locator("pre")).toContainText("echo hi");
  await expect(viewer.getByRole("button", { name: "Rendered" })).toBeHidden();
  await page.keyboard.press("Escape");

  // A file that is not text is downloaded and the viewer closes again.
  const download = page.waitForEvent("download");
  await list.locator('[data-name="blob.dat"] a.file-name').click();
  expect((await download).suggestedFilename()).toBe("blob.dat");
  await expect(viewer).toBeHidden();
});
