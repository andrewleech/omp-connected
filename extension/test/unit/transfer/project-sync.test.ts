import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyProjectUpdate,
	buildManifest,
	computePlanDigest,
	DEFAULT_EXCLUDES,
	diffManifests,
	type ManifestEntry,
	type PlanEntry,
	type ProjectPlan,
	ProjectSyncError,
	publishNewProject,
	resolveDestinationProject,
	restoreProjectUpdate,
	sha256File,
	type TreeManifest,
	validateDestinationPath,
} from "../../../src/transfer/project-sync.js";

let base: string;

beforeEach(async () => {
	base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "project-sync-")));
});

afterEach(async () => {
	// Restore owner access so cleanup can remove read-only directories.
	try {
		execFileSync("chmod", ["-R", "u+rwx", base], { stdio: "ignore" });
	} catch {
		// Dangling symlinks make chmod exit non-zero; removal below still works.
	}
	await fs.rm(base, { recursive: true, force: true });
});

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const modeOf = async (p: string) => (await fs.lstat(p)).mode & 0o777;

async function put(root: string, rel: string, content: string | Buffer, mode = 0o644): Promise<void> {
	const file = path.join(root, rel);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
	await fs.chmod(file, mode);
}

async function mkdir(root: string, rel: string, mode = 0o755): Promise<void> {
	const dir = path.join(root, rel);
	await fs.mkdir(dir, { recursive: true });
	await fs.chmod(dir, mode);
}

async function codeOf(promise: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
	try {
		await (typeof promise === "function" ? promise() : promise);
	} catch (error) {
		return (error as ProjectSyncError).code;
	}
	return undefined;
}

const file = (p: string, content: string, mode = 0o644): ManifestEntry => ({
	path: p,
	kind: "file",
	mode,
	size: Buffer.byteLength(content),
	sha256: sha(content),
});
const dir = (p: string, mode = 0o755): ManifestEntry => ({ path: p, kind: "dir", mode });
const link = (p: string, target: string): ManifestEntry => ({ path: p, kind: "symlink", mode: 0o777, target });
const manifest = (...entries: ManifestEntry[]): TreeManifest => ({ root: "/x", entries, warnings: [] });

