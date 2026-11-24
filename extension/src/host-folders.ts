import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CollabHost } from "./collab-registry.js";
import { paramsRecord, RpcCode, RpcError } from "./protocol.js";

export const HOST_FOLDERS_FEATURE = "host.folders.v1";

export class HostFolders {
	constructor(private readonly listOpen: () => Promise<CollabHost[]>) {}

	async #path(params: unknown, allowEmpty: boolean): Promise<string> {
		if (!(await this.listOpen()).some((host) => host.access === "control")) {
			throw new RpcError(RpcCode.Forbidden, "This host needs a control-shared OMP session to browse folders.");
		}
		const { path } = paramsRecord(params);
		if (typeof path !== "string" || path.includes("\0") || (!allowEmpty && !path)) {
			throw new RpcError(RpcCode.Invalid, "Provide a valid folder path.");
		}
		const expanded = path === "" || path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
		if (!isAbsolute(expanded)) throw new RpcError(RpcCode.Invalid, "Path must be absolute or start with ~/.");
		return resolve(expanded);
	}

	async list(params: unknown) {
		const path = await this.#path(params, true);
		try {
			const canonical = await realpath(path);
			const entries = await readdir(canonical, { withFileTypes: true });
			const directories = await Promise.all(entries.map(async (entry) => {
				if (entry.isDirectory()) return entry.name;
				if (entry.isSymbolicLink()) {
					try {
						if ((await stat(join(canonical, entry.name))).isDirectory()) return entry.name;
					} catch {}
				}
				return undefined;
			}));
			return { path: canonical, entries: directories.filter((name): name is string => name !== undefined).sort() };
		} catch (error) {
			throw this.#error(error, "Cannot list directory");
		}
	}

	async mkdir(params: unknown) {
		const path = await this.#path(params, false);
		try {
			await mkdir(path);
			return { ok: true as const };
		} catch (error) {
			throw this.#error(error, "Cannot create directory");
		}
	}

	#error(error: unknown, action: string): RpcError {
		const code = (error as NodeJS.ErrnoException).code;
		const rpcCode = code === "ENOENT" ? RpcCode.NotFound : code === "EEXIST" ? RpcCode.Exists :
			code === "EACCES" || code === "EPERM" ? RpcCode.Forbidden : RpcCode.Invalid;
		return new RpcError(rpcCode, `${action}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
