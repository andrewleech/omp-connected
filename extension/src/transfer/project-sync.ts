// Project tree synchronisation for send-to-host: manifest, diff, destination
// path policy, apply with undo, and undo. All relative paths are POSIX and
// never leave their root. Symlinks are recorded and never followed; special
// files are skipped; setuid, setgid and sticky bits are never recorded or
// recreated. File contents are only ever streamed through a hash or a copy.

import { createHash, randomBytes } from "node:crypto";
import { constants as fsc, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ManifestEntry {
	/** POSIX path relative to the tree root. */
	path: string;
	kind: "file" | "dir" | "symlink";
	/** Permission bits only (`mode & 0o777`). */
	mode: number;
	size?: number;
	sha256?: string;
	target?: string;
}

export type ProjectWarning = {
	kind:
		| "external-symlink"
		| "absolute-symlink"
		| "external-gitdir"
		| "submodule"
		| "possible-secret-file"
		| "special-file-skipped";
	path: string;
	detail?: string;
};

export interface TreeManifest {
	root: string;
	/** Sorted by path (UTF-16 code unit order). */
	entries: ManifestEntry[];
	/** Sorted by path, then kind. */
	warnings: ProjectWarning[];
}

/**
 * Exclusions applied to every manifest, in addition to the caller's list.
 * Hidden files, `.git`, dependency directories and untracked work are copied;
 * `.gitignore` is never consulted. Pattern syntax: `*` (within a segment),
 * `**` (any depth), `?`; a pattern without `/` matches a basename at any
 * depth, a leading `/` anchors at the root, a trailing `/` matches directories
 * only. An excluded directory excludes everything beneath it.
 */
export const DEFAULT_EXCLUDES: string[] = [".DS_Store", "Thumbs.db"];

export type EntryState =
	| { kind: "absent" }
	| { kind: "file"; mode: number; sha256: string }
	| { kind: "dir"; mode: number }
	| { kind: "symlink"; target: string };

export interface PlanEntry {
	path: string;
	action: "add" | "replace" | "mode-change";
	kind: ManifestEntry["kind"];
	bytes: number;
	/** Source mode (file and dir). */
	mode?: number;
	/** Source content hash (file). */
	sha256?: string;
	/** Source link target (symlink). */
	target?: string;
	/** Destination state the plan was computed against; `applyProjectUpdate` re-verifies it. */
	destination?: EntryState;
}

export interface PlanConflict {
	path: string;
	sourceKind: ManifestEntry["kind"];
	destinationKind: ManifestEntry["kind"];
	reason: string;
}

export interface ProjectPlan {
	mode: "create" | "session-only" | "update";
	entries: PlanEntry[];
	unchanged: number;
	destinationOnly: number;
	conflicts: PlanConflict[];
	totalBytes: number;
	warnings: ProjectWarning[];
	/** Hex SHA-256 over the canonical JSON of every other plan field. */
	digest: string;
}

export interface UndoEntry {
	path: string;
	/** State before the operation; `backup` names the saved copy of a replaced file. */
	prior: EntryState & { backup?: string };
	/** State the operation writes. */
	result: EntryState;
}

export interface UndoManifest {
	version: 1;
	planDigest: string;
	/** Canonical destination root. */
	destRoot: string;
	createdAt: string;
	status: "applying" | "applied" | "failed" | "restored";
	error?: string;
	/** In application order; entries whose prior state is `absent` were created by the operation. */
	entries: UndoEntry[];
}

export type ProjectSyncErrorCode =
	| "invalid-manifest"
	| "invalid-plan"
	| "invalid-exclude"
	| "invalid-root"
	| "path-policy"
	| "project-outside-home"
	| "conflicts"
	| "destination-changed"
	| "staging-mismatch"
	| "destination-exists"
	| "undo-exists"
	| "undo-missing"
	| "invalid-undo";

export class ProjectSyncError extends Error {
	constructor(
		readonly code: ProjectSyncErrorCode,
		message: string,
		/** Relative paths the failure concerns, when known. */
		readonly paths: string[] = [],
	) {
		super(message);
		this.name = "ProjectSyncError";
	}
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const READ_FLAGS = fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK;
const MAX_CHUNK = 1 << 20;
const UNDO_FILE = "undo.json";
const BACKUP_DIR = "backup";
const GITFILE_LIMIT = 4096;
const GITMODULES_LIMIT = 65_536;

function errCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
	return undefined;
}

function isMissing(error: unknown): boolean {
	const code = errCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

function byPath(a: { path: string }, b: { path: string }): number {
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function isWithin(child: string, parent: string): boolean {
	if (child === parent) return false;
	return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

// ---------------------------------------------------------------- hashing

interface FileFacts {
	sha256: string;
	size: number;
	mode: number;
}

async function hashFile(file: string): Promise<FileFacts> {
	const handle = await fs.open(file, READ_FLAGS);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new ProjectSyncError("invalid-root", `not a regular file: ${file}`);
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(Math.min(MAX_CHUNK, Math.max(stat.size, 4096)));
		let size = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			size += bytesRead;
		}
		return { sha256: hash.digest("hex"), size, mode: stat.mode & 0o777 };
	} finally {
		await handle.close();
	}
}

/** Streams a regular file through SHA-256; refuses symlinks and non-regular files. */
export async function sha256File(file: string): Promise<string> {
	return (await hashFile(file)).sha256;
}

/**
 * Copies a regular file to a new path (created exclusively, owner-only until
 * `mode` is applied), hashing while it streams. A hash different from
 * `expected` removes the copy and throws.
 */
async function copyVerified(src: string, dst: string, expected: string, mode: number): Promise<void> {
	const input = await fs.open(src, READ_FLAGS);
	let output: fs.FileHandle | undefined;
	let created = false;
	try {
		const stat = await input.stat();
		if (!stat.isFile()) throw new ProjectSyncError("staging-mismatch", `not a regular file: ${src}`);
		output = await fs.open(dst, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
		created = true;
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(Math.min(MAX_CHUNK, Math.max(stat.size, 4096)));
		for (;;) {
			const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			let written = 0;
			while (written < bytesRead) {
				const { bytesWritten } = await output.write(buffer, written, bytesRead - written);
				written += bytesWritten;
			}
		}
		if (hash.digest("hex") !== expected) {
			throw new ProjectSyncError("staging-mismatch", `content hash mismatch while copying ${src}`);
		}
		await output.chmod(mode & 0o777);
		await output.sync();
	} catch (error) {
		await output?.close().catch(() => {});
		output = undefined;
		if (created) await fs.rm(dst, { force: true }).catch(() => {});
		throw error;
	} finally {
		await input.close();
		await output?.close();
	}
}

async function chmodNoFollow(target: string, mode: number): Promise<void> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(target, READ_FLAGS);
	} catch (error) {
		if (errCode(error) !== "EACCES") throw error;
		const stat = await fs.lstat(target);
		if (stat.isSymbolicLink()) throw new ProjectSyncError("destination-changed", `symlink at ${target}`);
		await fs.chmod(target, mode);
		return;
	}
	try {
		await handle.chmod(mode);
	} finally {
		await handle.close();
	}
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
	const handle = await fs.open(tmp, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.rename(tmp, file);
	} catch (error) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

function tmpSibling(target: string): string {
	return path.join(path.dirname(target), `.ompc-tmp-${randomBytes(6).toString("hex")}`);
}

// ------------------------------------------------------------- validation

function assertRelPath(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value === "" || value.includes("\0")) {
		throw new ProjectSyncError("invalid-manifest", `${label}: invalid path ${JSON.stringify(value)}`);
	}
	for (const segment of value.split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new ProjectSyncError("invalid-manifest", `${label}: unsafe path ${JSON.stringify(value)}`);
		}
	}
}