describe("buildManifest", () => {
	test("records hidden, .git, empty, unicode and spaced entries in sorted order with masked modes", async () => {
		const root = path.join(base, "tree");
		await put(root, "b.txt", "bee");
		await put(root, "a.txt", "ay");
		await put(root, ".hidden/inner", "h");
		await put(root, ".git/HEAD", "ref: refs/heads/main\n");
		await put(root, "dir with space/ünï ✓.txt", "uni");
		await mkdir(root, "empty");
		await put(root, "run.sh", "#!/bin/sh\n", 0o755);
		await fs.chmod(path.join(root, "run.sh"), 0o4755);

		const result = await buildManifest(root);
		const paths = result.entries.map((e) => e.path);
		expect(paths).toEqual([...paths].sort());
		expect(paths).toEqual([
			".git",
			".git/HEAD",
			".hidden",
			".hidden/inner",
			"a.txt",
			"b.txt",
			"dir with space",
			"dir with space/ünï ✓.txt",
			"empty",
			"run.sh",
		]);
		const byPath = new Map(result.entries.map((e) => [e.path, e]));
		expect(byPath.get("empty")).toEqual({ path: "empty", kind: "dir", mode: 0o755 });
		expect(byPath.get("b.txt")).toEqual({ path: "b.txt", kind: "file", mode: 0o644, size: 3, sha256: sha("bee") });
		expect(byPath.get("run.sh")?.mode).toBe(0o755);
		expect(result.root).toBe(root);
		expect(result.warnings).toEqual([]);
	});

	test("does not honour .gitignore and applies only default and caller excludes", async () => {
		const root = path.join(base, "tree");
		await put(root, ".gitignore", "keep.txt\nnode_modules\n");
		await put(root, "keep.txt", "k");
		await put(root, ".DS_Store", "x");
		await put(root, "sub/.DS_Store", "x");
		await put(root, "debug.log", "x");
		await put(root, "sub/x.log", "x");
		await put(root, "build/out.bin", "x");
		await put(root, "sub/build/kept", "x");
		await put(root, "node_modules/pkg/i.js", "x");
		await put(root, "cache/a/tmp/f", "x");

		expect(DEFAULT_EXCLUDES).toContain(".DS_Store");
		const result = await buildManifest(root, { exclude: ["*.log", "/build/", "cache/**/tmp/"] });
		const paths = result.entries.map((e) => e.path);
		expect(paths).toContain("keep.txt");
		expect(paths).toContain("node_modules/pkg/i.js");
		expect(paths).toContain("sub/build/kept");
		for (const gone of [".DS_Store", "sub/.DS_Store", "debug.log", "sub/x.log", "build", "build/out.bin", "cache/a/tmp"]) {
			expect(paths).not.toContain(gone);
		}
		expect(paths).toContain("cache/a");
	});

	test("rejects an empty exclude pattern", async () => {
		const root = path.join(base, "tree");
		await mkdir(root, ".");
		expect(await codeOf(buildManifest(root, { exclude: [" "] }))).toBe("invalid-exclude");
	});

	test("records symlinks by target without following them", async () => {
		const root = path.join(base, "tree");
		const outside = path.join(base, "outside");
		await put(outside, "secret.txt", "s");
		await mkdir(root, ".");
		await put(root, "inside/f", "f");
		await fs.symlink(outside, path.join(root, "out-link"));
		await fs.symlink("inside", path.join(root, "in-link"));
		await fs.symlink("/etc/hosts", path.join(root, "abs-link"));
		await fs.symlink("../outside/secret.txt", path.join(root, "rel-out"));

		const result = await buildManifest(root);
		const paths = result.entries.map((e) => e.path);
		expect(paths).not.toContain("out-link/secret.txt");
		expect(paths).not.toContain("in-link/f");
		expect(result.entries.find((e) => e.path === "out-link")).toMatchObject({ kind: "symlink", target: outside });
		expect(result.entries.find((e) => e.path === "in-link")).toMatchObject({ kind: "symlink", target: "inside" });
		expect(result.warnings).toEqual([
			{ kind: "absolute-symlink", path: "abs-link", detail: "/etc/hosts" },
			{ kind: "external-symlink", path: "abs-link", detail: "/etc/hosts" },
			{ kind: "absolute-symlink", path: "out-link", detail: outside },
			{ kind: "external-symlink", path: "out-link", detail: outside },
			{ kind: "external-symlink", path: "rel-out", detail: "../outside/secret.txt" },
		]);
	});

	test("warns about secret file names without reading content, and about git worktrees and submodules", async () => {
		const root = path.join(base, "tree");
		await put(root, ".env", "TOKEN=hunter2");
		await put(root, ".env.local", "TOKEN=hunter2");
		await put(root, ".env.example", "TOKEN=");
		await put(root, "certs/server.pem", "-----BEGIN");
		await put(root, "id_ed25519", "key");
		await put(root, "id_ed25519.pub", "pub");
		await put(root, "plain.txt", "x");
		await put(root, ".gitmodules", '[submodule "lib"]\n\tpath = vendor/lib\n\turl = https://example.invalid/lib.git\n');
		await put(root, "vendor/lib/.git", "gitdir: ../../.git/modules/lib\n");
		await put(root, ".git/modules/lib/HEAD", "x");
		await put(root, "wt/.git", "gitdir: /home/user/main-repo/.git/worktrees/wt\n");
		await put(root, "inner/.git", "gitdir: ../.git\n");

		const result = await buildManifest(root);
		const flat = result.warnings.map((w) => `${w.kind}:${w.path}`);
		expect(flat).toEqual([
			"possible-secret-file:.env",
			"possible-secret-file:.env.local",
			"possible-secret-file:certs/server.pem",
			"possible-secret-file:id_ed25519",
			"submodule:vendor/lib",
			"external-gitdir:wt/.git",
		]);
		expect(JSON.stringify(result.warnings)).not.toContain("hunter2");
		expect(result.warnings.find((w) => w.kind === "external-gitdir")?.detail).toBe(
			"/home/user/main-repo/.git/worktrees/wt",
		);
	});

	test("skips fifos with a warning and never records them", async () => {
		const root = path.join(base, "tree");
		await put(root, "f", "x");
		execFileSync("mkfifo", [path.join(root, "pipe")]);
		const result = await buildManifest(root);
		expect(result.entries.map((e) => e.path)).toEqual(["f"]);
		expect(result.warnings).toEqual([{ kind: "special-file-skipped", path: "pipe", detail: "fifo" }]);
	});

	test("hashes large files by streaming and sha256File refuses symlinks", async () => {
		const root = path.join(base, "tree");
		const big = randomBytes(5 * 1024 * 1024 + 7);
		await put(root, "big.bin", big);
		await fs.symlink("big.bin", path.join(root, "alias"));
		const result = await buildManifest(root);
		expect(result.entries.find((e) => e.path === "big.bin")).toMatchObject({ size: big.length, sha256: sha(big) });
		expect(await sha256File(path.join(root, "big.bin"))).toBe(sha(big));
		await expect(sha256File(path.join(root, "alias"))).rejects.toThrow();
	});

	test("rejects a non-directory root", async () => {
		await put(base, "plain", "x");
		expect(await codeOf(buildManifest(path.join(base, "plain")))).toBe("invalid-root");
	});
});

