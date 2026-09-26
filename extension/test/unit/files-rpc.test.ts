import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileService, MAX_CHUNK_BYTES, normalizeRelPath } from "../../src/files-rpc.js";
import { RpcCode } from "../../src/protocol.js";

let base: string;
let root: string;
let outside: string;
let service: FileService;

beforeEach(async () => {
	base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-files-rpc-")));
	root = path.join(base, "root");
	outside = path.join(base, "outside");
	await fs.mkdir(root);
	await fs.mkdir(outside);
	await fs.writeFile(path.join(outside, "secret.txt"), "secret");
	service = await FileService.open(root);
});

afterEach(async () => {
	await service.dispose();
	await fs.rm(base, { recursive: true, force: true });
});

async function rpcCode(promise: Promise<unknown> | (() => unknown)): Promise<number | undefined> {
	try {
		await (typeof promise === "function" ? promise() : promise);
	} catch (error) {
		return (error as { code?: number }).code;
	}
	return undefined;
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

function chunk(p: string, uploadId: string, offset: number, text: string, final: boolean, overwrite = false) {
	return service.write({ path: p, uploadId, offset, data: b64(text), final, overwrite });
}

test("normalizeRelPath maps the root spellings to '' and folds inner dot segments", () => {
	expect(normalizeRelPath("")).toBe("");
	expect(normalizeRelPath(".")).toBe("");
	expect(normalizeRelPath("./a/../b/c")).toBe("b/c");
});

test("normalizeRelPath rejects absolute paths, NUL bytes, trailing slashes and non-strings as invalid", async () => {
	for (const bad of ["/etc/passwd", "a\0b", "a/", 42, undefined]) {
		expect(await rpcCode(() => normalizeRelPath(bad))).toBe(RpcCode.Invalid);
	}
});

test("normalizeRelPath refuses paths that climb above the root", async () => {
	for (const bad of ["..", "../outside", "a/../../outside"]) {
		expect(await rpcCode(() => normalizeRelPath(bad))).toBe(RpcCode.Forbidden);
	}
});

test("a symlink pointing outside the root cannot be listed, read, written through or created under", async () => {
	await fs.symlink(outside, path.join(root, "escape"));
	await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "secret-link"));

	expect(await rpcCode(service.list({ path: "escape" }))).toBe(RpcCode.Forbidden);
	expect(await rpcCode(service.stat({ path: "secret-link" }))).toBe(RpcCode.Forbidden);
	expect(await rpcCode(service.read({ path: "escape/secret.txt", offset: 0, length: 10 }))).toBe(RpcCode.Forbidden);
	expect(await rpcCode(service.read({ path: "secret-link", offset: 0, length: 10 }))).toBe(RpcCode.Forbidden);
	expect(await rpcCode(chunk("escape/new.txt", "upload-01", 0, "x", true))).toBe(RpcCode.Forbidden);
	expect(await rpcCode(service.mkdir({ path: "escape/newdir" }))).toBe(RpcCode.Forbidden);
	expect(await fs.readdir(outside)).toEqual(["secret.txt"]);

	// Listed, but without a target, because the target is outside the root.
	const listing = await service.list({ path: "" });
	expect(listing.entries.find((e) => e.name === "escape")).toMatchObject({ type: "symlink" });
	expect(listing.entries.find((e) => e.name === "escape")?.target).toBeUndefined();
});

test("a root reached through a symlinked cwd confines to the resolved directory", async () => {
	const linkedRoot = path.join(base, "linked-root");
	await fs.symlink(root, linkedRoot);
	const linked = await FileService.open(linkedRoot);
	expect(linked.root).toBe(root);
	await fs.writeFile(path.join(root, "a.txt"), "hello");
	expect((await linked.stat({ path: "a.txt" })).size).toBe(5);
});

