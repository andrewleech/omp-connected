import { expect, test } from "@playwright/test";

test("Session tab shows the session and switches its model", async ({
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

  const modelRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/sessions/writer-room/model") &&
      request.method() === "POST",
  );
  await pane
    .getByLabel("Model")
    .selectOption(JSON.stringify(["openai", "gpt-b"]));
  expect((await modelRequest).postDataJSON()).toEqual({
    provider: "openai",
    id: "gpt-b",
  });
  await expect(pane.locator('[data-info="model"]')).toHaveText(
    "GPT B (openai)",
  );
  await expect(pane.getByLabel("Model")).toBeEnabled();
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
  await page.goto("/");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const pane = page.locator("[data-files-pane]");
  const list = pane.getByRole("list", { name: "Files" });

  await expect(list.locator("[data-name]")).toHaveText([/docs/, /README\.md/]);
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
