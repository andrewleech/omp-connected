// Bundles the fleet dashboard shell (plain TS, no framework) into a single
// browser-ready JS file with a content-hash filename, and copies index.html
// alongside it with the script src rewritten. Run build-vendor-collab.sh
// separately for the guest client under collab/.
import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}dist/webui`;

await $`mkdir -p ${dist}`;
// Clean old hashed bundles
for (const f of new Bun.Glob("app*.js").scanSync(dist)) await $`rm -f ${dist}/${f}`;
await $`rm -f ${dist}/index.html`;
// Build with content hash in the filename
const result = await Bun.build({
  entrypoints: [`${root}src/webui/app.ts`],
  outdir: dist,
  naming: "app.[hash].js",
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const outName = result.outputs[0].path.split("/").pop()!;
// Rewrite the script src in index.html
let html = await Bun.file(`${root}src/webui/index.html`).text();
html = html.replace(/src="\/app[^"]*\.js"/, `src="/${outName}"`);
await Bun.write(`${dist}/index.html`, html);
// Copy static assets
await $`cp ${root}src/webui/favicon.ico ${root}src/webui/favicon-32x32.png ${root}src/webui/favicon-180x180.png ${dist}/`;
console.log(`Built fleet dashboard shell into dist/webui\n  ${outName}`);