function assertMode(value: unknown, label: string): asserts value is number {
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
		throw new ProjectSyncError("invalid-manifest", `${label}: invalid mode ${JSON.stringify(value)}`);
	}
}

function validateManifest(manifest: TreeManifest, label: string): Map<string, ManifestEntry> {
	if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.entries)) {
		throw new ProjectSyncError("invalid-manifest", `${label}: manifest has no entries array`);
	}
	const map = new Map<string, ManifestEntry>();
	for (const entry of manifest.entries) {
		if (!entry || typeof entry !== "object") throw new ProjectSyncError("invalid-manifest", `${label}: bad entry`);
		assertRelPath(entry.path, label);
		if (map.has(entry.path)) throw new ProjectSyncError("invalid-manifest", `${label}: duplicate ${entry.path}`);
		assertMode(entry.mode, `${label}:${entry.path}`);
		if (entry.kind === "file") {
			if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
				throw new ProjectSyncError("invalid-manifest", `${label}: file ${entry.path} lacks a valid sha256`);
			}
			if (!Number.isInteger(entry.size) || (entry.size as number) < 0) {
				throw new ProjectSyncError("invalid-manifest", `${label}: file ${entry.path} lacks a valid size`);
			}
		} else if (entry.kind === "symlink") {
			if (typeof entry.target !== "string" || entry.target === "" || entry.target.includes("\0")) {
				throw new ProjectSyncError("invalid-manifest", `${label}: symlink ${entry.path} lacks a valid target`);
			}
		} else if (entry.kind !== "dir") {
			throw new ProjectSyncError("invalid-manifest", `${label}: unknown kind for ${entry.path}`);
		}
		map.set(entry.path, entry);
	}
	for (const entry of map.values()) {
		const slash = entry.path.lastIndexOf("/");
		if (slash < 0) continue;
		const parent = map.get(entry.path.slice(0, slash));
		if (parent?.kind !== "dir") {
			throw new ProjectSyncError("invalid-manifest", `${label}: ${entry.path} has no directory parent entry`);
		}
	}
	return map;
}

// ---------------------------------------------------------- exclusion globs

function globToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i] as string;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					i++;
					out += "(?:.*/)?";
				} else out += ".*";
			} else out += "[^/]*";
		} else if (c === "?") out += "[^/]";
		else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`, "u");
}

type ExcludeMatcher = (rel: string, name: string, isDir: boolean) => boolean;

function compileExclude(pattern: string): ExcludeMatcher {
	let p = typeof pattern === "string" ? pattern.trim() : "";
	const dirOnly = p.endsWith("/");
	if (dirOnly) p = p.slice(0, -1);
	const anchored = p.startsWith("/");
	if (anchored) p = p.slice(1);
	if (p === "" || p.includes("\0")) {
		throw new ProjectSyncError("invalid-exclude", `invalid exclude pattern ${JSON.stringify(pattern)}`);
	}
	const re = globToRegExp(p);
	const full = anchored || p.includes("/");
	return (rel, name, isDir) => (dirOnly && !isDir ? false : re.test(full ? rel : name));
}

// ----------------------------------------------------------- warning rules

const SECRET_NAME_PATTERNS: RegExp[] = [
	/^id_[^/]*$/,
	/\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
	/^\.(netrc|npmrc|pgpass|htpasswd|pypirc)$/,
	/^credentials(\.json)?$/,
	/^(secrets?|service-account[^/]*)\.(json|ya?ml|toml)$/i,
];

function isSecretName(name: string): boolean {
	if (name.endsWith(".pub")) return false;
	if (/^\.env(\..+)?$/.test(name)) return !/\.(example|sample|template|dist)$/.test(name);
	return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}

function specialKind(stat: { isSocket(): boolean; isFIFO(): boolean; isBlockDevice(): boolean; isCharacterDevice(): boolean }): string {
	if (stat.isSocket()) return "socket";
	if (stat.isFIFO()) return "fifo";
	if (stat.isBlockDevice()) return "block-device";
	if (stat.isCharacterDevice()) return "char-device";
	return "other";
}

async function readSmallText(file: string, limit: number): Promise<string | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, READ_FLAGS);
	} catch {
		return undefined;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > limit) return undefined;
		const buffer = Buffer.alloc(stat.size);
		const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

// -------------------------------------------------------------- manifest

/**
 * Walks `root` and records every non-excluded entry. The root itself is not an
 * entry. Symlinks are recorded by target and never traversed.
 */
export async function buildManifest(root: string, opts: { exclude?: string[] } = {}): Promise<TreeManifest> {
	const absRoot = path.resolve(root);
	const rootStat = await fs.stat(absRoot);
	if (!rootStat.isDirectory()) throw new ProjectSyncError("invalid-root", `not a directory: ${absRoot}`);
	const realRoot = await fs.realpath(absRoot);
	const insideRoot = (p: string) =>
		p === absRoot || p === realRoot || isWithin(p, absRoot) || isWithin(p, realRoot);
	const matchers = [...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])].map(compileExclude);

	const entries: ManifestEntry[] = [];
	const warnings: ProjectWarning[] = [];
	const submodules = new Set<string>();
	const warnSubmodule = (rel: string, detail?: string) => {
		if (submodules.has(rel)) return;
		submodules.add(rel);
		warnings.push({ kind: "submodule", path: rel, ...(detail ? { detail } : {}) });
	};

	async function inspectGitFile(rel: string, abs: string): Promise<void> {
		const text = await readSmallText(abs, GITFILE_LIMIT);
		const match = text === undefined ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
		if (!match) return;
		const gitdir = path.resolve(path.dirname(abs), match[1] as string);
		if (!insideRoot(gitdir)) {
			warnings.push({ kind: "external-gitdir", path: rel, detail: gitdir });
			return;
		}
		if (rel !== ".git" && /(^|\/)modules\//.test(gitdir.split(path.sep).join("/"))) {
			warnSubmodule(rel.slice(0, -"/.git".length), "gitlink");
		}
	}

	async function inspectGitmodules(abs: string): Promise<void> {
		const text = await readSmallText(abs, GITMODULES_LIMIT);
		if (text === undefined) return;
		for (const match of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
			const rel = path.posix.normalize(match[1] as string);
			if (rel === "." || rel.startsWith("../") || rel.startsWith("/") || rel.includes("\0")) continue;
			warnSubmodule(rel, ".gitmodules");
		}
	}

	async function walk(rel: string): Promise<void> {
		const dir = rel === "" ? absRoot : path.join(absRoot, rel);
		for (const name of await fs.readdir(dir)) {
			const childRel = rel === "" ? name : `${rel}/${name}`;
			const abs = path.join(dir, name);
			const stat = await fs.lstat(abs);
			if (matchers.some((m) => m(childRel, name, stat.isDirectory()))) continue;
			const mode = stat.mode & 0o777;
			if (stat.isDirectory()) {
				entries.push({ path: childRel, kind: "dir", mode });
				await walk(childRel);
			} else if (stat.isSymbolicLink()) {
				const target = await fs.readlink(abs);
				entries.push({ path: childRel, kind: "symlink", mode, target });
				if (path.isAbsolute(target)) warnings.push({ kind: "absolute-symlink", path: childRel, detail: target });
				if (!insideRoot(path.resolve(dir, target))) {
					warnings.push({ kind: "external-symlink", path: childRel, detail: target });
				}
			} else if (stat.isFile()) {
				const facts = await hashFile(abs);
				entries.push({ path: childRel, kind: "file", mode: facts.mode, size: facts.size, sha256: facts.sha256 });
				if (isSecretName(name)) warnings.push({ kind: "possible-secret-file", path: childRel });
				if (name === ".git") await inspectGitFile(childRel, abs);
				else if (childRel === ".gitmodules") await inspectGitmodules(abs);
			} else {
				warnings.push({ kind: "special-file-skipped", path: childRel, detail: specialKind(stat) });
			}
		}
	}

	await walk("");
	entries.sort(byPath);
	warnings.sort((a, b) => byPath(a, b) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
	return { root: absRoot, entries, warnings };
}

// ------------------------------------------------------------------ plan

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of Object.keys(record).sort()) {
			if (record[key] === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
		}
		return `{${parts.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** SHA-256 over the canonical JSON of every plan field except `digest`. */
export function computePlanDigest(plan: Omit<ProjectPlan, "digest"> | ProjectPlan): string {
	const { digest: _digest, ...rest } = plan as ProjectPlan;
	return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

function sealPlan(plan: Omit<ProjectPlan, "digest">): ProjectPlan {
	return { ...plan, digest: computePlanDigest(plan) };
}

function stateOf(entry: ManifestEntry | undefined): EntryState {
	if (!entry) return { kind: "absent" };
	if (entry.kind === "file") return { kind: "file", mode: entry.mode, sha256: entry.sha256 as string };
	if (entry.kind === "dir") return { kind: "dir", mode: entry.mode };
	return { kind: "symlink", target: entry.target as string };
}

/**
 * Compares a source manifest with the destination manifest. `session-only`
 * plans nothing. `create` requires an absent or empty destination. `update`
 * never plans a deletion; destination-only entries are only counted. Entries
 * that cannot be applied without losing destination data are reported as
 * conflicts and left out of `entries`.
 */
export function diffManifests(
	source: TreeManifest,
	destination: TreeManifest | undefined,
	mode: ProjectPlan["mode"],
): ProjectPlan {
	if (mode === "session-only") {
		return sealPlan({ mode, entries: [], unchanged: 0, destinationOnly: 0, conflicts: [], totalBytes: 0, warnings: [] });
	}
	if (mode !== "create" && mode !== "update") {
		throw new ProjectSyncError("invalid-plan", `unknown project mode ${JSON.stringify(mode)}`);
	}
	const src = validateManifest(source, "source");
	if (mode === "update" && !destination) {
		throw new ProjectSyncError("invalid-plan", "update requires a destination manifest");
	}
	const dst = destination ? validateManifest(destination, "destination") : new Map<string, ManifestEntry>();
	if (mode === "create" && dst.size > 0) {
		throw new ProjectSyncError("invalid-plan", "create requires an absent or empty destination");
	}

	const nonEmptyDirs = new Set<string>();
	for (const p of dst.keys()) {
		for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) nonEmptyDirs.add(p.slice(0, i));
	}

	const entries: PlanEntry[] = [];
	const conflicts: PlanConflict[] = [];
	const reportedSymlinks = new Set<string>();
	let unchanged = 0;
	let totalBytes = 0;

	const bytesOf = (s: ManifestEntry) => (s.kind === "file" ? (s.size as number) : 0);
	const planEntry = (s: ManifestEntry, action: PlanEntry["action"], d: ManifestEntry | undefined, bytes: number) => {
		const entry: PlanEntry = { path: s.path, action, kind: s.kind, bytes, destination: stateOf(d) };
		if (s.kind !== "symlink") entry.mode = s.mode;
		if (s.kind === "file") entry.sha256 = s.sha256 as string;
		if (s.kind === "symlink") entry.target = s.target as string;
		entries.push(entry);
		totalBytes += bytes;
	};

	for (const s of [...src.values()].sort(byPath)) {
		const parts = s.path.split("/");
		let beneathSymlink: string | undefined;
		let prefix = "";
		for (let i = 0; i < parts.length - 1; i++) {
			prefix = i === 0 ? (parts[0] as string) : `${prefix}/${parts[i]}`;
			if (dst.get(prefix)?.kind === "symlink") {
				beneathSymlink = prefix;
				break;
			}
		}
		if (beneathSymlink !== undefined) {
			if (!reportedSymlinks.has(beneathSymlink)) {
				reportedSymlinks.add(beneathSymlink);
				conflicts.push({
					path: s.path,
					sourceKind: s.kind,
					destinationKind: "symlink",
					reason: `path lies beneath destination symlink '${beneathSymlink}'`,
				});
			}
			continue;
		}

		const d = dst.get(s.path);
		if (!d) {
			planEntry(s, "add", undefined, bytesOf(s));
			continue;
		}
		if (d.kind !== s.kind) {
			if (d.kind === "dir" && nonEmptyDirs.has(d.path)) {
				conflicts.push({
					path: s.path,
					sourceKind: s.kind,
					destinationKind: "dir",
					reason: `non-empty destination directory would be replaced by a ${s.kind}`,
				});
				continue;
			}
			planEntry(s, "replace", d, bytesOf(s));
			continue;
		}
		if (s.kind === "file") {
			if (s.sha256 !== d.sha256) planEntry(s, "replace", d, bytesOf(s));
			else if (s.mode !== d.mode) planEntry(s, "mode-change", d, 0);
			else unchanged++;
		} else if (s.kind === "symlink") {
			if (s.target !== d.target) planEntry(s, "replace", d, 0);
			else unchanged++;
		} else if (s.mode !== d.mode) planEntry(s, "mode-change", d, 0);
		else unchanged++;
	}

	let destinationOnly = 0;
	for (const p of dst.keys()) if (!src.has(p)) destinationOnly++;

	return sealPlan({ mode, entries, unchanged, destinationOnly, conflicts, totalBytes, warnings: source.warnings.slice() });
}

// ------------------------------------------------------------ path policy

function expandTilde(value: string, home: string): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}

function assertAbsolutePath(value: string, label: string): void {
	if (typeof value !== "string" || value === "" || value.includes("\0")) {
		throw new ProjectSyncError("path-policy", `${label}: invalid path`);
	}
	if (!path.isAbsolute(value)) throw new ProjectSyncError("path-policy", `${label}: path must be absolute`);
	if (value.split("/").includes("..")) {
		throw new ProjectSyncError("path-policy", `${label}: path must not contain '..' segments`);
	}
}

/** Realpath of the deepest existing ancestor joined with the missing tail. */
async function canonicalise(absolute: string): Promise<string> {
	const tail: string[] = [];
	let current = path.resolve(absolute);
	for (;;) {
		try {
			const real = await fs.realpath(current);
			return tail.length === 0 ? real : path.join(real, ...tail);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		try {
			await fs.lstat(current);
			throw new ProjectSyncError("path-policy", `dangling symlink in path: ${current}`);
		} catch (error) {
			if (error instanceof ProjectSyncError) throw error;
			if (!isMissing(error)) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) return path.join(current, ...tail);
		tail.unshift(path.basename(current));
		current = parent;
	}
}

/**
 * Maps a project below `sourceHome` to the same relative path below
 * `destinationHome` by path components. `override` wins and must be an absolute
 * path (or `~`-relative to `destinationHome`). Without an override a project
 * outside the home, or the home itself, is an error.
 */
export function resolveDestinationProject(
	sourceProject: string,
	sourceHome: string,
	destinationHome: string,
	override?: string,
): string {
	assertAbsolutePath(destinationHome, "destination home");
	if (override !== undefined && override !== "") {
		const expanded = expandTilde(override, destinationHome);
		assertAbsolutePath(expanded, "override");
		return path.resolve(expanded);
	}
	assertAbsolutePath(sourceProject, "source project");
	assertAbsolutePath(sourceHome, "source home");
	const project = path.resolve(sourceProject);
	const home = path.resolve(sourceHome);
	const relative = path.relative(home, project);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new ProjectSyncError(
			"project-outside-home",
			"source project is not below the source home; an explicit destination path is required",
		);
	}
	return path.join(path.resolve(destinationHome), relative);
}

/**
 * Canonicalises `candidate` (existing ancestors via realpath) and returns it
 * when policy allows a project there. Rejects relative paths, `..` segments,
 * the home itself, the filesystem root, protected paths and anything beneath
 * or above one, and anything not strictly beneath an allowed root. Allowed and
 * protected entries are `~`-expanded against `policy.home`.
 */
export async function validateDestinationPath(
	candidate: string,
	policy: { home: string; allowedRoots: string[]; protectedPaths: string[] },
): Promise<string> {
	assertAbsolutePath(policy.home, "policy home");
	const home = await canonicalise(policy.home);
	const resolvePolicyPath = async (entry: string, label: string): Promise<string> => {
		const expanded = expandTilde(entry, policy.home);
		assertAbsolutePath(expanded, label);
		return canonicalise(expanded);
	};
	assertAbsolutePath(expandTilde(candidate, policy.home), "destination");
	const target = await canonicalise(expandTilde(candidate, policy.home));
	const reject = (why: string): never => {
		throw new ProjectSyncError("path-policy", `destination ${target}: ${why}`);
	};

	if (target === path.parse(target).root) reject("is the filesystem root");
	if (target === home) reject("is the home directory");
	for (const entry of policy.protectedPaths) {
		const protectedPath = await resolvePolicyPath(entry, "protected path");
		if (target === protectedPath || isWithin(target, protectedPath) || isWithin(protectedPath, target)) {
			reject(`overlaps protected path ${protectedPath}`);
		}
	}
	let allowed = false;
	for (const entry of policy.allowedRoots) {
		if (isWithin(target, await resolvePolicyPath(entry, "allowed root"))) {
			allowed = true;
			break;
		}
	}
	if (!allowed) reject("is not beneath an allowed root");
	return target;
}

// --------------------------------------------------------- state probing

type Observed = EntryState | { kind: "other" } | { kind: "unsafe" };

/** Observes `rel` under `root` without following any symlink. */
async function observe(root: string, rel: string): Promise<Observed> {
	const parts = rel.split("/");
	let current = root;
	for (let i = 0; i < parts.length - 1; i++) {
		current = path.join(current, parts[i] as string);
		let stat: Stats;
		try {
			stat = await fs.lstat(current);
		} catch (error) {
			if (isMissing(error)) return { kind: "absent" };
			throw error;
		}
		if (!stat.isDirectory()) return { kind: "unsafe" };
	}
	const abs = path.join(root, rel);
	let stat: Stats;
	try {
		stat = await fs.lstat(abs);
	} catch (error) {
		if (isMissing(error)) return { kind: "absent" };
		throw error;
	}
	if (stat.isSymbolicLink()) return { kind: "symlink", target: await fs.readlink(abs) };
	if (stat.isDirectory()) return { kind: "dir", mode: stat.mode & 0o777 };
	if (stat.isFile()) {
		const facts = await hashFile(abs);
		return { kind: "file", mode: facts.mode, sha256: facts.sha256 };
	}
	return { kind: "other" };
}

function sameState(observed: Observed, expected: EntryState): boolean {
	if (observed.kind !== expected.kind) return false;
	if (observed.kind === "file" && expected.kind === "file") {
		return observed.sha256 === expected.sha256 && observed.mode === expected.mode;
	}
	if (observed.kind === "dir" && expected.kind === "dir") return observed.mode === expected.mode;
	if (observed.kind === "symlink" && expected.kind === "symlink") return observed.target === expected.target;
	return true;
}

// ----------------------------------------------------------- plan checks

function assertState(value: unknown, label: string): asserts value is EntryState {
	const state = value as EntryState | undefined;
	const bad = () => new ProjectSyncError("invalid-plan", `${label}: invalid destination state`);
	if (!state || typeof state !== "object") throw bad();
	if (state.kind === "absent") return;
	if (state.kind === "file") {
		if (typeof state.sha256 !== "string" || !SHA256_RE.test(state.sha256)) throw bad();
		assertModeForPlan(state.mode, label);
	} else if (state.kind === "dir") assertModeForPlan(state.mode, label);
	else if (state.kind === "symlink") {
		if (typeof state.target !== "string" || state.target === "" || state.target.includes("\0")) throw bad();
	} else throw bad();
}

function assertModeForPlan(value: unknown, label: string): void {
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
		throw new ProjectSyncError("invalid-plan", `${label}: invalid mode`);
	}
}