test("list sorts directories and symlinks to directories first, then by name, and reports types", async () => {
	await fs.mkdir(path.join(root, "zeta"));
	await fs.mkdir(path.join(root, "Alpha"));
	await fs.writeFile(path.join(root, "b.txt"), "bb");
	await fs.writeFile(path.join(root, "a.txt"), "a");
	await fs.symlink("zeta", path.join(root, "m-dirlink"));
	await fs.symlink("a.txt", path.join(root, "c-filelink"));
	await fs.symlink("missing", path.join(root, "dangling"));

	const listing = await service.list({ path: "." });
	expect(listing.path).toBe("");
	expect(listing.entries.map((e) => [e.name, e.type, e.target])).toEqual([
		["Alpha", "dir", undefined],
		["m-dirlink", "symlink", "dir"],
		["zeta", "dir", undefined],
		["a.txt", "file", undefined],
		["b.txt", "file", undefined],
		["c-filelink", "symlink", "file"],
		["dangling", "symlink", undefined],
	]);
	expect(listing.entries.find((e) => e.name === "b.txt")?.size).toBe(2);
	// A symlink to a file inside the root reports the file's size.
	expect(listing.entries.find((e) => e.name === "c-filelink")?.size).toBe(1);
});

test("list of a missing path is not_found and of a file is invalid", async () => {
	await fs.writeFile(path.join(root, "f.txt"), "x");
	expect(await rpcCode(service.list({ path: "nope" }))).toBe(RpcCode.NotFound);
	expect(await rpcCode(service.list({ path: "f.txt" }))).toBe(RpcCode.Invalid);
});

test("stat on an in-root symlink keeps type symlink but reports the target's size and mtime", async () => {
	await fs.writeFile(path.join(root, "data.bin"), "0123456789");
	await fs.symlink("data.bin", path.join(root, "link.bin"));
	const target = await fs.stat(path.join(root, "data.bin"));

	const stat = await service.stat({ path: "link.bin" });
	expect(stat).toEqual({ path: "link.bin", type: "symlink", size: 10, mtimeMs: target.mtimeMs });
	const read = await service.read({ path: "link.bin", offset: 0, length: 100, expect: stat });
	expect(Buffer.from(read.data, "base64").toString()).toBe("0123456789");
});

test("ranged reads return consecutive slices and flag eof on the last one", async () => {
	await fs.writeFile(path.join(root, "data.txt"), "abcdefghij");
	const stat = await service.stat({ path: "data.txt" });
	const first = await service.read({ path: "data.txt", offset: 0, length: 4, expect: stat });
	const second = await service.read({ path: "data.txt", offset: 4, length: 4, expect: stat });
	const last = await service.read({ path: "data.txt", offset: 8, length: 4, expect: stat });
	const text = [first, second, last].map((r) => Buffer.from(r.data, "base64").toString());
	expect(text).toEqual(["abcd", "efgh", "ij"]);
	expect([first.eof, second.eof, last.eof]).toEqual([false, false, true]);
	expect(last.size).toBe(10);

	const atEnd = await service.read({ path: "data.txt", offset: 10, length: 4 });
	expect(atEnd).toMatchObject({ data: "", eof: true });
});

test("a read whose expected size or mtime no longer matches is 'changed'", async () => {
	const file = path.join(root, "data.txt");
	await fs.writeFile(file, "abcdefghij");
	const stat = await service.stat({ path: "data.txt" });
	await fs.appendFile(file, "more");
	expect(await rpcCode(service.read({ path: "data.txt", offset: 4, length: 4, expect: stat }))).toBe(RpcCode.Changed);

	const fresh = await service.stat({ path: "data.txt" });
	await fs.utimes(file, new Date(), new Date(Date.now() + 60_000));
	expect(await rpcCode(service.read({ path: "data.txt", offset: 0, length: 4, expect: fresh }))).toBe(RpcCode.Changed);
});

test("read rejects bad ranges, directories and oversized lengths as invalid", async () => {
	await fs.writeFile(path.join(root, "data.txt"), "abc");
	await fs.mkdir(path.join(root, "dir"));
	expect(await rpcCode(service.read({ path: "data.txt", offset: 4, length: 1 }))).toBe(RpcCode.Invalid);
	expect(await rpcCode(service.read({ path: "data.txt", offset: -1, length: 1 }))).toBe(RpcCode.Invalid);
	expect(await rpcCode(service.read({ path: "data.txt", offset: 0, length: MAX_CHUNK_BYTES + 1 }))).toBe(
		RpcCode.Invalid,
	);
	expect(await rpcCode(service.read({ path: "dir", offset: 0, length: 1 }))).toBe(RpcCode.Invalid);
	expect(await rpcCode(service.read({ path: "missing", offset: 0, length: 1 }))).toBe(RpcCode.NotFound);
});

