import { expect, test } from "bun:test";
import * as path from "node:path";

const trialRoot = path.resolve(import.meta.dir, "../../../../..");
const sourceFile = path.join(trialRoot, "node_modules/@oh-my-pi/pi-coding-agent/src/utils/clipboard.ts");
const screenConfig = path.join(trialRoot, "marketplace/plugins/omp-connected/bin/omp-screenrc");
const screenAvailable = Bun.spawnSync(["screen", "--version"]).exitCode === 0;
const screenTest = screenAvailable ? test : test.skip;

screenTest("Screen forwards the OMP clipboard envelope to the attached terminal", () => {
	const session = `osc52-test-${process.pid}-${Date.now()}`;
	const inner = `import { encodeOsc52ForTerminal } from "${sourceFile}"; process.stdout.write(encodeOsc52ForTerminal("hello", "screen"));`;
	const command = `screen -c '${screenConfig}' -S ${session} bun -e '${inner}'`;
	const result = Bun.spawnSync(["script", "-qefc", command, "/dev/null"], { env: { ...process.env, TERM: "xterm" } });

	expect(result.exitCode).toBe(0);
	expect(new TextDecoder().decode(result.stdout)).toContain("\x1b]52;c;aGVsbG8=\x07");
});

screenTest("Screen preserves the attached terminal's native scrollback", () => {
	const session = `scrollback-test-${process.pid}-${Date.now()}`;
	const command = `screen -c '${screenConfig}' -S ${session} /bin/sh -c 'printf ready'`;
	const result = Bun.spawnSync(["script", "-qefc", command, "/dev/null"], { env: { ...process.env, TERM: "xterm" } });

	expect(result.exitCode).toBe(0);
	expect(new TextDecoder().decode(result.stdout)).not.toContain("\x1b[?1049h");
});