function validatePlan(plan: ProjectPlan): Map<string, PlanEntry> {
	if (!plan || typeof plan !== "object" || !Array.isArray(plan.entries)) {
		throw new ProjectSyncError("invalid-plan", "plan has no entries array");
	}
	if (plan.mode !== "update") throw new ProjectSyncError("invalid-plan", `cannot apply a '${plan.mode}' plan as an update`);
	const map = new Map<string, PlanEntry>();
	for (const entry of plan.entries) {
		if (!entry || typeof entry !== "object") throw new ProjectSyncError("invalid-plan", "bad plan entry");
		try {
			assertRelPath(entry.path, "plan");
		} catch (error) {
			throw new ProjectSyncError("invalid-plan", (error as Error).message);
		}
		const label = `plan:${entry.path}`;
		if (map.has(entry.path)) throw new ProjectSyncError("invalid-plan", `${label}: duplicate entry`);
		if (entry.action !== "add" && entry.action !== "replace" && entry.action !== "mode-change") {
			throw new ProjectSyncError("invalid-plan", `${label}: unknown action`);
		}
		assertState(entry.destination, label);
		if (entry.kind === "file") {
			if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
				throw new ProjectSyncError("invalid-plan", `${label}: file lacks sha256`);
			}
			assertModeForPlan(entry.mode, label);
		} else if (entry.kind === "dir") assertModeForPlan(entry.mode, label);
		else if (entry.kind === "symlink") {
			if (typeof entry.target !== "string" || entry.target === "" || entry.target.includes("\0")) {
				throw new ProjectSyncError("invalid-plan", `${label}: symlink lacks target`);
			}
		} else throw new ProjectSyncError("invalid-plan", `${label}: unknown kind`);
		const destination = entry.destination as EntryState;
		if (entry.action === "add" && destination.kind !== "absent") {
			throw new ProjectSyncError("invalid-plan", `${label}: add over an existing destination entry`);
		}
		if (entry.action !== "add" && destination.kind === "absent") {
			throw new ProjectSyncError("invalid-plan", `${label}: ${entry.action} of an absent destination entry`);
		}
		if (entry.action === "mode-change" && (destination.kind !== entry.kind || entry.kind === "symlink")) {
			throw new ProjectSyncError("invalid-plan", `${label}: invalid mode-change`);
		}
		map.set(entry.path, entry);
	}
	for (const entry of map.values()) {
		const slash = entry.path.lastIndexOf("/");
		if (slash < 0) continue;
		const parent = map.get(entry.path.slice(0, slash));
		if (parent && parent.kind !== "dir") {
			throw new ProjectSyncError("invalid-plan", `plan:${entry.path}: parent entry is not a directory`);
		}
		if (parent && parent.destination?.kind === "symlink") {
			throw new ProjectSyncError("invalid-plan", `plan:${entry.path}: lies beneath a destination symlink`);
		}
	}
	if (plan.digest !== computePlanDigest(plan)) throw new ProjectSyncError("invalid-plan", "plan digest does not match its content");
	if (Array.isArray(plan.conflicts) && plan.conflicts.length > 0) {
		throw new ProjectSyncError("conflicts", "plan has unresolved conflicts", plan.conflicts.map((c) => c.path));
	}
	return map;
}

