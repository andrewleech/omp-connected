import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const launcher = path.resolve(import.meta.dir, "../../bin/ompc");
const tmuxAvailable = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;
const servers: string[] = [];

function tmuxHasSession(socketName: string, sessionName: string): boolean {
	// Avoid `has-session -t` because dots in session names are parsed as
	// tmux's session.pane target separator; list-sessions is safe.
	const result = Bun.spawnSync(["tmux", "-L", socketName, "list-sessions", "-F", "#{session_name}"]);
	if (result.exitCode !== 0) return false;
	return new TextDecoder().decode(result.stdout).trim().split("\n").includes(sessionName);
}

function killServer(socketName: string): void {
	Bun.spawnSync(["tmux", "-L", socketName, "kill-server"]);
}

async function waitForSession(socketName: string, sessionName: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (tmuxHasSession(socketName, sessionName)) return;
		await Bun.sleep(50);
	}
	throw new Error(`tmux session ${sessionName} on socket ${socketName} did not start`);
}

afterEach(() => {
	for (const name of servers.splice(0)) killServer(name);
});

const tmuxTest = tmuxAvailable ? test : test.skip;

tmuxTest("detached sessions have independent tmux servers", async () => {
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

	await waitForSession(alphaSessionName, alphaSessionName);
	await waitForSession(bravoSessionName, bravoSessionName);
	servers.push(alphaSessionName, bravoSessionName);

	// Each session has its own tmux server (-L socket); killing one does
	// not affect the other.
	killServer(alphaSessionName);
	servers.splice(servers.indexOf(alphaSessionName), 1);
	expect(tmuxHasSession(bravoSessionName, bravoSessionName)).toBe(true);
});

tmuxTest("session names default to the working directory and append a suffix", async () => {
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

			await waitForSession(name, name);
			servers.push(name);
		}
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

tmuxTest("detach on existing session prints name without creating duplicate", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ompc-dup-"));
	const baseName = path.basename(directory);

	try {
		// First: create the session.
		const first = Bun.spawnSync(["env", "OMP_BIN=/bin/sh", launcher, "--detach", "-c", "exec sleep 60"], {
			cwd: directory,
		});
		expect(first.exitCode).toBe(0);
		await waitForSession(baseName, baseName);
		servers.push(baseName);

		// Second: --detach on existing just prints the name.
		const second = Bun.spawnSync(["env", "OMP_BIN=/bin/sh", launcher, "--detach"], { cwd: directory });
		expect(second.exitCode).toBe(0);
		expect(new TextDecoder().decode(second.stdout).trim()).toBe(baseName);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});