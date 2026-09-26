// `files.*` requests pushed by omp-hub: browse, download and upload inside
// the session's root directory. Every path is POSIX and relative to the root;
// each one is resolved with realpath and refused when it lands outside the
// root, so neither `..` nor a symlink can reach the rest of the filesystem.

import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { paramsRecord, RpcCode, RpcError } from "./protocol.js";

/** Largest decoded chunk for `files.read` and `files.write`. */
export const MAX_CHUNK_BYTES = 262_144;
/** An upload that receives no chunk for this long is aborted. */
export const UPLOAD_IDLE_MS = 10 * 60_000;

const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type EntryType = "file" | "dir" | "symlink" | "other";

export interface FileEntry {
	name: string;
	type: EntryType;
	size: number;
	mtimeMs: number;
	/** What a symlink resolves to; present only when it resolves inside the root. */
	target?: "file" | "dir";
}

export interface FileServiceOptions {
	/** Idle time after which an unfinished upload is discarded. */
	idleMs?: number;
}

interface Upload {
	rel: string;
	temp: string;
	timer?: NodeJS.Timeout;
	busy: boolean;
	/** Set by an abort that arrived while a chunk was being written; that
	 *  write then removes the upload and its temp file when it settles. */
	aborted: boolean;
}

function invalid(message: string): RpcError {
	return new RpcError(RpcCode.Invalid, message);
}

function describe(rel: string): string {
	return rel === "" ? "the session root" : `'${rel}'`;
}

function errnoCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/** Maps a filesystem failure on `rel` onto the contract's error codes;
 *  anything unrecognised is returned unchanged and replied as internal. */
function fsError(error: unknown, rel: string): unknown {
	if (error instanceof RpcError) return error;
	switch (errnoCode(error)) {
		case "ENOENT":
			return new RpcError(RpcCode.NotFound, `${describe(rel)} does not exist`);
		case "EEXIST":
			return new RpcError(RpcCode.Exists, `${describe(rel)} already exists`);
		case "ENOTDIR":
			return invalid(`a parent of ${describe(rel)} is not a directory`);
		case "EISDIR":
			return invalid(`${describe(rel)} is a directory`);
		case "ENAMETOOLONG":
			return invalid(`${describe(rel)} has a name that is too long`);
		case "ELOOP":
			return invalid(`${describe(rel)} has too many levels of symbolic links`);
		case "EACCES":
		case "EPERM":
			return new RpcError(RpcCode.Forbidden, `permission denied for ${describe(rel)}`);
		default:
			return error;
	}
}

async function attempt<T>(rel: string, operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw fsError(error, rel);
	}
}

function typeOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryType {
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "dir";
	return "other";
}


function nonNegativeInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw invalid(`${name} must be a non-negative integer`);
	}
	return value;
}

function booleanParam(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw invalid(`${name} must be a boolean`);
	return value;
}

function uploadIdParam(value: unknown): string {
	if (typeof value !== "string" || !UPLOAD_ID_PATTERN.test(value)) {
		throw invalid("uploadId must be 8-64 characters of A-Z, a-z, 0-9, '_' or '-'");
	}
	return value;
}

/**
 * Validates a request path and returns it normalised: `""` for the root,
 * otherwise a relative POSIX path without `.` segments. Rejects non-strings,
 * NUL bytes, absolute paths, empty segments (e.g. a trailing slash) and
 * anything that climbs above the root lexically. Symlink escapes are caught
 * later, when the path is resolved.
 */
export function normalizeRelPath(value: unknown): string {
	if (typeof value !== "string") throw invalid("path must be a string");
	if (value.includes("\0")) throw invalid("path contains a NUL byte");
	if (value.startsWith("/")) throw invalid("path must be relative to the session root");
	const normalised = path.posix.normalize(value === "" ? "." : value);
	if (normalised === ".") return "";
	if (normalised === ".." || normalised.startsWith("../")) {
		throw new RpcError(RpcCode.Forbidden, "path is outside the session root");
	}
	if (normalised.split("/").some((segment) => segment === "" || segment === ".")) {
		throw invalid("path has an empty segment");
	}
	return normalised;
}

function tempName(name: string, uploadId: string): string {
	return `.${name}.omp-upload-${uploadId}`;
}

export class FileService {
	readonly root: string;
	readonly #prefix: string;
	readonly #idleMs: number;
	readonly #uploads = new Map<string, Upload>();

