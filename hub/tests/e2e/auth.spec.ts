import { expect, test } from "@playwright/test";

const LOGIN_URL = "https://auth.example.com/authorize?state=fixture";

test("Login tab lists providers with their accounts", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-inspector-tab="auth"]').click();
  const pane = page.locator("[data-auth-pane]");

  const anthropic = pane.locator('[data-provider-id="anthropic"]');
  await expect(anthropic.locator(".auth-badge")).toHaveText("authenticated");
  await expect(anthropic).toContainText("work@example.com");
  await expect(
    anthropic.getByRole("button", { name: "Re-login", exact: true }),
  ).toBeEnabled();
  await expect(
    anthropic.getByRole("button", { name: "Log out", exact: true }),
  ).toBeEnabled();

  const openrouter = pane.locator('[data-provider-id="openrouter"]');
  await expect(openrouter.locator(".auth-badge")).toHaveText(
    "not authenticated",
  );
  await expect(
    openrouter.getByRole("button", { name: "Login", exact: true }),
  ).toBeEnabled();
  await expect(
    openrouter.getByRole("button", { name: "Log out", exact: true }),
  ).toHaveCount(0);
});

test("login shows the auth link, takes a secret input and marks the provider authenticated", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('[data-inspector-tab="auth"]').click();
  const pane = page.locator("[data-auth-pane]");
  const flow = pane.locator("[data-auth-flow]");
  const openrouter = pane.locator('[data-provider-id="openrouter"]');

  await openrouter.getByRole("button", { name: "Login", exact: true }).click();
  const link = flow.getByRole("link", { name: "Open login page" });
  await expect(link).toHaveAttribute("href", LOGIN_URL);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(flow).toContainText("Sign in, then copy the redirect URL.");
  // One login at a time: the other providers cannot start another.
  await expect(
    pane
      .locator('[data-provider-id="anthropic"]')
      .getByRole("button", { name: "Re-login", exact: true }),
  ).toBeDisabled();

  const input = flow.getByLabel("Login input");
  await expect(flow.locator("[data-auth-state]")).toHaveAttribute(
    "data-auth-state",
    "awaiting_input",
  );
  await expect(input).toHaveAttribute("type", "password");
  await expect(flow).toContainText("Paste the redirect URL or API key");

  await input.fill("sk-fixture-secret");
  await flow.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(flow.locator("[data-auth-state]")).toHaveAttribute(
    "data-auth-state",
    "done",
  );
  await expect(flow).toContainText("Logged in as fixture identity");
  await expect(flow).toContainText("Login complete");
  await expect(input).toHaveValue("");
  await expect(openrouter.locator(".auth-badge")).toHaveText("authenticated");
  await expect(openrouter).toContainText("fixture identity");
  // The secret is never rendered back into the page.
  await expect(page.locator("body")).not.toContainText("sk-fixture-secret");

  await flow.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(flow).toBeHidden();
});

test("cancelling a login ends the flow without authenticating", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('[data-inspector-tab="auth"]').click();
  const pane = page.locator("[data-auth-pane]");
  const flow = pane.locator("[data-auth-flow]");
  const openrouter = pane.locator('[data-provider-id="openrouter"]');

  await openrouter.getByRole("button", { name: "Login", exact: true }).click();
  await expect(flow.locator("[data-auth-state]")).toHaveAttribute(
    "data-auth-state",
    "awaiting_input",
  );
  await flow.getByRole("button", { name: "Cancel login", exact: true }).click();
  await expect(flow.locator("[data-auth-state]")).toHaveAttribute(
    "data-auth-state",
    "cancelled",
  );
  await expect(
    flow.getByRole("button", { name: "Cancel login", exact: true }),
  ).toBeHidden();
  await expect(openrouter.locator(".auth-badge")).toHaveText(
    "not authenticated",
  );
  await expect(
    openrouter.getByRole("button", { name: "Login", exact: true }),
  ).toBeEnabled();
});

test("logging out removes the stored account after confirmation", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('[data-inspector-tab="auth"]').click();
  const anthropic = page
    .locator("[data-auth-pane]")
    .locator('[data-provider-id="anthropic"]');

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("work@example.com");
    void dialog.dismiss();
  });
  await anthropic.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(anthropic.locator(".auth-badge")).toHaveText("authenticated");

  page.once("dialog", (dialog) => void dialog.accept());
  await anthropic.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(anthropic.locator(".auth-badge")).toHaveText(
    "not authenticated",
  );
  await expect(anthropic).not.toContainText("work@example.com");
  await expect(
    anthropic.getByRole("button", { name: "Login", exact: true }),
  ).toBeEnabled();
});

test("view-only sessions have no Login tab", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-inspector-tab="auth"]')).toBeVisible();
  await page.getByRole("button", { name: /^viewer view$/i }).click();
  await expect(page.locator('[data-inspector-tab="auth"]')).toBeHidden();
});
