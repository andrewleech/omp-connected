// Rasterises src/webui/icon.svg into the PNG app icons the web app manifest
// references, using Playwright's Chromium so SVG filters render the same as
// in the browser. The PNGs are committed; rerun this after editing the SVG.
//
//   bun run scripts/render-icons.ts
//
// icon-*.png keep the SVG's rounded corners (purpose "any"). The maskable
// icon is full-bleed background with the artwork scaled into the central
// 80% safe-zone circle, so Android launcher masks never crop it.
import { chromium } from "playwright-core";

const webui = new URL("../src/webui/", import.meta.url).pathname;
const svg = await Bun.file(`${webui}icon.svg`).text();
// Must match the SVG's background rect fill.
const background = "#0e0913";
// Artwork reaches ~91% of the half-width (outer nodes plus glow); 0.86
// scale keeps it inside the 40%-radius safe zone with a little margin.
const maskableScale = 0.86;

const targets = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
];

const browser = await chromium.launch();
try {
  for (const { file, size, maskable } of targets) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
    });
    const inner = maskable ? Math.round(size * maskableScale) : size;
    const offset = (size - inner) / 2;
    const pageBackground = maskable ? background : "transparent";
    const sizedSvg = svg.replace("<svg ", '<svg width="100%" height="100%" ');
    await page.setContent(
      `<!doctype html><body style="margin:0;background:${pageBackground}">` +
        `<div style="position:absolute;left:${offset}px;top:${offset}px;width:${inner}px;height:${inner}px">` +
        `${sizedSvg}</div></body>`,
    );
    await page.screenshot({
      path: `${webui}${file}`,
      omitBackground: !maskable,
    });
    await page.close();
    console.log(`rendered ${file}`);
  }
} finally {
  await browser.close();
}