function resultOf(entry: PlanEntry): EntryState {
	if (entry.kind === "file") return { kind: "file", mode: entry.mode as number, sha256: entry.sha256 as string };
	if (entry.kind === "dir") return { kind: "dir", mode: entry.mode as number };
	return { kind: "symlink", target: entry.target as string };
}

// ----------------------------------------------------------------- apply

/**
 * Applies the `add`, `replace` and `mode-change` entries of an update plan.
 * Every destination path the plan touches is re-observed (content hashes for
 * files) and every staged source file is re-hashed before the first write; any
 * difference aborts with nothing written. Replaced files are copied under
 * `undoDir` first. Destination-only entries are never touched. The undo
 * manifest is written before the first mutation.
 */
export async function applyProjectUpdate(opts: {
	stagingDir: string;
	destRoot: string;
	plan: ProjectPlan;
	undoDir: string;
}): Promise<UndoManifest> {
	const planned = validatePlan(opts.plan);
	const root = await fs.realpath(opts.destRoot);
	if (!(await fs.stat(root)).isDirectory()) throw new ProjectSyncError("invalid-root", `not a directory: ${root}`);
	const ordered = [...planned.values()].sort(
		(a, b) => a.path.split("/").length - b.path.split("/").length || byPath(a, b),
	);

	const stagedNeeded = ordered.some((e) => e.action !== "mode-change" && e.kind !== "dir");
	const stagingRoot = stagedNeeded ? await fs.realpath(opts.stagingDir) : "";

	const changed: string[] = [];
	const staging: string[] = [];
	for (const entry of ordered) {
		let ancestorsOk = true;
		let plannedAncestor = false;
		const parts = entry.path.split("/");
		let prefix = "";
		for (let i = 0; i < parts.length - 1 && ancestorsOk; i++) {
			prefix = i === 0 ? (parts[0] as string) : `${prefix}/${parts[i]}`;
			if (planned.has(prefix)) {
				plannedAncestor = true;
				continue;
			}
			try {
				ancestorsOk = (await fs.lstat(path.join(root, prefix))).isDirectory();
			} catch (error) {
				if (!isMissing(error)) throw error;
				ancestorsOk = false;
			}
		}
		if (!ancestorsOk) {
			changed.push(entry.path);
			continue;
		}
		let live = await observe(root, entry.path);
		const expected = entry.destination as EntryState;
		// A planned ancestor that is a file or link today becomes a directory; its own check covers it.
		if (plannedAncestor && live.kind === "unsafe" && expected.kind === "absent") live = expected;
		if (!sameState(live, expected)) {
			changed.push(entry.path);
			continue;
		}
		if (
			expected.kind === "dir" &&
			entry.action === "replace" &&
			(await fs.readdir(path.join(root, entry.path))).length > 0
		) {
			changed.push(entry.path);
			continue;
		}
		if (entry.action === "mode-change" || entry.kind === "dir") continue;
		if (!(await stagedMatches(stagingRoot, entry))) staging.push(entry.path);
	}
	if (changed.length > 0) {
		throw new ProjectSyncError("destination-changed", `destination changed since the plan was made: ${changed.join(", ")}`, changed);
	}
	if (staging.length > 0) {
		throw new ProjectSyncError("staging-mismatch", `staged content does not match the plan: ${staging.join(", ")}`, staging);
	}

	await fs.mkdir(path.join(opts.undoDir, BACKUP_DIR), { recursive: true, mode: 0o700 });
	if (await pathExists(path.join(opts.undoDir, UNDO_FILE))) {
		throw new ProjectSyncError("undo-exists", `an undo manifest already exists in ${opts.undoDir}`);
	}
	const undo: UndoManifest = {
		version: 1,
		planDigest: opts.plan.digest,
		destRoot: root,
		createdAt: new Date().toISOString(),
		status: "applying",
		entries: ordered.map((entry, index) => {
			const prior = entry.destination as EntryState;
			const backup = entry.action === "replace" && prior.kind === "file" ? String(index) : undefined;
			return {
				path: entry.path,
				prior: backup === undefined ? prior : { ...prior, backup },
				result:
					entry.action === "mode-change" && prior.kind === "file"
						? { kind: "file", mode: entry.mode as number, sha256: prior.sha256 }
						: resultOf(entry),
			};
		}),
	};
	const undoFile = path.join(opts.undoDir, UNDO_FILE);
	await writeJsonAtomic(undoFile, undo);

	try {
		for (let i = 0; i < ordered.length; i++) {
			await applyEntry(root, stagingRoot, opts.undoDir, ordered[i] as PlanEntry, undo.entries[i] as UndoEntry);
		}
		for (let i = ordered.length - 1; i >= 0; i--) {
			const entry = ordered[i] as PlanEntry;
			if (entry.kind === "dir") await chmodNoFollow(path.join(root, entry.path), entry.mode as number);
		}
	} catch (error) {
		undo.status = "failed";
		undo.error = (error as Error).message;
		await writeJsonAtomic(undoFile, undo).catch(() => {});
		throw error;
	}
	undo.status = "applied";
	await writeJsonAtomic(undoFile, undo);
	return undo;
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.lstat(p);
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

async function stagedMatches(stagingRoot: string, entry: PlanEntry): Promise<boolean> {
	const parts = entry.path.split("/");
	let current = stagingRoot;
	try {
		for (let i = 0; i < parts.length - 1; i++) {
			current = path.join(current, parts[i] as string);
			if (!(await fs.lstat(current)).isDirectory()) return false;
		}
		const abs = path.join(stagingRoot, entry.path);
		if (entry.kind === "symlink") {
			return (await fs.lstat(abs)).isSymbolicLink() && (await fs.readlink(abs)) === entry.target;
		}
		return (await hashFile(abs)).sha256 === entry.sha256;
	} catch (error) {
		if (isMissing(error) || errCode(error) === "ELOOP") return false;
		throw error;
	}
}

async function applyEntry(
	root: string,
	stagingRoot: string,
	undoDir: string,
	entry: PlanEntry,
	undo: UndoEntry,
): Promise<void> {
	const dest = path.join(root, entry.path);
	const parent = await fs.lstat(path.dirname(dest));
	if (!parent.isDirectory()) throw new ProjectSyncError("destination-changed", `parent of ${entry.path} is not a directory`, [entry.path]);
	if (entry.action === "mode-change") {
		if (entry.kind === "file") await chmodNoFollow(dest, entry.mode as number);
		return;
	}

	const prior = entry.destination as EntryState;
	if (undo.prior.backup !== undefined && prior.kind === "file") {
		try {
			await copyVerified(dest, path.join(undoDir, BACKUP_DIR, undo.prior.backup), prior.sha256, prior.mode);
		} catch (error) {
			if (error instanceof ProjectSyncError) {
				throw new ProjectSyncError("destination-changed", `${entry.path} changed while being backed up`, [entry.path]);
			}
			throw error;
		}
	} else if (prior.kind !== "absent" && !sameState(await observe(root, entry.path), prior)) {
		throw new ProjectSyncError("destination-changed", `${entry.path} changed before it was replaced`, [entry.path]);
	}

	const removeDir = async () => {
		try {
			await fs.rmdir(dest);
		} catch (error) {
			if (errCode(error) === "ENOTEMPTY") {
				throw new ProjectSyncError("destination-changed", `${entry.path} is no longer empty`, [entry.path]);
			}
			throw error;
		}
	};

	if (entry.kind === "dir") {
		if (prior.kind === "file" || prior.kind === "symlink") await fs.unlink(dest);
		await fs.mkdir(dest, { mode: 0o700 });
		return;
	}
	const tmp = tmpSibling(dest);
	try {
		if (entry.kind === "file") {
			await copyVerified(path.join(stagingRoot, entry.path), tmp, entry.sha256 as string, entry.mode as number);
		} else {
			await fs.symlink(entry.target as string, tmp);
		}
		if (prior.kind === "dir") await removeDir();
		else if (prior.kind === "absent" && (await pathExists(dest))) {
			throw new ProjectSyncError("destination-changed", `${entry.path} appeared during the update`, [entry.path]);
		}
		await fs.rename(tmp, dest);
	} catch (error) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

// --------------------------------------------------------------- publish

/**
 * Moves a staged tree to `destRoot`, which must not exist. `destRoot` is
 * claimed by an atomic `mkdir` and then replaced by the rename, so a racing
 * creator cannot be overwritten. Staging and destination must share a
 * filesystem.
 */
export async function publishNewProject(stagingDir: string, destRoot: string): Promise<void> {
	const stat = await fs.lstat(stagingDir);
	if (!stat.isDirectory()) throw new ProjectSyncError("invalid-root", `staging is not a directory: ${stagingDir}`);
	await fs.mkdir(path.dirname(destRoot), { recursive: true });
	try {
		await fs.mkdir(destRoot, { mode: 0o700 });
	} catch (error) {
		if (errCode(error) === "EEXIST") throw new ProjectSyncError("destination-exists", `destination already exists: ${destRoot}`);
		throw error;
	}
	try {
		await fs.rename(stagingDir, destRoot);
	} catch (error) {
		await fs.rmdir(destRoot).catch(() => {});
		throw error;
	}
}

// --------------------------------------------------------------- restore

function parseUndoManifest(raw: string): UndoManifest {
	const bad = (why: string) => new ProjectSyncError("invalid-undo", `invalid undo manifest: ${why}`);
	let value: UndoManifest;
	try {
		value = JSON.parse(raw) as UndoManifest;
	} catch {
		throw bad("not JSON");
	}
	if (!value || value.version !== 1 || !Array.isArray(value.entries)) throw bad("unsupported shape");
	if (typeof value.destRoot !== "string" || !path.isAbsolute(value.destRoot)) throw bad("destRoot");
	const seen = new Set<string>();
	for (const entry of value.entries) {
		try {
			assertRelPath(entry?.path, "undo");
			assertState(entry.prior, "undo prior");
			assertState(entry.result, "undo result");
		} catch (error) {
			throw bad((error as Error).message);
		}
		if (seen.has(entry.path)) throw bad(`duplicate ${entry.path}`);
		seen.add(entry.path);
		const backup = entry.prior.backup;
		if (backup !== undefined && (typeof backup !== "string" || !/^\d+$/.test(backup))) throw bad("backup name");
	}
	return value;
}

/**
 * Reverses an applied (or partly applied) update. A path is restored only
 * while it still equals what the operation wrote; created entries are removed,
 * replaced entries and modes are put back. Any other state is reported as a
 * conflict and left alone. Re-running is safe: paths already in their prior
 * state are skipped.
 */
export async function restoreProjectUpdate(undoDir: string): Promise<{ restored: string[]; conflicts: string[] }> {
	const undoFile = path.join(undoDir, UNDO_FILE);
	let raw: string;
	try {
		raw = await fs.readFile(undoFile, "utf8");
	} catch (error) {
		if (isMissing(error)) throw new ProjectSyncError("undo-missing", `no undo manifest in ${undoDir}`);
		throw error;
	}
	const manifest = parseUndoManifest(raw);
	const root = manifest.destRoot;
	if (!(await fs.lstat(root)).isDirectory()) throw new ProjectSyncError("invalid-root", `not a directory: ${root}`);

	const ops = [...manifest.entries].reverse();
	const restored: string[] = [];
	const conflicts: string[] = [];
	const deferred: string[] = [];
	const widened = new Map<string, number>();

	for (const op of ops) {
		if (op.result.kind !== "dir" || (op.result.mode & 0o300) === 0o300) continue;
		const abs = path.join(root, op.path);
		const seen = await observe(root, op.path);
		if (seen.kind === "dir" && seen.mode === op.result.mode) {
			await chmodNoFollow(abs, seen.mode | 0o700);
			widened.set(abs, seen.mode);
		}
	}

	for (const op of ops) {
		const abs = path.join(root, op.path);
		let current = await observe(root, op.path);
		const originalMode = widened.get(abs);
		if (current.kind === "dir" && originalMode !== undefined) current = { kind: "dir", mode: originalMode };
		if (current.kind === "unsafe" || current.kind === "other") {
			conflicts.push(op.path);
			continue;
		}
		if (sameState(current, op.prior)) continue;
		const ignoreDirMode = op.result.kind === "dir" && op.prior.kind !== "dir" && current.kind === "dir";
		if (!ignoreDirMode && !sameState(current, op.result)) {
			conflicts.push(op.path);
			continue;
		}
		try {
			await revertEntry(undoDir, abs, op);
			restored.push(op.path);
			widened.delete(abs);
		} catch (error) {
			if (errCode(error) === "ENOTEMPTY" || errCode(error) === "EEXIST") deferred.push(op.path);
			else if (error instanceof ProjectSyncError) conflicts.push(op.path);
			else throw error;
		}
	}
	for (const dir of deferred) {
		if (!conflicts.some((c) => c.startsWith(`${dir}/`))) conflicts.push(dir);
	}
	for (const [abs, mode] of widened) {
		try {
			await chmodNoFollow(abs, mode);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}

	restored.sort();
	conflicts.sort();
	if (conflicts.length === 0 && manifest.status !== "restored") {
		manifest.status = "restored";
		await writeJsonAtomic(undoFile, manifest);
	}
	return { restored, conflicts };
}

async function revertEntry(undoDir: string, abs: string, op: UndoEntry): Promise<void> {
	const { prior, result } = op;
	if (result.kind === "dir" && prior.kind === "dir") {
		await chmodNoFollow(abs, prior.mode);
		return;
	}
	if (result.kind === "file" && prior.kind === "file" && prior.sha256 === result.sha256) {
		await chmodNoFollow(abs, prior.mode);
		return;
	}

	const prepared = await preparePrior(undoDir, abs, op);
	try {
		if (result.kind === "dir") await fs.rmdir(abs);
		else if (prior.kind === "absent" || prior.kind === "dir") await fs.unlink(abs);
		if (prepared !== undefined) await fs.rename(prepared, abs);
		else if (prior.kind === "dir") {
			await fs.mkdir(abs, { mode: 0o700 });
			await chmodNoFollow(abs, prior.mode);
		}
	} catch (error) {
		if (prepared !== undefined) await fs.rm(prepared, { force: true }).catch(() => {});
		throw error;
	}
}

/** Stages the prior file or symlink beside `abs` so removing the current entry cannot lose it. */
async function preparePrior(undoDir: string, abs: string, op: UndoEntry): Promise<string | undefined> {
	const { prior } = op;
	if (prior.kind === "file") {
		if (prior.backup === undefined) throw new ProjectSyncError("invalid-undo", `no backup recorded for ${op.path}`);
		const tmp = tmpSibling(abs);
		try {
			await copyVerified(path.join(undoDir, BACKUP_DIR, prior.backup), tmp, prior.sha256, prior.mode);
		} catch (error) {
			if (errCode(error) === "ENOENT" || errCode(error) === "ELOOP") {
				throw new ProjectSyncError("invalid-undo", `backup for ${op.path} is missing`);
			}
			throw error;
		}
		return tmp;
	}
	if (prior.kind === "symlink") {
		const tmp = tmpSibling(abs);
		await fs.symlink(prior.target, tmp);
		return tmp;
	}
	return undefined;
}
