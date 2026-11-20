import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";

export interface SshConfig {
	/** `[user@]host` handed to ssh as its destination argument. */
	target: string;
	port?: number;
	/** Absolute local path; `~` is expanded against the loading host's home. */
	identityFile?: string;
}

export interface DestinationConfig {
	/** Dashboard label only; never used as an ssh target. */
	hostId: string;
	ssh: SshConfig;
	/** Helper path on the destination, relative to the ssh login directory or absolute. */
	helperPath: string;
	/** Destination paths; `~` entries resolve against the destination home (see `resolveDestinationPolicy`). */
	allowedRoots: string[];
	/** Destination paths, always including `DEFAULT_PROTECTED_PATHS`. */
	protectedPaths: string[];
}

export interface TransferConfig {
	enabled: boolean;
	destinations: Record<string, DestinationConfig>;
}

export type TransferConfigErrorCode = "invalid" | "disabled" | "unknown-destination";

export class TransferConfigError extends Error {
	readonly code: TransferConfigErrorCode;
	constructor(code: TransferConfigErrorCode, message: string) {
		super(message);
		this.name = "TransferConfigError";
		this.code = code;
	}
}

export const DESTINATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const DEFAULT_HELPER_PATH = ".local/bin/ompc-transfer-helper";
export const DEFAULT_ALLOWED_ROOTS: readonly string[] = ["~"];
export const DEFAULT_PROTECTED_PATHS: readonly string[] = ["~/.ssh", "~/.omp", "~/.config", "~/.local/state"];

const TARGET_PATTERN = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]{0,63}@)?(?:[A-Za-z0-9][A-Za-z0-9._-]{0,254}|\[[0-9A-Fa-f:.]{2,45}\])$/;
const HELPER_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const MAX_PATH_LENGTH = 4096;
const TOP_LEVEL_KEYS = ["enabled", "destinations"];
const DESTINATION_KEYS = ["hostId", "ssh", "helperPath", "allowedRoots", "protectedPaths"];
const SSH_KEYS = ["target", "port", "identityFile"];

/** `${XDG_CONFIG_HOME:-~/.config}/omp-connected/transfer.json`. */
export function defaultTransferConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const xdg = env.XDG_CONFIG_HOME;
	const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
	return join(base, "omp-connected", "transfer.json");
}

/** Expands a leading `~` or `~/` against `home`. Other values, including `~user/...`, are returned unchanged. */
export function expandHome(value: string, home: string = homedir()): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return posix.join(home, value.slice(2));
	return value;
}

function invalid(path: string, reason: string): TransferConfigError {
	return new TransferConfigError("invalid", `Invalid transfer config at ${path}: ${reason}`);
}

