import { expect, test } from "@playwright/test";

test("model roles show custom roles, save assignments, reset, and honor view access", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Model roles", exact: true }).click();
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
