// Rasterises src/webui/icon.svg into the PNG app icons the web app manifest
// references, using Playwright's Chromium so SVG filters render the same as
// in the browser. The PNGs are committed; rerun this after editing the SVG.
//
//   bun run scripts/render-icons.ts
//
// The SVG has no background, so the PNGs are transparent; the manifest
// background_color shows behind them on the splash screen.
import { chromium } from "playwright-core";

const webui = new URL("../src/webui/", import.meta.url).pathname;
const svg = await Bun.file(`${webui}icon.svg`).text();

const targets = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
];

const browser = await chromium.launch();
try {
  for (const { file, size } of targets) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
    });
    const sizedSvg = svg.replace("<svg ", '<svg width="100%" height="100%" ');
    await page.setContent(
      `<!doctype html><body style="margin:0;background:transparent">${sizedSvg}</body>`,
    );
    await page.screenshot({ path: `${webui}${file}`, omitBackground: true });
    await page.close();
    console.log(`rendered ${file}`);
  }
} finally {
  await browser.close();
}
