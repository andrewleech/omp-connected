import { expect, test } from "@playwright/test";

test("model roles show custom roles, save assignments, reset, and honor view access", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Roles", exact: true }).click();
  const pane = page.locator("[data-model-roles-pane]");
  const customRole = pane.getByRole("button", { name: /Custom review/ });
  await expect(customRole).toBeVisible();
  await expect(customRole).toContainText("custom-review");
  await pane.getByRole("button", { name: /Default/ }).click();
  await expect(pane.getByLabel("Selector")).toHaveValue(
    "anthropic/claude-a:high",
  );
  await expect(
    pane.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  const scope = pane.getByLabel("Configuration scope");
  await scope.selectOption("global");
  await expect(pane.getByLabel("Selector")).toHaveValue("openai/gpt-b");
  await expect(
    pane.getByRole("button", { name: "Reset", exact: true }),
  ).toBeEnabled();
  await scope.selectOption("project");
  await expect(pane.getByLabel("Selector")).toHaveValue(
    "anthropic/claude-a:high",
  );
  await pane.getByRole("button", { name: /Custom review/ }).click();
  const search = pane.getByRole("combobox", { name: "Search eligible models" });
  await search.fill("GPT B");
  await pane.getByRole("option", { name: /GPT B \(openai\/gpt-b\)/ }).click();
  await pane.getByLabel("Thinking level").selectOption("low");
  await pane.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    pane.getByRole("button", { name: /Custom review/ }),
  ).toContainText("openai/gpt-b:low");

  await pane.getByRole("button", { name: /Default/ }).click();
  await pane.getByRole("button", { name: "Reset", exact: true }).click();

  await expect(pane.getByRole("button", { name: /Default/ })).toContainText(
    "openai/gpt-b",
  );
  await page.getByRole("button", { name: /^viewer view$/i }).click();
  await pane.getByRole("button", { name: /Default/ }).click();
  await expect(
    pane.getByRole("combobox", { name: "Search eligible models" }),
  ).toBeDisabled();
  await expect(
    pane.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await expect(
    pane.getByRole("button", { name: "Reset", exact: true }),
  ).toBeDisabled();
});

test("session and role selectors show higher model versions first within providers", async ({ page }) => {
  const models = [
    { provider: "openai", id: "gpt-9", name: "GPT 9", thinkingLevels: ["low"] },
    { provider: "openai", id: "gpt-10", name: "GPT 10", thinkingLevels: ["low"] },
    { provider: "anthropic", id: "claude-3", name: "Claude 3", thinkingLevels: ["low"] },
    { provider: "anthropic", id: "claude-4", name: "Claude 4", thinkingLevels: ["low"] },
  ];
  await page.route("**/api/hosts/*/sessions/*/info", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), models, model: models[2] } });
  });
  await page.route("**/api/hosts/*/sessions/*/model-roles", async (route) => {
    const response = await route.fetch();
    const info = await response.json();
    for (const role of info.roles) role.models = models;
    await route.fulfill({ json: info });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await page.getByRole("combobox", { name: "Search models", exact: true }).fill("");
  await expect(page.locator(".model-options:not([hidden]) [role=option]")).toHaveText([
    "Claude 4 (anthropic)", "Claude 3 (anthropic)", "GPT 10 (openai)", "GPT 9 (openai)",
  ]);
  await page.getByRole("button", { name: "Roles", exact: true }).click();
  await page.getByRole("button", { name: /Custom review/ }).click();
  await page.getByRole("combobox", { name: "Search eligible models" }).fill("");
  await expect(page.locator(".model-options:not([hidden]) [role=option]")).toHaveText([
    "Claude 4 (anthropic/claude-4)", "Claude 3 (anthropic/claude-3)",
    "GPT 10 (openai/gpt-10)", "GPT 9 (openai/gpt-9)",
  ]);
});