test("chunks accumulate in a temp file that is renamed onto the target only on the final chunk", async () => {
	expect(await chunk("up.txt", "upload-01", 0, "hello ", false)).toEqual({ ok: true, path: "up.txt", size: 6 });
	expect(await fs.readdir(root)).toEqual([".up.txt.omp-upload-upload-01"]);
	expect(await chunk("up.txt", "upload-01", 6, "world", true)).toEqual({ ok: true, path: "up.txt", size: 11 });
	expect(await fs.readdir(root)).toEqual(["up.txt"]);
	expect(await fs.readFile(path.join(root, "up.txt"), "utf8")).toBe("hello world");
	expect(service.activeUploads).toBe(0);
});

test("a chunk whose offset does not match the bytes received so far is invalid and leaves the temp intact", async () => {
	await chunk("up.txt", "upload-01", 0, "abc", false);
	expect(await rpcCode(chunk("up.txt", "upload-01", 5, "x", false))).toBe(RpcCode.Invalid);
	expect(await rpcCode(chunk("up.txt", "upload-01", 0 + 2, "x", false))).toBe(RpcCode.Invalid);
	await chunk("up.txt", "upload-01", 3, "def", true);
	expect(await fs.readFile(path.join(root, "up.txt"), "utf8")).toBe("abcdef");
});

test("a non-zero offset without a started upload is invalid", async () => {
	expect(await rpcCode(chunk("up.txt", "upload-01", 3, "abc", false))).toBe(RpcCode.Invalid);
});

test("an empty body uploads as a zero-byte file in one final chunk", async () => {
	expect(await chunk("empty.txt", "upload-01", 0, "", true)).toEqual({ ok: true, path: "empty.txt", size: 0 });
	expect((await fs.stat(path.join(root, "empty.txt"))).size).toBe(0);
});

test("an existing target is refused at offset 0 without overwrite, and replaced with it keeping its mode", async () => {
	const target = path.join(root, "t.sh");
	await fs.writeFile(target, "old");
	await fs.chmod(target, 0o750);
	expect(await rpcCode(chunk("t.sh", "upload-01", 0, "new", true))).toBe(RpcCode.Exists);
	expect(await fs.readFile(target, "utf8")).toBe("old");

	await chunk("t.sh", "upload-02", 0, "new", true, true);
	expect(await fs.readFile(target, "utf8")).toBe("new");
	expect((await fs.stat(target)).mode & 0o777).toBe(0o750);
});

test("a target created during the upload is refused before the final rename and the temp is removed", async () => {
	await chunk("race.txt", "upload-01", 0, "mine", false);
	await fs.writeFile(path.join(root, "race.txt"), "theirs");
	expect(await rpcCode(chunk("race.txt", "upload-01", 4, "!", true))).toBe(RpcCode.Exists);
	expect(await fs.readFile(path.join(root, "race.txt"), "utf8")).toBe("theirs");
	expect(await fs.readdir(root)).toEqual(["race.txt"]);
});

test("a target that is a directory or symlink is invalid even with overwrite", async () => {
	await fs.mkdir(path.join(root, "d"));
	await fs.writeFile(path.join(root, "real.txt"), "x");
	await fs.symlink("real.txt", path.join(root, "l.txt"));
	expect(await rpcCode(chunk("d", "upload-01", 0, "x", true, true))).toBe(RpcCode.Invalid);
	expect(await rpcCode(chunk("l.txt", "upload-02", 0, "x", true, true))).toBe(RpcCode.Invalid);
	expect(await fs.readFile(path.join(root, "real.txt"), "utf8")).toBe("x");
});

test("uploads need an existing parent, a valid uploadId, base64 data and a bounded chunk", async () => {
	expect(await rpcCode(chunk("no/such/dir.txt", "upload-01", 0, "x", true))).toBe(RpcCode.NotFound);
	expect(await rpcCode(chunk("f.txt", "short", 0, "x", true))).toBe(RpcCode.Invalid);
	expect(await rpcCode(chunk("f.txt", "bad/upload", 0, "x", true))).toBe(RpcCode.Invalid);
	expect(
		await rpcCode(service.write({ path: "f.txt", uploadId: "upload-01", offset: 0, data: "not base64!", final: true, overwrite: false })),
	).toBe(RpcCode.Invalid);
	const big = Buffer.alloc(MAX_CHUNK_BYTES + 1).toString("base64");
	expect(
		await rpcCode(service.write({ path: "f.txt", uploadId: "upload-01", offset: 0, data: big, final: true, overwrite: false })),
	).toBe(RpcCode.Invalid);
	expect(await fs.readdir(root)).toEqual([]);
});

