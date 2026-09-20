import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const launcher = path.resolve(import.meta.dir, "../../bin/ompc");
const screenAvailable = Bun.spawnSync(["screen", "--version"]).exitCode === 0;
const sessions: string[] = [];

function screenSession(name: string): string | undefined {
	const result = Bun.spawnSync(["screen", "-ls"]);
	const output = new TextDecoder().decode(result.stdout);
	return output.match(new RegExp(`^\\s*(\\d+\\.${name})\\s`, "m"))?.[1];
}

function stop(session: string): void {
	Bun.spawnSync(["screen", "-S", session, "-X", "quit"]);
}

async function waitForSession(name: string): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const session = screenSession(name);
		if (session) return session;
		await Bun.sleep(50);
	}
	throw new Error(`Screen session ${name} did not start`);
}

afterEach(() => {
	for (const session of sessions.splice(0)) stop(session);
});

const screenTest = screenAvailable ? test : test.skip;

screenTest("detached sessions have independent Screen servers", async () => {
	const nonce = `${process.pid}-${Date.now()}`;
	const workingDirectoryName = path.basename(process.cwd());
	const alpha = `omp-alpha-${nonce}`;
	const bravo = `omp-bravo-${nonce}`;
	const alphaSessionName = `${workingDirectoryName}.${alpha}`;
	const bravoSessionName = `${workingDirectoryName}.${bravo}`;

	for (const name of [alpha, bravo]) {
		const result = Bun.spawnSync(["env", "OMP_BIN=/bin/sh", launcher, "--detach", name, "-c", "exec sleep 60"]);
		expect(result.exitCode).toBe(0);
	}

	const alphaSession = await waitForSession(alphaSessionName);
	const bravoSession = await waitForSession(bravoSessionName);
	sessions.push(alphaSession, bravoSession);
	expect(alphaSession).not.toBe(bravoSession);

	stop(alphaSession);
	sessions.splice(sessions.indexOf(alphaSession), 1);
	expect(Bun.spawnSync(["screen", "-S", bravoSession, "-Q", "select", "."]).exitCode).toBe(0);
});

screenTest("session names default to the working directory and append a suffix", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ompc-"));
	const baseName = path.basename(directory);
	const suffixedName = `${baseName}.clipboard`;

	try {
		for (const [suffix, name] of [
			[undefined, baseName],
			["clipboard", suffixedName],
		] as const) {
			const args = ["env", "OMP_BIN=/bin/sh", launcher, "--detach"];
			if (suffix) args.push(suffix);
			args.push("-c", "exec sleep 60");

			const result = Bun.spawnSync(args, { cwd: directory });
			expect(result.exitCode).toBe(0);

			const session = await waitForSession(name);
			sessions.push(session);
		}
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});