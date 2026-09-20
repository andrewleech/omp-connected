import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const launcher = path.resolve(import.meta.dir, "../../bin/ompc");

async function executable(pathname: string, body: string): Promise<void> {
	await Bun.write(pathname, `#!/usr/bin/env bash\n${body}`);
	await chmod(pathname, 0o755);
}

test("persistence launcher rejects unsafe session names", async () => {
	const result = Bun.spawnSync([launcher, "bad/name"]);
	expect(result.exitCode).toBe(64);
	expect(new TextDecoder().decode(result.stderr)).toContain("usage:");
});

test("persistence launcher fails closed without tmux", async () => {
	const result = Bun.spawnSync(["env", "PATH=/nonexistent", "/bin/bash", launcher, "build"]);
	expect(result.exitCode).toBe(69);
	expect(new TextDecoder().decode(result.stderr)).toContain("requires tmux");
});

test("persistence launcher ships a tmux configuration", () => {
	const tmuxConfig = path.resolve(import.meta.dir, "../../bin/omp-tmux.conf");
	expect(existsSync(tmuxConfig)).toBe(true);
	expect(Bun.file(tmuxConfig).text()).resolves.toContain("allow-passthrough on");
});

test("ompc keeps Collab commands on the native CLI, bypassing tmux entirely", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ompc-native-"));
	const fakeNative = path.join(directory, "native-omp");
	await executable(fakeNative, 'printf "native:%s\\n" "$*"\n');

	try {
		const result = Bun.spawnSync(["env", `OMP_BIN=${fakeNative}`, launcher, "collab", "list", "--json"]);
		const stdout = new TextDecoder().decode(result.stdout).trim();
		expect(stdout).toBe("native:collab list --json");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("ompc supports -d short option for --detach", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ompc-shortopt-"));
	const fakeOmp = path.join(directory, "fake-omp");
	await executable(fakeOmp, 'exec sleep 60\n');

	const nonce = `ompc-d-${process.pid}-${Date.now()}`;
	try {
		const result = Bun.spawnSync(["env", `OMP_BIN=${fakeOmp}`, launcher, "-d", nonce], { cwd: directory });
		const stdout = new TextDecoder().decode(result.stdout).trim();
		// Session name is basename(cwd).suffix
		const expectedName = `${path.basename(directory)}.${nonce}`;
		expect(stdout).toBe(expectedName);
		expect(result.exitCode).toBe(0);

		// Clean up the tmux server
		Bun.spawnSync(["tmux", "-L", expectedName, "kill-server"]);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("ompc uses OMP_BIN override when set", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ompc-bin-"));
	const fakeOmp = path.join(directory, "custom-omp");
	await executable(fakeOmp, 'printf "custom:%s\\n" "$*"\n');

	try {
		const result = Bun.spawnSync(["env", `OMP_BIN=${fakeOmp}`, launcher, "collab", "list"]);
		const stdout = new TextDecoder().decode(result.stdout).trim();
		expect(stdout).toBe("custom:collab list");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});