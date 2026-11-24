import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HostFolders } from "../../src/host-folders.js";

let root: string;
const service = new HostFolders(async () => [{ instanceId: "one", pid: 1, access: "control" }]);

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "host-folders-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("lists directories including directory symlinks and resolves home", async () => {
	await mkdir(join(root, "dir"));
	await writeFile(join(root, "file"), "");
	await symlink(join(root, "dir"), join(root, "link"));
	await symlink(join(root, "missing"), join(root, "broken"));
	expect(await service.list({ path: root })).toEqual({ path: await realpath(root), entries: ["dir", "link"] });
	expect((await service.list({ path: "" })).path).toBe(await realpath(homedir()));
	expect((await service.list({ path: "~" })).path).toBe(await realpath(homedir()));
});

test("creates a folder and reports invalid, missing and existing paths", async () => {
	const path = join(root, "new");
	expect(await service.mkdir({ path })).toEqual({ ok: true });
	expect((await service.list({ path: root })).entries).toContain("new");
	await expect(service.mkdir({ path })).rejects.toMatchObject({ code: -32002 });
	await expect(service.list({ path: join(root, "missing") })).rejects.toMatchObject({ code: -32001 });
	await expect(service.list({ path: "relative" })).rejects.toMatchObject({ code: -32004 });
	await expect(service.mkdir({ path: "" })).rejects.toMatchObject({ code: -32004 });
});

test("requires a control share for both operations", async () => {
	const view = new HostFolders(async () => [{ instanceId: "one", pid: 1, access: "view" }]);
	await expect(view.list({ path: root })).rejects.toMatchObject({ code: -32003 });
	await expect(view.mkdir({ path: join(root, "new") })).rejects.toMatchObject({ code: -32003 });
});
