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

test("persistence launcher fails closed without GNU Screen", async () => {
	const result = Bun.spawnSync(["env", "PATH=/nonexistent", "/bin/bash", launcher, "build"]);
	expect(result.exitCode).toBe(69);
	expect(new TextDecoder().decode(result.stderr)).toContain("requires GNU Screen");
});

test("persistence launcher ships a 256-colour Screen configuration", () => {
	const screenConfig = path.resolve(import.meta.dir, "../../bin/omp-screenrc");
	expect(existsSync(screenConfig)).toBe(true);
	expect(Bun.file(screenConfig).text()).resolves.toContain("term screen-256color");
});

test("ompc keeps Collab commands on the native CLI, bypassing Screen entirely", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ompc-native-"));
	const fakeNative = path.join(directory, "native-omp");
	await executable(fakeNative, 'printf "native:%s\\n" "$*"\n');

	try {
		const result = Bun.spawnSync([launcher, "collab", "list", "--json"], {
			cwd: directory,
			env: { ...process.env, OMP_BIN: fakeNative },
		});
		expect(result.exitCode).toBe(0);
		expect(new TextDecoder().decode(result.stdout)).toBe("native:collab list --json\n");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("ompc reattaches to a matching existing Screen session instead of creating a new one", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ompc-reattach-"));
	const projectDir = path.join(directory, "proj");
	await mkdir(projectDir);
	const fakeScreen = path.join(directory, "screen");
	await executable(
		fakeScreen,
		[
			'case "$1" in',
			'-ls) printf "\\t12345.proj\\t(Detached)\\n" ;;',
			'-r) printf "reattached:%s\\n" "$2" ;;',
			'*) echo "unexpected screen invocation: $*" >&2; exit 1 ;;',
			"esac",
		].join("\n"),
	);

	try {
		const result = Bun.spawnSync([launcher], {
			cwd: projectDir,
			env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
		});
		expect(result.exitCode).toBe(0);
		expect(new TextDecoder().decode(result.stdout)).toBe("reattached:12345.proj\n");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("ompc starts a fresh Screen session named after the working directory when none exists", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ompc-fresh-"));
	const projectDir = path.join(directory, "proj");
	await mkdir(projectDir);
	const fakeScreen = path.join(directory, "screen");
	await executable(fakeScreen, 'printf "screen-args:%s\\n" "$*"\n');

	try {
		const result = Bun.spawnSync([launcher], {
			cwd: projectDir,
			env: {
				...process.env,
				OMP_BIN: "/fake/native-omp",
				PATH: `${directory}:${process.env.PATH}`,
			},
		});
		expect(result.exitCode).toBe(0);
		const stdout = new TextDecoder().decode(result.stdout);
		expect(stdout).toContain("-S proj");
		expect(stdout).toContain("/fake/native-omp");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("ompc starts a fresh suffixed Screen session when none exists", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ompc-fresh-suffix-"));
	const projectDir = path.join(directory, "proj");
	await mkdir(projectDir);
	const fakeScreen = path.join(directory, "screen");
	await executable(fakeScreen, 'printf "screen-args:%s\\n" "$*"\n');

	try {
		const result = Bun.spawnSync([launcher, "clipboard"], {
			cwd: projectDir,
			env: {
				...process.env,
				OMP_BIN: "/fake/native-omp",
				PATH: `${directory}:${process.env.PATH}`,
			},
		});
		expect(result.exitCode).toBe(0);
		expect(new TextDecoder().decode(result.stdout)).toContain("-S proj.clipboard");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});