import * as path from "node:path";
import { expect, test } from "bun:test";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

test("omp-connected loads through the OMP extension loader", async () => {
	const extensionPath = path.resolve(import.meta.dir, "../../src/index.ts");
	const result = await loadExtensions([extensionPath], process.cwd());
	expect(result.errors).toEqual([]);
});