describe("diffManifests", () => {
	test("session-only plans nothing", () => {
		const plan = diffManifests(manifest(file("a", "x")), undefined, "session-only");
		expect(plan).toMatchObject({ mode: "session-only", entries: [], unchanged: 0, destinationOnly: 0, conflicts: [], totalBytes: 0 });
		expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	test("create adds every entry and requires an empty destination", () => {
		const source = manifest(dir("d"), file("d/f", "four"), link("l", "d"));
		const plan = diffManifests(source, undefined, "create");
		expect(plan.entries.map((e) => [e.path, e.action, e.kind, e.bytes])).toEqual([
			["d", "add", "dir", 0],
			["d/f", "add", "file", 4],
			["l", "add", "symlink", 0],
		]);
		expect(plan.totalBytes).toBe(4);
		expect(diffManifests(source, manifest(), "create").entries).toHaveLength(3);
		expect(() => diffManifests(source, manifest(file("x", "y")), "create")).toThrow(ProjectSyncError);
	});

	test("update requires a destination manifest", () => {
		expect(() => diffManifests(manifest(), undefined, "update")).toThrow(ProjectSyncError);
	});

	test("update counts add, replace, mode-change, unchanged and destination-only entries", () => {
		const source = manifest(
			file("added", "new!"),
			file("changed", "newer"),
			dir("d"),
			file("d/inside", "in"),
			file("exec", "run", 0o755),
			file("flip", "x"),
			dir("modedir", 0o700),
			file("same", "same"),
			link("sl", "same"),
			link("sl2", "other"),
		);
		const destination = manifest(
			file("changed", "old"),
			dir("d"),
			file("exec", "run", 0o644),
			link("flip", "same"),
			dir("modedir", 0o755),
			file("only-here", "keep"),
			file("same", "same"),
			link("sl", "same"),
			link("sl2", "different"),
		);
		const plan = diffManifests(source, destination, "update");
		expect(plan.conflicts).toEqual([]);
		expect(plan.entries.map((e) => [e.path, e.action, e.kind, e.bytes])).toEqual([
			["added", "add", "file", 4],
			["changed", "replace", "file", 5],
			["d/inside", "add", "file", 2],
			["exec", "mode-change", "file", 0],
			["flip", "replace", "file", 1],
			["modedir", "mode-change", "dir", 0],
			["sl2", "replace", "symlink", 0],
		]);
		expect(plan.unchanged).toBe(3);
		expect(plan.destinationOnly).toBe(1);
		expect(plan.totalBytes).toBe(4 + 5 + 2 + 1);
		expect(plan.entries.find((e) => e.path === "changed")?.destination).toEqual({
			kind: "file",
			mode: 0o644,
			sha256: sha("old"),
		});
	});

	test("file replaced by a symlink and an empty directory replaced by a file are plain replacements", () => {
		const plan = diffManifests(
			manifest(link("a", "t"), file("b", "x")),
			manifest(file("a", "was a file"), dir("b")),
			"update",
		);
		expect(plan.conflicts).toEqual([]);
		expect(plan.entries.map((e) => [e.path, e.action, e.kind])).toEqual([
			["a", "replace", "symlink"],
			["b", "replace", "file"],
		]);
	});

	test("reports a non-empty destination directory replaced by a file or symlink", () => {
		const destination = manifest(dir("x"), file("x/keep", "k"), dir("y"), file("y/deep", "d"), dir("z"));
		const plan = diffManifests(manifest(file("x", "f"), link("y", "t"), file("z", "ok")), destination, "update");
		expect(plan.conflicts).toEqual([
			{ path: "x", sourceKind: "file", destinationKind: "dir", reason: "non-empty destination directory would be replaced by a file" },
			{ path: "y", sourceKind: "symlink", destinationKind: "dir", reason: "non-empty destination directory would be replaced by a symlink" },
		]);
		expect(plan.entries.map((e) => e.path)).toEqual(["z"]);
		expect(plan.destinationOnly).toBe(2);
	});

	test("reports a path beneath a destination symlink once per symlink", () => {
		const plan = diffManifests(
			manifest(dir("lnk"), file("lnk/a", "1"), file("lnk/b", "2"), dir("ok")),
			manifest(link("lnk", "/elsewhere"), dir("ok")),
			"update",
		);
		expect(plan.conflicts).toEqual([
			{ path: "lnk/a", sourceKind: "file", destinationKind: "symlink", reason: "path lies beneath destination symlink 'lnk'" },
		]);
		expect(plan.entries.map((e) => e.path)).not.toContain("lnk/a");
		expect(plan.entries.map((e) => e.path)).not.toContain("lnk/b");
	});

	test("rejects hostile manifests", async () => {
		const hostile: ManifestEntry[][] = [
			[file("../escape", "x")],
			[file("/abs/path", "x")],
			[dir("a"), file("a/../b", "x")],
			[dir("a"), file("a//b", "x")],
			[file("./a", "x")],
			[file("", "x")],
			[file("a/b", "x")],
			[file("f", "x"), file("f/child", "y")],
			[{ path: "bad", kind: "file", mode: 0o644, size: 1, sha256: "nothex" }],
			[{ path: "setuid", kind: "file", mode: 0o4755, size: 1, sha256: sha("x") }],
			[{ path: "l", kind: "symlink", mode: 0o777 }],
			[file("dup", "a"), file("dup", "b")],
		];
		for (const entries of hostile) {
			expect(await codeOf(() => diffManifests(manifest(...entries), manifest(), "create"))).toBe("invalid-manifest");
			expect(await codeOf(() => diffManifests(manifest(), manifest(...entries), "update"))).toBe("invalid-manifest");
		}
	});

	test("digest is a stable sha256 over the plan content", () => {
		const source = manifest(file("b", "bee"), file("a", "ay"), dir("d"), file("d/c", "cee"));
		const destination = manifest(file("a", "old"), dir("d"));
		const plan = diffManifests(source, destination, "update");
		expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(diffManifests(source, destination, "update").digest).toBe(plan.digest);
		const shuffled = manifest(...[...source.entries].reverse());
		expect(diffManifests(shuffled, destination, "update").digest).toBe(plan.digest);
		expect(computePlanDigest(plan)).toBe(plan.digest);
		expect(computePlanDigest(JSON.parse(JSON.stringify(plan)))).toBe(plan.digest);
		const changed = diffManifests(manifest(file("b", "bee"), file("a", "AY"), dir("d"), file("d/c", "cee")), destination, "update");
		expect(changed.digest).not.toBe(plan.digest);
		const created = diffManifests(source, undefined, "create");
		expect(created.digest).not.toBe(plan.digest);
	});

	test("session-only digest differs from an update digest", () => {
		const source = manifest(file("a", "x"));
		expect(diffManifests(source, undefined, "session-only").digest).not.toBe(diffManifests(source, manifest(), "update").digest);
	});
});

describe("resolveDestinationProject", () => {
	test("maps a project below the source home by path components", () => {
		expect(resolveDestinationProject("/home/user/work/my project/ü", "/home/user", "/srv/dest")).toBe(
			"/srv/dest/work/my project/ü",
		);
		expect(resolveDestinationProject("/home/user/work/", "/home/user/", "/home/other")).toBe("/home/other/work");
	});

	test("throws when the project is outside the source home or is the home", async () => {
		for (const project of ["/opt/proj", "/home/user2/proj", "/home/user", "/home"]) {
			expect(() => resolveDestinationProject(project, "/home/user", "/home/other")).toThrow(ProjectSyncError);
		}
		expect(await codeOf(() => resolveDestinationProject("/opt/proj", "/home/user", "/home/other"))).toBe("project-outside-home");
	});

	test("an override wins, expands ~ against the destination home and must be absolute without '..'", () => {
		expect(resolveDestinationProject("/opt/proj", "/home/user", "/home/other", "/srv/x")).toBe("/srv/x");
		expect(resolveDestinationProject("/home/user/p", "/home/user", "/home/other", "~/elsewhere")).toBe("/home/other/elsewhere");
		expect(() => resolveDestinationProject("/opt/p", "/home/user", "/home/other", "relative")).toThrow(ProjectSyncError);
		expect(() => resolveDestinationProject("/opt/p", "/home/user", "/home/other", "/srv/../etc")).toThrow(ProjectSyncError);
	});
});

describe("validateDestinationPath", () => {
	let home: string;
	let policy: { home: string; allowedRoots: string[]; protectedPaths: string[] };

	beforeEach(async () => {
		home = path.join(base, "home");
		await mkdir(home, ".");
		await mkdir(home, ".ssh");
		await mkdir(home, "work");
		policy = { home, allowedRoots: ["~"], protectedPaths: ["~/.ssh", "~/.omp", "~/.config/omp-connected"] };
	});

	test("accepts a new project below an allowed root and returns the canonical path", async () => {
		expect(await validateDestinationPath(path.join(home, "work", "new proj", "ü"), policy)).toBe(
			path.join(home, "work", "new proj", "ü"),
		);
		expect(await validateDestinationPath("~/work/x", policy)).toBe(path.join(home, "work", "x"));
	});

	test("canonicalises a symlinked ancestor that stays inside the allowed root", async () => {
		await fs.symlink(path.join(home, "work"), path.join(home, "alias"));
		expect(await validateDestinationPath(path.join(home, "alias", "p"), policy)).toBe(path.join(home, "work", "p"));
	});

	test("rejects the home directory and the filesystem root", async () => {
		expect(await codeOf(validateDestinationPath(home, policy))).toBe("path-policy");
		expect(await codeOf(validateDestinationPath(`${home}/`, policy))).toBe("path-policy");
		expect(await codeOf(validateDestinationPath("~", policy))).toBe("path-policy");
		expect(await codeOf(validateDestinationPath("/", { ...policy, allowedRoots: ["/"] }))).toBe("path-policy");
	});

	test("rejects protected paths, their descendants and their ancestors", async () => {
		for (const candidate of [
			path.join(home, ".ssh"),
			path.join(home, ".ssh", "keys"),
			path.join(home, ".omp", "agent"),
			path.join(home, ".config"),
			path.join(home, ".config", "omp-connected", "transfers"),
		]) {
			expect(await codeOf(validateDestinationPath(candidate, policy))).toBe("path-policy");
		}
	});

	test("rejects paths outside the allowed roots and an allowed root itself", async () => {
		const narrow = { ...policy, allowedRoots: ["~/work"] };
		expect(await codeOf(validateDestinationPath(path.join(home, "other"), narrow))).toBe("path-policy");
		expect(await codeOf(validateDestinationPath(path.join(base, "outside"), policy))).toBe("path-policy");
		expect(await codeOf(validateDestinationPath(path.join(home, "work"), narrow))).toBe("path-policy");
		expect(await validateDestinationPath(path.join(home, "work", "p"), narrow)).toBe(path.join(home, "work", "p"));
	});

	test("rejects symlink escapes and symlinks into protected paths", async () => {
		const outside = path.join(base, "outside");
		await mkdir(outside, ".");
		await fs.symlink(outside, path.join(home, "escape"));
		await fs.symlink(path.join(home, ".ssh"), path.join(home, "sneaky"));
		await fs.symlink(path.join(base, "nowhere"), path.join(home, "dangling"));
		expect(await codeOf(validateDestinationPath(path.join(home, "escape", "proj"), policy))).toBe("path-policy");
		expect(await codeOf(validateDestinationPath(path.join(home, "sneaky", "proj"), policy))).toBe("path-policy");
		expect(await codeOf(validateDestinationPath(path.join(home, "dangling", "proj"), policy))).toBe("path-policy");
	});

	test("rejects relative paths, traversal and NUL bytes", async () => {
		for (const candidate of ["work/p", `${home}/work/../../outside`, `${home}/work/../work/p`, `${home}/a\0b`]) {
			expect(await codeOf(validateDestinationPath(candidate, policy))).toBe("path-policy");
		}
	});
});

interface Scenario {
	src: string;
	dst: string;
	staging: string;
	undo: string;
	destManifest: TreeManifest;
	plan: ProjectPlan;
}

async function scenario(): Promise<Scenario> {
	const src = path.join(base, "src");
	const dst = path.join(base, "dst");
	const staging = path.join(base, "staging");
	const undo = path.join(base, "undo");
	await put(src, "same.txt", "same");
	await put(src, "edit.txt", "new content");
	await put(src, "exec.sh", "#!/bin/sh\n", 0o755);
	await put(src, "added/n.txt", "n");
	await mkdir(src, "added/empty");
	await put(src, "unicode dir/ü ñ.txt", "u");
	await fs.symlink("same.txt", path.join(src, "link"));
	await fs.symlink("same.txt", path.join(src, "flip"));
	await put(src, "d2", "was an empty dir");
	await put(src, "moded/f", "f");
	await mkdir(src, "moded", 0o700);
	await mkdir(src, "keepdir");
	await put(src, "keepdir/new.txt", "k");
	await put(src, "ro/f", "ro");
	await fs.chmod(path.join(src, "ro"), 0o555);

	await put(dst, "same.txt", "same");
	await put(dst, "edit.txt", "old content");
	await put(dst, "exec.sh", "#!/bin/sh\n", 0o644);
	await put(dst, "flip", "plain file");
	await mkdir(dst, "d2");
	await put(dst, "only.txt", "destination only");
	await put(dst, "moded/f", "f");
	await mkdir(dst, "moded", 0o755);
	await mkdir(dst, "keepdir");

	const sourceManifest = await buildManifest(src);
	const destManifest = await buildManifest(dst);
	const plan = diffManifests(sourceManifest, destManifest, "update");
	execFileSync("cp", ["-a", `${src}/.`, `${await mkdirReturn(staging)}/`]);
	return { src, dst, staging, undo, destManifest, plan };
}

async function mkdirReturn(p: string): Promise<string> {
	await fs.mkdir(p, { recursive: true });
	return p;
}

describe("applyProjectUpdate and restoreProjectUpdate", () => {
	test("plan for the scenario has the expected actions", async () => {
		const { plan } = await scenario();
		expect(plan.conflicts).toEqual([]);
		expect(plan.entries.map((e) => `${e.action}:${e.path}`)).toEqual([
			"add:added",
			"add:added/empty",
			"add:added/n.txt",
			"replace:d2",
			"replace:edit.txt",
			"mode-change:exec.sh",
			"replace:flip",
			"add:keepdir/new.txt",
			"add:link",
			"mode-change:moded",
			"add:ro",
			"add:ro/f",
			"add:unicode dir",
			"add:unicode dir/ü ñ.txt",
		]);
	});

	test("applies the plan, keeps destination-only entries and round-trips through restore", async () => {
		const { src, dst, staging, undo, destManifest, plan } = await scenario();
		const undoManifest = await applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan, undoDir: undo });

		expect(undoManifest.status).toBe("applied");
		expect(await fs.readFile(path.join(dst, "edit.txt"), "utf8")).toBe("new content");
		expect(await modeOf(path.join(dst, "exec.sh"))).toBe(0o755);
		expect(await fs.readFile(path.join(dst, "added/n.txt"), "utf8")).toBe("n");
		expect((await fs.lstat(path.join(dst, "added/empty"))).isDirectory()).toBe(true);
		expect(await fs.readFile(path.join(dst, "unicode dir/ü ñ.txt"), "utf8")).toBe("u");
		expect(await fs.readlink(path.join(dst, "link"))).toBe("same.txt");
		expect(await fs.readlink(path.join(dst, "flip"))).toBe("same.txt");
		expect(await fs.readFile(path.join(dst, "d2"), "utf8")).toBe("was an empty dir");
		expect(await modeOf(path.join(dst, "moded"))).toBe(0o700);
		expect(await modeOf(path.join(dst, "ro"))).toBe(0o555);
		expect(await fs.readFile(path.join(dst, "only.txt"), "utf8")).toBe("destination only");
		expect((await fs.lstat(path.join(dst, "keepdir"))).isDirectory()).toBe(true);

		const created = undoManifest.entries.filter((e) => e.prior.kind === "absent").map((e) => e.path).sort();
		expect(created).toEqual(["added", "added/empty", "added/n.txt", "keepdir/new.txt", "link", "ro", "ro/f", "unicode dir", "unicode dir/ü ñ.txt"]);
		const edit = undoManifest.entries.find((e) => e.path === "edit.txt");
		expect(edit?.result).toEqual({ kind: "file", mode: 0o644, sha256: sha("new content") });
		expect(edit?.prior).toMatchObject({ kind: "file", mode: 0o644, sha256: sha("old content") });
		expect(await fs.readFile(path.join(undo, "backup", edit?.prior.backup as string), "utf8")).toBe("old content");
		expect(undoManifest.entries.find((e) => e.path === "exec.sh")?.prior).toEqual({ kind: "file", mode: 0o644, sha256: sha("#!/bin/sh\n") });
		expect(JSON.parse(await fs.readFile(path.join(undo, "undo.json"), "utf8")).planDigest).toBe(plan.digest);

		// The destination now matches the source for every planned entry.
		const after = diffManifests(await buildManifest(src), await buildManifest(dst), "update");
		expect(after.entries).toEqual([]);
		expect(after.destinationOnly).toBe(1);

		const first = await restoreProjectUpdate(undo);
		expect(first.conflicts).toEqual([]);
		expect(first.restored).toContain("edit.txt");
		expect(first.restored).toContain("added");
		const restoredManifest = await buildManifest(dst);
		expect(restoredManifest.entries).toEqual(destManifest.entries);

		const second = await restoreProjectUpdate(undo);
		expect(second).toEqual({ restored: [], conflicts: [] });
		expect((await buildManifest(dst)).entries).toEqual(destManifest.entries);
	});

	test("restore reports an intervening edit as a conflict and never overwrites it", async () => {
		const { dst, staging, undo, plan } = await scenario();
		await applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan, undoDir: undo });
		await fs.writeFile(path.join(dst, "edit.txt"), "user edit");
		await fs.writeFile(path.join(dst, "added/n.txt"), "user edit 2");
		await fs.chmod(path.join(dst, "exec.sh"), 0o700);

		const result = await restoreProjectUpdate(undo);
		expect(result.conflicts).toEqual(["added/n.txt", "edit.txt", "exec.sh"]);
		expect(await fs.readFile(path.join(dst, "edit.txt"), "utf8")).toBe("user edit");
		expect(await fs.readFile(path.join(dst, "added/n.txt"), "utf8")).toBe("user edit 2");
		expect(await modeOf(path.join(dst, "exec.sh"))).toBe(0o700);
		// The directory holding the conflicting file stays; it is not reported separately.
		expect((await fs.lstat(path.join(dst, "added"))).isDirectory()).toBe(true);
		expect(result.restored).toContain("link");
		expect(result.restored).toContain("flip");
		await expect(fs.lstat(path.join(dst, "link"))).rejects.toThrow();
		expect(await fs.readFile(path.join(dst, "flip"), "utf8")).toBe("plain file");
		expect((await fs.lstat(path.join(dst, "d2"))).isDirectory()).toBe(true);

		// Running again after resolving nothing gives the same conflicts and changes nothing.
		const again = await restoreProjectUpdate(undo);
		expect(again.conflicts).toEqual(["added/n.txt", "edit.txt", "exec.sh"]);
		expect(again.restored).toEqual([]);
		expect(await fs.readFile(path.join(dst, "edit.txt"), "utf8")).toBe("user edit");
	});

	test("restore leaves a created directory that gained foreign content and reports it", async () => {
		const { dst, staging, undo, plan } = await scenario();
		await applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan, undoDir: undo });
		await put(dst, "unicode dir/mine.txt", "mine");
		const result = await restoreProjectUpdate(undo);
		expect(result.conflicts).toEqual(["unicode dir"]);
		expect(result.restored).toContain("unicode dir/ü ñ.txt");
		expect(await fs.readFile(path.join(dst, "unicode dir/mine.txt"), "utf8")).toBe("mine");
		await expect(fs.lstat(path.join(dst, "unicode dir/ü ñ.txt"))).rejects.toThrow();
	});

	test("restore conflicts when a created path was replaced by a symlink or its ancestor was swapped", async () => {
		const { dst, staging, undo, plan } = await scenario();
		await applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan, undoDir: undo });
		await fs.rm(path.join(dst, "link"));
		await fs.mkdir(path.join(dst, "link"));
		const outside = path.join(base, "outside");
		await mkdir(outside, ".");
		await put(outside, "n.txt", "n");
		await fs.rm(path.join(dst, "added"), { recursive: true });
		await fs.symlink(outside, path.join(dst, "added"));
		const result = await restoreProjectUpdate(undo);
		expect(result.conflicts).toEqual(["added", "added/empty", "added/n.txt", "link"]);
		expect(await fs.readFile(path.join(outside, "n.txt"), "utf8")).toBe("n");
	});

	test("aborts before writing when a destination file changed since the plan", async () => {
		const { dst, staging, undo, plan } = await scenario();
		await fs.writeFile(path.join(dst, "edit.txt"), "edited after the preview");
		const before = await buildManifest(dst);
		const error = await applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan, undoDir: undo }).catch((e) => e);
		expect(error).toBeInstanceOf(ProjectSyncError);
		expect(error.code).toBe("destination-changed");
		expect(error.paths).toEqual(["edit.txt"]);
		expect((await buildManifest(dst)).entries).toEqual(before.entries);
		await expect(fs.lstat(path.join(undo, "undo.json"))).rejects.toThrow();
	});

	test("aborts when a path planned as an add now exists, a mode drifted, or a replaced directory gained content", async () => {
		const { dst, staging, undo, plan } = await scenario();
		await put(dst, "link", "appeared");
		await fs.chmod(path.join(dst, "exec.sh"), 0o600);
		await put(dst, "d2/new", "x");
		const error = await applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan, undoDir: undo }).catch((e) => e);
		expect(error.code).toBe("destination-changed");
		expect([...error.paths].sort()).toEqual(["d2", "exec.sh", "link"]);
		expect(await fs.readFile(path.join(dst, "edit.txt"), "utf8")).toBe("old content");
	});

	test("aborts when an ancestor directory of a planned path became a symlink", async () => {
		const dstRoot = path.join(base, "dst2");
		const srcRoot = path.join(base, "src2");
		const outside = path.join(base, "outside");
		await put(srcRoot, "sub/n.txt", "n");
		await put(dstRoot, "sub/keep", "k");
		await mkdir(outside, ".");
		const plan = diffManifests(await buildManifest(srcRoot), await buildManifest(dstRoot), "update");
		expect(plan.entries.map((e) => e.path)).toEqual(["sub/n.txt"]);
		const staging = await mkdirReturn(path.join(base, "staging2"));
		execFileSync("cp", ["-a", `${srcRoot}/.`, `${staging}/`]);
		await fs.rm(path.join(dstRoot, "sub"), { recursive: true });
		await fs.symlink(outside, path.join(dstRoot, "sub"));
		const error = await applyProjectUpdate({ stagingDir: staging, destRoot: dstRoot, plan, undoDir: path.join(base, "undo2") }).catch((e) => e);
		expect(error.code).toBe("destination-changed");
		expect(await fs.readdir(outside)).toEqual([]);
	});

	test("aborts when staged content does not match the plan", async () => {
		const { dst, staging, undo, plan } = await scenario();
		await fs.writeFile(path.join(staging, "edit.txt"), "tampered");
		const before = await buildManifest(dst);
		const error = await applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan, undoDir: undo }).catch((e) => e);
		expect(error.code).toBe("staging-mismatch");
		expect(error.paths).toEqual(["edit.txt"]);
		expect((await buildManifest(dst)).entries).toEqual(before.entries);
	});

	test("refuses a plan with conflicts, a tampered plan and an existing undo manifest", async () => {
		const { dst, staging, undo, plan } = await scenario();
		const conflicted: ProjectPlan = {
			...plan,
			conflicts: [{ path: "x", sourceKind: "file", destinationKind: "dir", reason: "r" }],
		};
		conflicted.digest = computePlanDigest(conflicted);
		expect(await codeOf(applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan: conflicted, undoDir: undo }))).toBe("conflicts");

		const tampered: ProjectPlan = { ...plan, totalBytes: plan.totalBytes + 1 };
		expect(await codeOf(applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan: tampered, undoDir: undo }))).toBe("invalid-plan");

		const create = diffManifests(manifest(file("a", "x")), undefined, "create");
		expect(await codeOf(applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan: create, undoDir: undo }))).toBe("invalid-plan");

		await mkdir(undo, ".");
		await fs.writeFile(path.join(undo, "undo.json"), "{}");
		expect(await codeOf(applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan, undoDir: undo }))).toBe("undo-exists");
	});

	test("rejects hostile plans with traversal or absolute entry paths without writing", async () => {
		const dstRoot = path.join(base, "dst3");
		await mkdir(dstRoot, ".");
		const staging = await mkdirReturn(path.join(base, "staging3"));
		await put(staging, "x", "x");
		const escape = path.join(base, "escaped");
		for (const bad of ["../escaped", `${escape}`, "a/../../escaped", "a//b"]) {
			const entry: PlanEntry = {
				path: bad,
				action: "add",
				kind: "file",
				bytes: 1,
				mode: 0o644,
				sha256: sha("x"),
				destination: { kind: "absent" },
			};
			const hostile: ProjectPlan = {
				mode: "update",
				entries: [entry],
				unchanged: 0,
				destinationOnly: 0,
				conflicts: [],
				totalBytes: 1,
				warnings: [],
				digest: "",
			};
			hostile.digest = computePlanDigest(hostile);
			expect(await codeOf(applyProjectUpdate({ stagingDir: staging, destRoot: dstRoot, plan: hostile, undoDir: path.join(base, "undo3") }))).toBe("invalid-plan");
		}
		await expect(fs.lstat(escape)).rejects.toThrow();
		expect(await fs.readdir(dstRoot)).toEqual([]);
	});

	test("rejects plans that nest entries under a non-directory or a replaced symlink", async () => {
		const dstRoot = path.join(base, "dst4");
		await mkdir(dstRoot, ".");
		const staging = await mkdirReturn(path.join(base, "staging4"));
		const seal = (entries: PlanEntry[]): ProjectPlan => {
			const plan: ProjectPlan = { mode: "update", entries, unchanged: 0, destinationOnly: 0, conflicts: [], totalBytes: 0, warnings: [], digest: "" };
			plan.digest = computePlanDigest(plan);
			return plan;
		};
		const absent = { kind: "absent" } as const;
		const fileEntry = (p: string): PlanEntry => ({ path: p, action: "add", kind: "file", bytes: 1, mode: 0o644, sha256: sha("x"), destination: absent });
		const asFile: PlanEntry = { path: "f", action: "add", kind: "symlink", bytes: 0, target: "t", destination: absent };
		expect(await codeOf(applyProjectUpdate({ stagingDir: staging, destRoot: dstRoot, plan: seal([asFile, fileEntry("f/x")]), undoDir: path.join(base, "u4") }))).toBe("invalid-plan");
		const overSymlink: PlanEntry = { path: "l", action: "replace", kind: "dir", bytes: 0, mode: 0o755, destination: { kind: "symlink", target: "/etc" } };
		expect(await codeOf(applyProjectUpdate({ stagingDir: staging, destRoot: dstRoot, plan: seal([overSymlink, fileEntry("l/x")]), undoDir: path.join(base, "u5") }))).toBe("invalid-plan");
	});

	test("restore rejects a missing, corrupt or hostile undo manifest", async () => {
		const undo = path.join(base, "undo");
		await mkdir(undo, ".");
		expect(await codeOf(restoreProjectUpdate(undo))).toBe("undo-missing");
		await fs.writeFile(path.join(undo, "undo.json"), "not json");
		expect(await codeOf(restoreProjectUpdate(undo))).toBe("invalid-undo");
		const hostile = {
			version: 1,
			planDigest: "x",
			destRoot: base,
			createdAt: "now",
			status: "applied",
			entries: [{ path: "../escape", prior: { kind: "absent" }, result: { kind: "dir", mode: 0o755 } }],
		};
		await fs.writeFile(path.join(undo, "undo.json"), JSON.stringify(hostile));
		expect(await codeOf(restoreProjectUpdate(undo))).toBe("invalid-undo");
		hostile.entries = [{ path: "ok", prior: { kind: "file", mode: 0o644, sha256: sha("x"), backup: "../../etc" } as never, result: { kind: "dir", mode: 0o755 } }];
		await fs.writeFile(path.join(undo, "undo.json"), JSON.stringify(hostile));
		expect(await codeOf(restoreProjectUpdate(undo))).toBe("invalid-undo");
	});

	test("restore after a failed apply undoes the partial work", async () => {
		if (os.userInfo().uid === 0) return;
		const { dst, staging, undo, plan, destManifest } = await scenario();
		// A read-only directory makes the depth-2 write into it fail after depth-1 entries were applied.
		await fs.chmod(path.join(dst, "keepdir"), 0o555);
		const error = await applyProjectUpdate({ stagingDir: staging, destRoot: dst, plan, undoDir: undo }).catch((e) => e);
		await fs.chmod(path.join(dst, "keepdir"), 0o755);
		expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
		expect(await fs.readFile(path.join(dst, "edit.txt"), "utf8")).toBe("new content");
		expect(await fs.readFile(path.join(dst, "added/n.txt"), "utf8")).toBe("n");
		await expect(fs.lstat(path.join(dst, "keepdir/new.txt"))).rejects.toThrow();
		const record = JSON.parse(await fs.readFile(path.join(undo, "undo.json"), "utf8"));
		expect(record.status).toBe("failed");
		const result = await restoreProjectUpdate(undo);
		expect(result.conflicts).toEqual([]);
		expect((await buildManifest(dst)).entries).toEqual(destManifest.entries);
	});
});