function asObject(value: unknown, path: string, allowedKeys?: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(path, "expected an object");
	if (allowedKeys) {
		for (const key of Object.keys(value)) {
			if (!allowedKeys.includes(key)) throw invalid(`${path}.${key}`, "unknown field");
		}
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown, path: string, max = MAX_PATH_LENGTH): string {
	if (typeof value !== "string" || value === "") throw invalid(path, "expected a non-empty string");
	if (value.length > max) throw invalid(path, `longer than ${max} characters`);
	if (/[\u0000-\u001f\u007f]/.test(value)) throw invalid(path, "contains control characters");
	return value;
}

function asDestinationPath(value: unknown, path: string): string {
	const text = asString(value, path);
	if (text !== "~" && !text.startsWith("~/") && !text.startsWith("/")) {
		throw invalid(path, "expected an absolute path or a path starting with ~/");
	}
	const normal = posix.normalize(text);
	if (text.split("/").includes("..")) throw invalid(path, "must not contain '..' segments");
	return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal;
}

function asPathList(value: unknown, path: string, fallback: readonly string[]): string[] {
	if (value === undefined) return [...fallback];
	if (!Array.isArray(value)) throw invalid(path, "expected an array");
	return value.map((entry, index) => asDestinationPath(entry, `${path}[${index}]`));
}

function parseSsh(value: unknown, path: string, home: string): SshConfig {
	const ssh = asObject(value, path, SSH_KEYS);
	const target = asString(ssh.target, `${path}.target`, 320);
	if (target.startsWith("-") || !TARGET_PATTERN.test(target)) {
		throw invalid(`${path}.target`, "expected [user@]host without options or shell characters");
	}
	const result: SshConfig = { target };
	if (ssh.port !== undefined) {
		if (typeof ssh.port !== "number" || !Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535) {
			throw invalid(`${path}.port`, "expected an integer from 1 to 65535");
		}
		result.port = ssh.port;
	}
	if (ssh.identityFile !== undefined) {
		const identity = asString(ssh.identityFile, `${path}.identityFile`);
		if (identity.startsWith("-")) throw invalid(`${path}.identityFile`, "must not start with '-'");
		const expanded = expandHome(identity, home);
		if (!isAbsolute(expanded)) throw invalid(`${path}.identityFile`, "expected an absolute path or a path starting with ~/");
		result.identityFile = expanded;
	}
	return result;
}

function parseDestination(value: unknown, path: string, home: string): DestinationConfig {
	const destination = asObject(value, path, DESTINATION_KEYS);
	const hostId = asString(destination.hostId, `${path}.hostId`, 255);
	if (destination.ssh === undefined) throw invalid(`${path}.ssh`, "required");
	const ssh = parseSsh(destination.ssh, `${path}.ssh`, home);
	let helperPath = DEFAULT_HELPER_PATH;
	if (destination.helperPath !== undefined) {
		helperPath = asString(destination.helperPath, `${path}.helperPath`);
		if (
			!HELPER_PATH_PATTERN.test(helperPath) ||
			helperPath.startsWith("-") ||
			helperPath.endsWith("/") ||
			helperPath.split("/").includes("..")
		) {
			throw invalid(`${path}.helperPath`, "expected a plain path of letters, digits, '.', '_', '-' and '/'");
		}
	}
	const allowedRoots = asPathList(destination.allowedRoots, `${path}.allowedRoots`, DEFAULT_ALLOWED_ROOTS);
	if (allowedRoots.length === 0) throw invalid(`${path}.allowedRoots`, "must not be empty");
	if (allowedRoots.includes("/")) throw invalid(`${path}.allowedRoots`, "must not contain the filesystem root");
	const protectedPaths = [
		...new Set([...asPathList(destination.protectedPaths, `${path}.protectedPaths`, []), ...DEFAULT_PROTECTED_PATHS]),
	];
	return { hostId, ssh, helperPath, allowedRoots, protectedPaths };
}

/** Validates parsed JSON. `home` expands `ssh.identityFile`. */
export function parseTransferConfig(raw: unknown, home: string = homedir()): TransferConfig {
	const root = asObject(raw, "config", TOP_LEVEL_KEYS);
	if (root.enabled !== undefined && typeof root.enabled !== "boolean") throw invalid("config.enabled", "expected a boolean");
	const destinations: Record<string, DestinationConfig> = {};
	if (root.destinations !== undefined) {
		const entries = asObject(root.destinations, "config.destinations");
		for (const [name, value] of Object.entries(entries)) {
			if (!DESTINATION_NAME_PATTERN.test(name)) {
				throw invalid(`config.destinations.${name}`, "name must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/");
			}
			destinations[name] = parseDestination(value, `config.destinations.${name}`, home);
		}
	}
	return { enabled: root.enabled === true, destinations };
}

/**
 * Loads and validates the transfer config. A missing file yields the disabled default;
 * unreadable JSON or any invalid field throws `TransferConfigError` with code "invalid".
 */
export async function loadTransferConfig(
	path?: string,
	options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<TransferConfig> {
	const home = options.home ?? homedir();
	const file = path ?? defaultTransferConfigPath(options.env ?? process.env, home);
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false, destinations: {} };
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw invalid(file, `not valid JSON: ${(error as Error).message}`);
	}
	return parseTransferConfig(parsed, home);
}

/** Throws `disabled` when transfer is off and `unknown-destination` when `name` is not configured. */
export function getDestination(config: TransferConfig, name: string): DestinationConfig {
	if (!config.enabled) throw new TransferConfigError("disabled", "Transfer is not enabled");
	if (typeof name !== "string" || !DESTINATION_NAME_PATTERN.test(name) || !Object.hasOwn(config.destinations, name)) {
		throw new TransferConfigError("unknown-destination", "Unknown transfer destination");
	}
	return config.destinations[name];
}

/** Resolves the destination-side policy paths against the destination's home directory. */
export function resolveDestinationPolicy(
	destination: DestinationConfig,
	destinationHome: string,
): { home: string; allowedRoots: string[]; protectedPaths: string[] } {
	return {
		home: destinationHome,
		allowedRoots: destination.allowedRoots.map((root) => expandHome(root, destinationHome)),
		protectedPaths: destination.protectedPaths.map((path) => expandHome(path, destinationHome)),
	};
}
