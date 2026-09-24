// Collab host discovery and link resolution on this machine, via OMP's
// `omp collab list|link --json` implementations called in-process (no
// subprocess). Used by discoverInstanceId (index.ts) and the hub's
// collab.list/collab.link pushes (hub-transport.ts).
//
// Why `cli/collab-cli` and not `collab/registry`: a compiled (standalone) omp
// binary serves extension imports only for the package exports it bundles.
// `./cli/*` is a named wildcard export and is bundled; `collab/registry` is
// reachable only through the root `./*` catch-all, which is not, so importing
// it fails there. The `--json` output is also omp's versioned contract, where
// the registry module is internal.

/** `version` of the `omp collab … --json` output this module understands. */
const COLLAB_JSON_VERSION = 1;

type CollabAccess = "view" | "control";

/** One `omp collab list --json` host snapshot. Only the fields this
 *  extension reads are typed; the rest are forwarded to the hub untouched. */
export type CollabHost = Record<string, unknown> & { instanceId: string; pid: number };

export interface CollabLinkResult {
	instanceId: string;
	generation: number;
	access: CollabAccess;
	url: string;
}

export interface CollabRegistry {
	listCollabHosts(): Promise<CollabHost[]>;
	resolveCollabHostLink(instanceId: string, access: CollabAccess): Promise<CollabLinkResult>;
}

type Print = (line: string) => void;

/** Local mirror of `@oh-my-pi/pi-coding-agent/cli/collab-cli`. */
interface CollabCliModule {
	runCollabListCommand(args: { json: boolean }, print: Print): Promise<void>;
	runCollabLinkCommand(args: { selector: string; view: boolean; json: boolean }, print: Print): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Runs one command in `--json` mode and returns its output object once the
 *  version matches. Throws on anything else: schema drift must be loud. */
async function runJson(command: (print: Print) => Promise<void>): Promise<Record<string, unknown>> {
	const lines: string[] = [];
	await command((line) => lines.push(line));
	const output: unknown = JSON.parse(lines.join("\n"));
	if (!isRecord(output) || output.version !== COLLAB_JSON_VERSION) {
		throw new Error(`unsupported omp collab JSON output (expected version ${COLLAB_JSON_VERSION})`);
	}
	return output;
}

function isCollabHost(value: unknown): value is CollabHost {
	return isRecord(value) && typeof value.instanceId === "string" && typeof value.pid === "number";
}

function createRegistry(cli: CollabCliModule): CollabRegistry {
	return {
		async listCollabHosts() {
			const output = await runJson((print) => cli.runCollabListCommand({ json: true }, print));
			const hosts = output.hosts;
			if (!Array.isArray(hosts) || !hosts.every(isCollabHost)) {
				throw new Error("malformed omp collab list output");
			}
			return hosts;
		},
		async resolveCollabHostLink(instanceId, access) {
			const output = await runJson((print) =>
				cli.runCollabLinkCommand({ selector: instanceId, view: access === "view", json: true }, print),
			);
			const { generation, url } = output;
			if (
				typeof output.instanceId !== "string" ||
				typeof generation !== "number" ||
				(output.access !== "view" && output.access !== "control") ||
				typeof url !== "string"
			) {
				throw new Error("malformed omp collab link output");
			}
			return { instanceId: output.instanceId, generation, access: output.access, url };
		},
	};
}

let cached: CollabRegistry | undefined;
let failed = false;

/** Returns the Collab registry, or undefined if OMP's collab CLI module can't
 *  be loaded (an omp without it). Memoized — a failed load is not retried. */
export async function getCollabRegistry(): Promise<CollabRegistry | undefined> {
	if (cached) return cached;
	if (failed) return undefined;
	try {
		// Dynamic: the module is supplied by the host omp at runtime, and a
		// failed load must leave agent messaging disabled rather than fail the
		// whole extension.
		const cli = (await import("@oh-my-pi/pi-coding-agent/cli/collab-cli")) as unknown as CollabCliModule;
		cached = createRegistry(cli);
		return cached;
	} catch {
		failed = true;
		return undefined;
	}
}