describe("publishNewProject", () => {
	test("moves the staged tree into place and creates missing parents", async () => {
		const staging = path.join(base, "staging");
		await put(staging, "a/b.txt", "b");
		await put(staging, ".hidden", "h");
		const destRoot = path.join(base, "deep", "er", "project");
		await publishNewProject(staging, destRoot);
		expect(await fs.readFile(path.join(destRoot, "a/b.txt"), "utf8")).toBe("b");
		expect(await fs.readFile(path.join(destRoot, ".hidden"), "utf8")).toBe("h");
		await expect(fs.lstat(staging)).rejects.toThrow();
	});

	test("fails and leaves both trees untouched when the destination exists", async () => {
		const staging = path.join(base, "staging");
		const destRoot = path.join(base, "project");
		await put(staging, "new.txt", "n");
		await put(destRoot, "old.txt", "o");
		expect(await codeOf(publishNewProject(staging, destRoot))).toBe("destination-exists");
		expect(await fs.readFile(path.join(destRoot, "old.txt"), "utf8")).toBe("o");
		expect(await fs.readFile(path.join(staging, "new.txt"), "utf8")).toBe("n");
		await mkdir(base, "emptydest");
		expect(await codeOf(publishNewProject(staging, path.join(base, "emptydest")))).toBe("destination-exists");
	});

	test("refuses a staging path that is not a directory", async () => {
		await put(base, "file", "x");
		expect(await codeOf(publishNewProject(path.join(base, "file"), path.join(base, "dest")))).toBe("invalid-root");
		await expect(fs.lstat(path.join(base, "dest"))).rejects.toThrow();
	});
});
