import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { CollabHost } from "./collab-registry.js";
import { RpcCode, RpcError } from "./protocol.js";

export const HOST_SESSIONS_FEATURE = "host.sessions.v1";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const NAME_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/;
const exec = promisify(execFile);

export interface HistorySession {
	id: string;
	path: string;
	cwd: string;
	title?: string;
	firstMessage: string;
	modified: Date;
}

interface SavedName {
	name: string;
	/** Covers the interval before a detached process publishes its Collab share. */
	pendingUntil?: number;
}

export interface HostSessionsOptions {
	listHistory: () => Promise<HistorySession[]>;
	listOpen: () => Promise<CollabHost[]>;
	newSessionDir: (cwd: string) => Promise<string>;
	isSessionOpen: (id: string) => Promise<boolean>;
	acquireLaunchLock: () => Promise<(() => void) | undefined>;
	currentSessionId: () => string | undefined;
	stateDir?: string;
	launcher?: string;
}

/** Host-local names survive both the originating process and hub restarts. */
export class HostSessions {
	readonly #stateDir: string;
	constructor(private readonly options: HostSessionsOptions) {
		this.#stateDir =
			options.stateDir ??
			join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "omp-connected", "session-names");
	}

	async #saved(id: string): Promise<SavedName | undefined> {
		if (!ID_PATTERN.test(id)) return undefined;
		try {
			const value = JSON.parse(await readFile(join(this.#stateDir, `${id}.json`), "utf8"));
			return typeof value.name === "string" && (value.name === "" || NAME_PATTERN.test(value.name))
				? value
				: undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
			throw error;
		}
	}

	async #save(id: string, value: SavedName): Promise<void> {
		if (!ID_PATTERN.test(id)) return;
		await mkdir(this.#stateDir, { recursive: true, mode: 0o700 });
		const destination = join(this.#stateDir, `${id}.json`);
		const temp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
			await rename(temp, destination);
		} finally {
			await unlink(temp).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}

	async remember(id: string, cwd: string, label: string | undefined): Promise<void> {
		if (!label) return;
		const prefix = basename(cwd);
		const name = label === prefix ? "" : label.startsWith(`${prefix}.`) ? label.slice(prefix.length + 1) : undefined;
		if (name !== undefined) await this.#save(id, { name });
	}

	async #openIds(): Promise<Set<string>> {
		const hosts = await this.options.listOpen();
		if (!hosts.some((host) => host.access === "control")) {
			throw new RpcError(-32003, "This host needs a control-shared OMP session to list or start sessions.");
		}
		const ids = new Set(hosts.flatMap((host) => (typeof host.sessionId === "string" ? [host.sessionId] : [])));
		const current = this.options.currentSessionId();
		if (current) ids.add(current);
		return ids;
	}

	async list() {
		const openIds = await this.#openIds();
		const history = await this.options.listHistory();
		const sessions = [];
		for (const session of history.sort((a, b) => b.modified.getTime() - a.modified.getTime())) {
			if (openIds.has(session.id) || (await this.options.isSessionOpen(session.id))) continue;
			const saved = await this.#saved(session.id);
			if ((saved?.pendingUntil ?? 0) > Date.now()) continue;
			sessions.push({
				sessionId: session.id,
				cwd: session.cwd,
				title: session.title || session.firstMessage.slice(0, 160) || session.id,
				modifiedAt: session.modified.getTime(),
				...(saved ? { name: saved.name } : {}),
			});
		}
		return { sessions };
	}

	async start(params: unknown) {
		const value = params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
		if (
			typeof value?.cwd !== "string" ||
			!value.cwd.trim() ||
			value.cwd.includes("\0") ||
			typeof value.name !== "string" ||
			(value.name !== "" && !NAME_PATTERN.test(value.name)) ||
			(value.sessionId !== undefined && (typeof value.sessionId !== "string" || !ID_PATTERN.test(value.sessionId)))
		) {
			throw new RpcError(-32004, "Invalid path, ompc name or session UUID.");
		}
		let cwd: string;
		try {
			const homePath =
				value.cwd === "~" ? homedir() : value.cwd.startsWith("~/") ? join(homedir(), value.cwd.slice(2)) : value.cwd;
			if (!homePath.startsWith("/")) throw new RpcError(-32004, "Path must be absolute or start with ~/.");
			cwd = await realpath(resolve(homePath));
			if (!(await stat(cwd)).isDirectory()) throw new RpcError(-32004, "Path is not a directory.");
		} catch (error) {
			if (error instanceof RpcError) throw error;
			throw new RpcError(-32004, `Cannot open directory: ${(error as Error).message}`);
		}
		const label = `${basename(cwd)}${value.name ? `.${value.name}` : ""}`;
		if (!LABEL_PATTERN.test(label))
			throw new RpcError(
				-32004,
				"The directory name and ompc name together must be 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
			);
		const release = await this.options.acquireLaunchLock();
		if (!release) throw new RpcError(-32006, "Another session is being started on this host; retry shortly.");
		try {
			const openIds = await this.#openIds();
			const args = ["--detach", "--new", ...(value.name ? [value.name] : [])];
			const id = value.sessionId as string | undefined;
			if (id) {
				if (
					openIds.has(id) ||
					(await this.options.isSessionOpen(id)) ||
					((await this.#saved(id))?.pendingUntil ?? 0) > Date.now()
				) {
					throw new RpcError(-32002, "This conversation is already open or starting on the host.");
				}
				const session = (await this.options.listHistory()).find((session) => session.id === id);
				if (!session) throw new RpcError(-32001, "The past session no longer exists on this host.");
				args.push("--resume", session.path);
			} else args.push("--session-dir", await this.options.newSessionDir(cwd));
			let launcher = this.options.launcher;
			if (!launcher) {
				const installed = join(homedir(), ".local", "bin", "ompc");
				launcher = await stat(installed).then(
					() => installed,
					(error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
						return "ompc";
					},
				);
			}
			const env = { ...process.env };
			delete env.TMUX;
			delete env.TMUX_PANE;
			delete env.OMPC_SESSION;
			const saved = id ? await this.#saved(id) : undefined;
			if (id) await this.#save(id, { name: value.name, pendingUntil: Date.now() + 60_000 });
			try {
				await exec(launcher, args, {
					cwd,
					env,
					timeout: 15_000,
					maxBuffer: 64 * 1024,
				});
			} catch (error) {
				const failure = error as Error & { code?: number; stderr?: string };
				if (id) {
					if (saved) await this.#save(id, saved);
					else await unlink(join(this.#stateDir, `${id}.json`));
				}
				throw new RpcError(failure.code === 73 ? -32002 : RpcCode.Internal, failure.stderr?.trim() || failure.message);
			}
			return { ok: true, label };
		} finally {
			release();
		}
	}
}