	private constructor(root: string, options: FileServiceOptions) {
		this.root = root;
		this.#prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
		this.#idleMs = options.idleMs ?? UPLOAD_IDLE_MS;
	}

	/** Opens a service rooted at the realpath of `dir`. */
	static async open(dir: string, options: FileServiceOptions = {}): Promise<FileService> {
		return new FileService(await fs.realpath(dir), options);
	}

	/** Uploads that have started but neither finished nor been aborted. */
	get activeUploads(): number {
		return this.#uploads.size;
	}

	#inside(real: string): boolean {
		return real === this.root || real.startsWith(this.#prefix);
	}

	/** Realpath of an existing `rel`, refused when it resolves outside the root. */
	async #resolveExisting(rel: string): Promise<string> {
		const real = await attempt(rel, () => fs.realpath(path.join(this.root, rel)));
		if (!this.#inside(real)) {
			throw new RpcError(RpcCode.Forbidden, `${describe(rel)} resolves outside the session root`);
		}
		return real;
	}

	/** For a path that need not exist yet: the realpath of its parent
	 *  directory (which must exist inside the root) and its final name. */
	async #resolveParent(rel: string): Promise<{ dir: string; name: string }> {
		if (rel === "") throw invalid("the session root is not a valid target");
		const parentRel = path.posix.dirname(rel);
		const parent = parentRel === "." ? "" : parentRel;
		let dir: string;
		try {
			dir = await this.#resolveExisting(parent);
		} catch (error) {
			if (error instanceof RpcError && error.code === RpcCode.NotFound) {
				throw new RpcError(RpcCode.NotFound, `the parent directory of ${describe(rel)} does not exist`);
			}
			throw error;
		}
		const stats = await attempt(parent, () => fs.stat(dir));
		if (!stats.isDirectory()) throw invalid(`the parent of ${describe(rel)} is not a directory`);
		return { dir, name: path.posix.basename(rel) };
	}

	async list(params: unknown): Promise<{ path: string; entries: FileEntry[] }> {
		const rel = normalizeRelPath(paramsRecord(params).path);
		const real = await this.#resolveExisting(rel);
		const stats = await attempt(rel, () => fs.stat(real));
		if (!stats.isDirectory()) throw invalid(`${describe(rel)} is not a directory`);
		const names = await attempt(rel, () => fs.readdir(real));
		const entries = (await Promise.all(names.map((name) => this.#entry(real, name)))).filter(
			(entry): entry is FileEntry => entry !== undefined,
		);
		entries.sort((a, b) => {
			const aDir = a.type === "dir" || a.target === "dir";
			const bDir = b.type === "dir" || b.target === "dir";
			if (aDir !== bDir) return aDir ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return { path: rel, entries };
	}

	/** One listing row; undefined when the entry vanished while listing. */
	async #entry(dir: string, name: string): Promise<FileEntry | undefined> {
		const full = path.join(dir, name);
		let stats: Stats;
		try {
			stats = await fs.lstat(full);
		} catch {
			return undefined;
		}
		const entry: FileEntry = { name, type: typeOf(stats), size: stats.size, mtimeMs: stats.mtimeMs };
		if (entry.type !== "symlink") return entry;
		try {
			const real = await fs.realpath(full);
			if (!this.#inside(real)) return entry;
			const target = await fs.stat(real);
			const targetType = typeOf(target);
			if (targetType !== "file" && targetType !== "dir") return entry;
			return { ...entry, size: target.size, mtimeMs: target.mtimeMs, target: targetType };
		} catch {
			return entry;
		}
	}

	/** `type` describes `path` itself (so a symlink reports "symlink");
	 *  `size` and `mtimeMs` come from what it resolves to, which is what
	 *  `files.read` compares its `expect` against. */
	async stat(params: unknown): Promise<{ path: string; type: EntryType; size: number; mtimeMs: number }> {
		const rel = normalizeRelPath(paramsRecord(params).path);
		const real = await this.#resolveExisting(rel);
		const own = await attempt(rel, () => fs.lstat(path.join(this.root, rel)));
		const resolved = await attempt(rel, () => fs.stat(real));
		return { path: rel, type: typeOf(own), size: resolved.size, mtimeMs: resolved.mtimeMs };
	}

	async read(params: unknown): Promise<{ data: string; size: number; mtimeMs: number; eof: boolean }> {
		const p = paramsRecord(params);
		const rel = normalizeRelPath(p.path);
		const offset = nonNegativeInteger(p.offset, "offset");
		const length = nonNegativeInteger(p.length, "length");
		if (length > MAX_CHUNK_BYTES) throw invalid(`length must be at most ${MAX_CHUNK_BYTES}`);
		let expect: { size: number; mtimeMs: number } | undefined;
		if (p.expect !== undefined) {
			const e = p.expect as Record<string, unknown> | null;
			if (
				typeof e !== "object" ||
				e === null ||
				typeof e.size !== "number" ||
				typeof e.mtimeMs !== "number" ||
				!Number.isFinite(e.size) ||
				!Number.isFinite(e.mtimeMs)
			) {
				throw invalid("expect must be { size: number, mtimeMs: number }");
			}
			expect = { size: e.size, mtimeMs: e.mtimeMs };
		}

		const real = await this.#resolveExisting(rel);
		// O_NONBLOCK: opening a FIFO must not hang the request; it is refused
		// by the regular-file check below instead.
		const handle = await attempt(rel, () => fs.open(real, constants.O_RDONLY | constants.O_NONBLOCK));
		try {
			const before = await attempt(rel, () => handle.stat());
			if (!before.isFile()) throw invalid(`${describe(rel)} is not a regular file`);
			const changed = (stats: { size: number; mtimeMs: number }) =>
				expect !== undefined && (stats.size !== expect.size || stats.mtimeMs !== expect.mtimeMs);
			if (changed(before)) throw new RpcError(RpcCode.Changed, `${describe(rel)} changed during the download`);
			if (offset > before.size) throw invalid(`offset ${offset} is past the end of ${describe(rel)}`);
			const buffer = Buffer.alloc(Math.min(length, before.size - offset));
			const { bytesRead } = await attempt(rel, () => handle.read(buffer, 0, buffer.length, offset));
			if (expect !== undefined && changed(await attempt(rel, () => handle.stat()))) {
				throw new RpcError(RpcCode.Changed, `${describe(rel)} changed during the download`);
			}
			return {
				data: buffer.subarray(0, bytesRead).toString("base64"),
				size: before.size,
				mtimeMs: before.mtimeMs,
				eof: offset + bytesRead >= before.size,
			};
		} finally {
			await handle.close();
		}
	}

	/** Refuses a target that exists but is not a regular file, or that exists
	 *  when `overwrite` is off. Returns the existing file's mode, if any. */
	async #checkTarget(target: string, rel: string, overwrite: boolean): Promise<number | undefined> {
		let stats: Stats;
		try {
			stats = await fs.lstat(target);
		} catch (error) {
			if (errnoCode(error) === "ENOENT") return undefined;
			throw fsError(error, rel);
		}
		if (!stats.isFile()) throw invalid(`${describe(rel)} exists and is not a regular file`);
		if (!overwrite) throw new RpcError(RpcCode.Exists, `${describe(rel)} already exists`);
		return stats.mode & 0o7777;
	}

	async write(params: unknown): Promise<{ ok: true; path: string; size: number }> {
		const p = paramsRecord(params);
		const rel = normalizeRelPath(p.path);
		const uploadId = uploadIdParam(p.uploadId);
		const offset = nonNegativeInteger(p.offset, "offset");
		if (typeof p.data !== "string" || !BASE64_PATTERN.test(p.data)) throw invalid("data must be base64");
		const final = booleanParam(p.final, "final");
		const overwrite = booleanParam(p.overwrite, "overwrite");
		const bytes = Buffer.from(p.data, "base64");
		if (bytes.length > MAX_CHUNK_BYTES) throw invalid(`a chunk must be at most ${MAX_CHUNK_BYTES} bytes`);

		const { dir, name } = await this.#resolveParent(rel);
		const target = path.join(dir, name);
		const temp = path.join(dir, tempName(name, uploadId));

		// No await from here until `busy` is set: an abort or a second chunk
		// sees either no upload yet or one that is marked busy.
		let upload = this.#uploads.get(uploadId);
		if (upload && upload.rel !== rel) throw invalid("uploadId is in use for a different path");
		if ((!upload || upload.aborted) && offset !== 0) {
			throw invalid("no upload in progress for this uploadId; start again at offset 0");
		}
		if (upload?.busy) throw new RpcError(RpcCode.Busy, "a chunk for this upload is still being written");
		if (upload && upload.temp !== temp) throw invalid("the upload's directory moved; start again at offset 0");

		if (!upload) {
			upload = { rel, temp, busy: false, aborted: false };
			this.#uploads.set(uploadId, upload);
		}
		const active = upload;
		clearTimeout(active.timer);
		active.busy = true;
		try {
			let handle: fs.FileHandle;
			if (offset === 0) {
				await this.#checkTarget(target, rel, overwrite);
				await fs.rm(temp, { force: true });
				// O_EXCL: never follow or reuse something planted at the temp name.
				handle = await attempt(rel, () =>
					fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666),
				);
			} else {
				handle = await attempt(rel, () => fs.open(temp, constants.O_WRONLY | constants.O_NOFOLLOW));
			}
			try {
				const current = (await handle.stat()).size;
				if (current !== offset) throw invalid(`offset ${offset} does not match the ${current} bytes received`);
				let written = 0;
				while (written < bytes.length) {
					const result = await handle.write(bytes, written, bytes.length - written, offset + written);
					written += result.bytesWritten;
				}
				if (final) await handle.sync();
			} finally {
				await handle.close();
			}
			if (active.aborted) throw invalid("the upload was aborted");
			const size = offset + bytes.length;
			if (!final) {
				this.#armIdleTimer(uploadId, active);
				return { ok: true, path: rel, size };
			}

			let mode: number | undefined;
			try {
				mode = await this.#checkTarget(target, rel, overwrite);
			} catch (error) {
				await this.#drop(uploadId, active);
				throw error;
			}
			if (mode !== undefined) await attempt(rel, () => fs.chmod(temp, mode));
			if (active.aborted) throw invalid("the upload was aborted");
			await attempt(rel, () => fs.rename(temp, target));
			this.#uploads.delete(uploadId);
			return { ok: true, path: rel, size };
		} catch (error) {
			// A refused first chunk leaves nothing worth resuming, nor does an
			// aborted upload; a later chunk stays resumable (or abortable) until
			// the idle timeout.
			if (offset === 0 || active.aborted) await this.#drop(uploadId, active);
			else if (this.#uploads.get(uploadId) === active) this.#armIdleTimer(uploadId, active);
			throw fsError(error, rel);
		} finally {
			active.busy = false;
		}
	}

	#armIdleTimer(uploadId: string, upload: Upload): void {
		clearTimeout(upload.timer);
		upload.timer = setTimeout(() => void this.#discard(uploadId), this.#idleMs);
		upload.timer.unref?.();
	}

	/** Drops an upload and its temp file, or, while one of its chunks is being
	 *  written, marks it aborted so that write drops it once it settles. */
	async #discard(uploadId: string): Promise<void> {
		const upload = this.#uploads.get(uploadId);
		if (!upload) return;
		if (upload.busy) {
			clearTimeout(upload.timer);
			upload.aborted = true;
			return;
		}
		await this.#drop(uploadId, upload);
	}

	async #drop(uploadId: string, upload: Upload): Promise<void> {
		clearTimeout(upload.timer);
		if (this.#uploads.get(uploadId) === upload) this.#uploads.delete(uploadId);
		await fs.rm(upload.temp, { force: true });
	}

	async writeAbort(params: unknown): Promise<{ ok: true }> {
		const p = paramsRecord(params);
		const rel = normalizeRelPath(p.path);
		const uploadId = uploadIdParam(p.uploadId);
		const upload = this.#uploads.get(uploadId);
		if (upload && upload.rel === rel) {
			await this.#discard(uploadId);
			return { ok: true };
		}
		let resolved: { dir: string; name: string };
		try {
			resolved = await this.#resolveParent(rel);
		} catch (error) {
			if (error instanceof RpcError && error.code === RpcCode.NotFound) return { ok: true };
			throw error;
		}
		await attempt(rel, () => fs.rm(path.join(resolved.dir, tempName(resolved.name, uploadId)), { force: true }));
		return { ok: true };
	}

	async mkdir(params: unknown): Promise<{ ok: true }> {
		const rel = normalizeRelPath(paramsRecord(params).path);
		const { dir, name } = await this.#resolveParent(rel);
		await attempt(rel, () => fs.mkdir(path.join(dir, name)));
		return { ok: true };
	}

	/** Discards every unfinished upload and its temp file. */
	async dispose(): Promise<void> {
		await Promise.allSettled([...this.#uploads.keys()].map((uploadId) => this.#discard(uploadId)));
	}
}
