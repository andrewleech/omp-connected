// SSH and rsync invocation for the source worker. Executables are spawned with
// argument arrays only. The remote command is the validated helper path, user
// data travels as JSON on stdin, and rsync paths are sent with --protect-args
// so the remote shell never sees them.

import type { SshConfig } from "./config.js";

/** Version of the helper stdin/stdout protocol this worker speaks. */
export const TRANSFER_PROTOCOL = 1;

/** Options passed on every ssh invocation. Host keys and authentication are never relaxed. */
export const SSH_FIXED_OPTIONS: readonly string[] = [
	"-o",
	"BatchMode=yes",
	"-o",
	"StrictHostKeyChecking=yes",
	"-o",
	"ForwardAgent=no",
	"-o",
	"ClearAllForwardings=yes",
];

const TARGET_PATTERN = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]{0,63}@)?(?:[A-Za-z0-9][A-Za-z0-9._-]{0,254}|\[[0-9A-Fa-f:.]{2,45}\])$/;
const HELPER_PATH_PATTERN = /^[A-Za-z0-9._/-]{1,4096}$/;
const DEFAULT_HELPER_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REPLY_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
/** rsync exit codes that mean the connection or stream failed; a rerun resumes from partial files. */
const RSYNC_TRANSIENT_EXIT_CODES: ReadonlySet<number> = new Set([10, 12, 30, 35, 255]);

export type SshErrorCode = "invalid-config" | "spawn-failed" | "timeout" | "aborted" | "ssh-failed" | "bad-reply" | "rsync-failed";

export class SshError extends Error {
	constructor(
		readonly code: SshErrorCode,
		message: string,
		/** True when repeating an idempotent call may succeed (connection loss, timeout). */
		readonly retryable = false,
	) {
		super(message);
		this.name = "SshError";
	}
}

export type HelperReply = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string };

export interface DestinationSshSpec {
	ssh: SshConfig;
}

export interface HelperDestination extends DestinationSshSpec {
	helperPath: string;
}

export interface CallOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	maxReplyBytes?: number;
	signal?: AbortSignal;
}

function invalid(message: string): SshError {
	return new SshError("invalid-config", message);
}

/** The ssh executable: `OMPC_TRANSFER_SSH` when set, else `ssh` from PATH. */
export function sshExecutable(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OMPC_TRANSFER_SSH;
	return override !== undefined && override !== "" ? override : "ssh";
}

function validatedSsh(ssh: SshConfig): SshConfig {
	if (typeof ssh?.target !== "string" || !TARGET_PATTERN.test(ssh.target)) throw invalid("ssh target is not a valid [user@]host");
	if (ssh.port !== undefined && (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535)) throw invalid("ssh port is not valid");
	if (ssh.identityFile !== undefined) {
		const id = ssh.identityFile;
		if (typeof id !== "string" || !id.startsWith("/") || id.length > 4096 || /[\0-\x1f\x7f]/.test(id)) {
			throw invalid("ssh identity file must be an absolute path");
		}
	}
	return ssh;
}

function validatedHelperPath(helperPath: string): string {
	if (typeof helperPath !== "string" || !HELPER_PATH_PATTERN.test(helperPath) || helperPath.startsWith("-")) {
		throw invalid("helper path is not valid");
	}
	if (helperPath.split("/").includes("..")) throw invalid("helper path must not contain '..'");
	return helperPath;
}

/** Executable and options shared by the helper call and rsync's `-e`, without the destination. */
export function sshCommandPrefix(ssh: SshConfig, env: NodeJS.ProcessEnv = process.env): string[] {
	const checked = validatedSsh(ssh);
	return [
		sshExecutable(env),
		...SSH_FIXED_OPTIONS,
		...(checked.port === undefined ? [] : ["-p", String(checked.port)]),
		...(checked.identityFile === undefined ? [] : ["-i", checked.identityFile]),
	];
}

