// Bundles the fleet dashboard shell (plain TS, no framework) into a single
// browser-ready app.js, and copies index.html alongside it. Run
// build-vendor-collab.sh separately for the guest client under collab/.
import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;

await $`mkdir -p ${root}dist/webui`;
await $`rm -f ${root}dist/webui/app.js ${root}dist/webui/index.html`;
await $`bun build ${root}src/webui/app.ts --outdir=${root}dist/webui --entry-naming=app.js`;
await $`cp ${root}src/webui/index.html ${root}dist/webui/index.html`;
await $`cp ${root}src/webui/favicon.ico ${root}src/webui/favicon-32x32.png ${root}src/webui/favicon-180x180.png ${root}dist/webui/`;
console.log("Built fleet dashboard shell into dist/webui");