test("write_abort deletes the temp file and is idempotent", async () => {
	await chunk("up.txt", "upload-01", 0, "partial", false);
	expect(await service.writeAbort({ path: "up.txt", uploadId: "upload-01" })).toEqual({ ok: true });
	expect(await fs.readdir(root)).toEqual([]);
	expect(await service.writeAbort({ path: "up.txt", uploadId: "upload-01" })).toEqual({ ok: true });
	expect(await service.writeAbort({ path: "missing/up.txt", uploadId: "upload-01" })).toEqual({ ok: true });
	expect(await rpcCode(chunk("up.txt", "upload-01", 7, "more", true))).toBe(RpcCode.Invalid);
});

test("write_abort during an in-flight chunk leaves no temp or target file behind", async () => {
	// Hold the chunk at the point where it creates its temp file.
	const opening = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const open = fs.open;
	const spy = spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
		opening.resolve();
		await release.promise;
		return open(...args);
	}) as typeof fs.open);
	try {
		const pending = rpcCode(chunk("up.txt", "upload-01", 0, "whole file", true));
		await opening.promise;
		expect(await service.writeAbort({ path: "up.txt", uploadId: "upload-01" })).toEqual({ ok: true });
		const late = await service.write({ path: "up.txt", uploadId: "upload-01", offset: 10, data: b64("x"), final: true, overwrite: false }).then(
			() => undefined,
			(error: Error & { code?: number }) => error,
		);
		expect(late?.code).toBe(RpcCode.Invalid);
		expect(late?.message).toContain("no upload in progress");
		release.resolve();
		expect(await pending).toBe(RpcCode.Invalid);
	} finally {
		release.resolve();
		spy.mockRestore();
	}
	expect(await fs.readdir(root)).toEqual([]);
	expect(service.activeUploads).toBe(0);
	expect(await rpcCode(chunk("up.txt", "upload-01", 10, "x", true))).toBe(RpcCode.Invalid);
	expect(await fs.readdir(root)).toEqual([]);
});

test("an upload idle past the timeout is discarded with its temp file", async () => {
	const idle = await FileService.open(root, { idleMs: 60_000 });
	jest.useFakeTimers();
	try {
		await idle.write({ path: "slow.txt", uploadId: "upload-01", offset: 0, data: b64("abc"), final: false, overwrite: false });
		jest.advanceTimersByTime(59_000);
		expect(idle.activeUploads).toBe(1);
		jest.advanceTimersByTime(2_000);
		expect(idle.activeUploads).toBe(0);
	} finally {
		jest.useRealTimers();
	}
	// The temp file is removed asynchronously after the timer fires.
	let names = await fs.readdir(root);
	for (let turn = 0; turn < 100 && names.length > 0; turn += 1) names = await fs.readdir(root);
	expect(names).toEqual([]);
	expect(
		await rpcCode(idle.write({ path: "slow.txt", uploadId: "upload-01", offset: 3, data: b64("d"), final: true, overwrite: false })),
	).toBe(RpcCode.Invalid);
});

test("dispose removes the temp files of unfinished uploads", async () => {
	await fs.mkdir(path.join(root, "sub"));
	await chunk("a.txt", "upload-01", 0, "a", false);
	await chunk("sub/b.txt", "upload-02", 0, "b", false);
	await service.dispose();
	expect(await fs.readdir(root)).toEqual(["sub"]);
	expect(await fs.readdir(path.join(root, "sub"))).toEqual([]);
});

test("mkdir creates one level, refuses an existing entry, and needs the parent", async () => {
	expect(await service.mkdir({ path: "new" })).toEqual({ ok: true });
	expect((await fs.stat(path.join(root, "new"))).isDirectory()).toBe(true);
	expect(await rpcCode(service.mkdir({ path: "new" }))).toBe(RpcCode.Exists);
	expect(await rpcCode(service.mkdir({ path: "a/b" }))).toBe(RpcCode.NotFound);
	expect(await rpcCode(service.mkdir({ path: "" }))).toBe(RpcCode.Invalid);
});