/** Full argv for one helper call: the remote command is exactly the validated helper path. */
export function buildHelperArgv(dest: HelperDestination, env: NodeJS.ProcessEnv = process.env): string[] {
	return [...sshCommandPrefix(dest.ssh, env), "--", dest.ssh.target, validatedHelperPath(dest.helperPath)];
}

async function readLimited(stream: ReadableStream<Uint8Array> | undefined, max: number): Promise<{ text: string; truncated: boolean }> {
	if (!stream) return { text: "", truncated: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (size + value.length > max) {
				chunks.push(value.subarray(0, Math.max(0, max - size)));
				truncated = true;
				break;
			}
			chunks.push(value);
			size += value.length;
		}
	} finally {
		reader.cancel().catch(() => undefined);
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

function brief(text: string, max = 300): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from remote output
	const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

interface SpawnResult {
	exitCode: number | null;
	stdout: string;
	stdoutTruncated: boolean;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

async function runProcess(
	argv: string[],
	opts: { env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<SpawnResult> {
	if (opts.signal?.aborted) throw new SshError("aborted", "operation aborted");
	let proc: Bun.Subprocess;
	try {
		proc = Bun.spawn(argv, {
			env: Object.fromEntries(Object.entries(opts.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
			stdin: opts.stdin === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		throw new SshError("spawn-failed", `could not start ${argv[0]}: ${(error as Error).message}`);
	}
	let timedOut = false;
	let aborted = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, opts.timeoutMs);
	const onAbort = (): void => {
		aborted = true;
		proc.kill();
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (opts.stdin !== undefined) {
			try {
				const sink = proc.stdin as unknown as { write(data: string): unknown; end(): unknown };
				sink.write(opts.stdin);
				await sink.end();
			} catch {
				// The process exited before reading stdin; its exit code reports why.
			}
		}
		const [out, err] = await Promise.all([
			readLimited(proc.stdout as ReadableStream<Uint8Array>, opts.maxBytes),
			readLimited(proc.stderr as ReadableStream<Uint8Array>, MAX_STDERR_BYTES),
		]);
		if (out.truncated) proc.kill();
		const exitCode = await proc.exited;
		return { exitCode, stdout: out.text, stdoutTruncated: out.truncated, stderr: err.text, timedOut, aborted };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

function parseReply(text: string): HelperReply {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		throw new SshError("bad-reply", "the helper reply is not valid JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SshError("bad-reply", "the helper reply is not an object");
	const reply = value as Record<string, unknown>;
	if (reply.ok === true) return reply as HelperReply;
	if (reply.ok === false && typeof reply.code === "string" && typeof reply.message === "string") {
		return { ok: false, code: reply.code.slice(0, 128), message: reply.message.slice(0, 2000) };
	}
	throw new SshError("bad-reply", "the helper reply has no valid ok field");
}

/**
 * Sends one JSON request to the destination helper over ssh and returns its one JSON reply.
 * A transport failure, timeout, or malformed reply throws `SshError`; a helper-reported failure
 * is returned as `{ ok: false, code, message }`.
 */
export async function callHelper(
	dest: HelperDestination,
	request: { op: string; [key: string]: unknown },
	options: CallOptions = {},
): Promise<HelperReply> {
	const argv = buildHelperArgv(dest, options.env);
	const body = JSON.stringify({ ...request, protocol: TRANSFER_PROTOCOL });
	const result = await runProcess(argv, {
		env: options.env,
		stdin: body,
		timeoutMs: options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
		maxBytes: options.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES,
		signal: options.signal,
	});
	if (result.aborted) throw new SshError("aborted", "operation aborted");
	if (result.timedOut) throw new SshError("timeout", `the helper call ${request.op} timed out`, true);
	if (result.stdoutTruncated) throw new SshError("bad-reply", "the helper reply is too large");
	if (result.exitCode !== 0) {
		throw new SshError(
			"ssh-failed",
			`ssh exited with ${result.exitCode}${result.stderr ? `: ${brief(result.stderr)}` : ""}`,
			result.exitCode === 255 || result.exitCode === null,
		);
	}
	return parseReply(result.stdout);
}

/** Quotes one argument for rsync's `-e` string, which splits on whitespace and honours single and double quotes. */
function quoteForRsyncShell(arg: string): string {
	if (/[\0-\x1f\x7f]/.test(arg)) throw invalid("ssh argument contains control characters");
	if (arg !== "" && !/[\s'"\\]/.test(arg)) return arg;
	if (!arg.includes("'")) return `'${arg}'`;
	if (!arg.includes('"') && !arg.includes("\\")) return `"${arg}"`;
	throw invalid("ssh argument cannot be quoted for rsync");
}

export interface RsyncOptions extends DestinationSshSpec {
	/** Local source directory; names in `filesFrom` are relative to it. */
	src: string;
	/** Local file with NUL-separated relative paths. */
	filesFrom: string;
	/** Absolute destination directory on the remote host. */
	dest: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** Extra attempts after a transient failure. Default 3. */
	retries?: number;
	backoffMs?: number;
	/** rsync `--timeout` (seconds of I/O silence). Default 60. */
	ioTimeoutSec?: number;
	/** Wall-clock limit per attempt. Default 6 hours. */
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

function assertRemoteDirectory(dest: string): void {
	if (typeof dest !== "string" || !dest.startsWith("/") || dest.length > 4096 || /[\0\n\r]/.test(dest)) {
		throw invalid("rsync destination must be an absolute path");
	}
}

/** The rsync argv: update semantics, never `--delete`, no ownership, devices, specials or setuid bits. */
export function buildRsyncArgv(options: RsyncOptions): string[] {
	assertRemoteDirectory(options.dest);
	if (typeof options.src !== "string" || !options.src.startsWith("/")) throw invalid("rsync source must be an absolute path");
	if (typeof options.filesFrom !== "string" || !options.filesFrom.startsWith("/")) throw invalid("rsync file list must be an absolute path");
	const sshCommand = sshCommandPrefix(options.ssh, options.env).map(quoteForRsyncShell).join(" ");
	const trim = (value: string): string => (value.length > 1 ? value.replace(/\/+$/, "") : value);
	return [
		"rsync",
		"-s",
		"-l",
		"-p",
		"-t",
		"--from0",
		`--files-from=${options.filesFrom}`,
		"--no-owner",
		"--no-group",
		"--no-devices",
		"--no-specials",
		"--chmod=u-s,g-s,o-t",
		"--partial",
		`--timeout=${options.ioTimeoutSec ?? 60}`,
		"-e",
		sshCommand,
		"--",
		`${trim(options.src)}/`,
		`${options.ssh.target}:${trim(options.dest)}/`,
	];
}

/** Copies the listed files to a remote directory, retrying transient failures; `--partial` resumes. */
export async function rsyncFiles(options: RsyncOptions): Promise<{ attempts: number }> {
	const argv = buildRsyncArgv(options);
	const retries = options.retries ?? 3;
	const sleep = options.sleep ?? Bun.sleep;
	let lastFailure = "";
	for (let attempt = 1; attempt <= retries + 1; attempt++) {
		const result = await runProcess(argv, {
			env: options.env,
			timeoutMs: options.timeoutMs ?? 6 * 60 * 60 * 1000,
			maxBytes: 1024 * 1024,
			signal: options.signal,
		});
		if (result.aborted) throw new SshError("aborted", "operation aborted");
		if (result.exitCode === 0 && !result.timedOut) return { attempts: attempt };
		lastFailure = result.timedOut
			? "rsync timed out"
			: `rsync exited with ${result.exitCode}${result.stderr ? `: ${brief(result.stderr)}` : ""}`;
		const transient = result.timedOut || (result.exitCode !== null && RSYNC_TRANSIENT_EXIT_CODES.has(result.exitCode)) || result.exitCode === null;
		if (!transient || attempt > retries) {
			throw new SshError("rsync-failed", `${lastFailure} after ${attempt} attempt${attempt === 1 ? "" : "s"}`, transient);
		}
		await sleep((options.backoffMs ?? 2000) * attempt);
	}
	throw new SshError("rsync-failed", lastFailure);
}
