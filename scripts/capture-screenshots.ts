import { mkdir } from "node:fs/promises";
import { chromium, devices } from "../hub/node_modules/playwright/index.mjs";
import type { Page } from "../hub/node_modules/playwright/index.mjs";

// Run against a demo hub and demo hosts:
// bun run scripts/capture-screenshots.ts [output-dir] [desktop-session] [mobile-session]

const base = process.env.OMP_SCREENSHOT_BASE_URL ?? "http://127.0.0.1:48160/";
const out = process.argv[2] ?? "docs/screenshots";
const desktopSelect = process.argv[3] ?? "weather-station";
const mobileSelect = process.argv[4] ?? "motor-controller";
const busyLabel = process.env.OMP_SCREENSHOT_BUSY_SESSION ?? desktopSelect;
await mkdir(out, { recursive: true });

const browser = await chromium.launch();

async function prepare(page: Page) {
  await page.route("**/api/agents", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    // Show the busy indicator without sending a prompt to the demo agent.
    const agent = payload.agents.find(
      (item: { label: string }) => item.label === busyLabel,
    );
    if (!agent) throw new Error(`No registered agent labelled ${busyLabel}`);
    agent.busy = true;
    await route.fulfill({ response, json: payload });
  });
}

async function load(page: Page) {
  await prepare(page);
  await page.goto(base);
  await page.waitForSelector("[data-collab-frame]", {
    state: "attached",
    timeout: 20_000,
  });
  await page.waitForTimeout(3000);
}

async function select(page: Page, name: string, inRail = false) {
  const scope = inRail ? page.locator("[data-session-rail]") : page;
  const card = scope.getByText(name, { exact: true }).first();
  await card.waitFor({ state: "visible", timeout: 20_000 });
  await card.click();
  await page.waitForTimeout(5000);
}

async function waitForFiles(page: Page) {
  const list = page
    .locator("[data-files-pane]")
    .getByRole("list", { name: "Files" });
  await list.locator("[data-name]").first().waitFor({
    state: "visible",
    timeout: 20_000,
  });
}

try {
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    await load(page);
    await select(page, desktopSelect);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await waitForFiles(page);
    await page.screenshot({ path: `${out}/desktop.png` });
    await ctx.close();
  }

  {
    const ctx = await browser.newContext({
      ...devices["iPhone 13"],
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    await load(page);
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/mobile-sessions.png` });
    await select(page, mobileSelect, true);
    await page.getByRole("button", { name: "Inspector", exact: true }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await waitForFiles(page);
    await page.screenshot({ path: `${out}/mobile-session.png` });
    await ctx.close();
  }
} finally {
  await browser.close();
}
