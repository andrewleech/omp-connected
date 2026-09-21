// Memoized dynamic import of the OMP Collab registry. Used by both
// discoverInstanceId (index.ts) and the collab.list/collab.link push
// handlers (hub-transport.ts). The registry is OMP-internal, so the
// import is late-bound and best-effort.

export interface CollabHost {
	pid: number;
	instanceId: string;
}

export interface CollabLinkResult {
	instanceId: string;
	generation: number;
	access: string;
	url: string;
}

interface CollabRegistryModule {
	listCollabHosts(): Promise<CollabHost[]>;
	resolveCollabHostLink(
		selector: string,
		access: "view" | "control",
		options?: { timeoutMs?: number },
	): Promise<CollabLinkResult>;
}

let cached: CollabRegistryModule | undefined;
let failed = false;

/** Returns the Collab registry module, or undefined if the import fails
 *  (e.g. OMP version mismatch, module not available). The result is
 *  memoized — a failed import is not retried. */
export async function getCollabRegistry(): Promise<CollabRegistryModule | undefined> {
	if (cached) return cached;
	if (failed) return undefined;
	try {
		cached = (await import(
			"@oh-my-pi/pi-coding-agent/collab/registry"
		)) as unknown as CollabRegistryModule;
		return cached;
	} catch {
		failed = true;
		return undefined;
	}
}