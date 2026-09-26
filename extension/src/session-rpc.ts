// `session.*` and `files.*` requests pushed by omp-hub, answered on behalf of
// the session that owns this process's hub connection.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { FileService } from "./files-rpc.js";
import { paramsRecord, RpcCode, RpcError } from "./protocol.js";

/** Feature flag advertised in `agent.register` for this request set. */
export const SESSION_FEATURE = "session.v1";

export type CollabAccess = "view" | "control";

/** How long a resolved access level answers the gate without a new lookup. */
export const ACCESS_TTL_MS = 5_000;
/** How long the last successful answer survives failed lookups before the
 *  gate falls back to "view". */
export const ACCESS_STALE_MS = 30_000;

/** This session's Collab access, as the request gate reads it. */
export interface AccessSource {
	/** The cached level, looked up again once it is older than the TTL. */
	current(): Promise<CollabAccess>;
	/** A fresh lookup, joining one already in flight. */
	refresh(): Promise<CollabAccess>;
}

export interface AccessCacheOptions {
	ttlMs?: number;
	staleMs?: number;
	now?: () => number;
}

/**
 * Caches `lookup`, which resolves this session's access level or undefined
 * when it could not be determined (a registry error, or its own host entry
 * missing from a listing because the query timed out). A failed lookup keeps
 * the last successful answer for up to `staleMs`; with no such answer the
 * level is "view". Failed lookups are cached for the TTL like successful
 * ones, and concurrent callers share one lookup.
 */
export function createAccessCache(
	lookup: () => Promise<CollabAccess | undefined>,
	options: AccessCacheOptions = {},
): AccessSource {
	const ttlMs = options.ttlMs ?? ACCESS_TTL_MS;
	const staleMs = options.staleMs ?? ACCESS_STALE_MS;
	const now = options.now ?? Date.now;
	let known: { access: CollabAccess; at: number } | undefined;
	let checkedAt: number | undefined;
	let inflight: Promise<CollabAccess> | undefined;

	function resolved(): CollabAccess {
		return known !== undefined && now() - known.at <= staleMs ? known.access : "view";
	}

	function refresh(): Promise<CollabAccess> {
		inflight ??= (async () => {
			try {
				const access = await lookup().catch(() => undefined);
				checkedAt = now();
				if (access !== undefined) known = { access, at: checkedAt };
				return resolved();
			} finally {
				inflight = undefined;
			}
		})();
		return inflight;
	}

	return {
		current() {
			if (inflight) return inflight;
			if (checkedAt !== undefined && now() - checkedAt < ttlMs) return Promise.resolve(resolved());
			return refresh();
		},
		refresh,
	};
}

type Model = NonNullable<ExtensionContext["model"]>;

export interface ModelSummary {
	provider: string;
	id: string;
	name: string;
}

export interface SessionInfo {
	cwd: string;
	pid: number;
	sessionName: string | null;
	access: CollabAccess;
	idle: boolean;
	model: ModelSummary | null;
	thinkingLevel: string | null;
	thinkingLevels: string[];
	contextUsage: { tokens: number | null; contextWindow: number | null; percent: number | null } | null;
	models: ModelSummary[];
}

export interface SessionRpcDeps {
	pi: Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel" | "setModel" | "getSessionName" | "logger">;
	/** The owner session's current context; undefined before it starts. */
	context: () => ExtensionContext | undefined;
	/** The access level of this session's own Collab host entry. */
	access: AccessSource;
	files: FileService;
}

/** Handles one pushed request; throws RpcError for contract failures. */
export type SessionRequestHandler = (method: string, params: unknown) => Promise<unknown>;

/**
 * Thinking levels the model accepts, as omp's own selectors offer them:
 * "off" plus the efforts baked into the model's catalog entry
 * (`model.thinking.efforts`, the field omp's `getSupportedEfforts` reads).
 * Empty when the model has no controllable thinking.
 */
export function thinkingLevelsFor(model: Model | undefined): string[] {
	if (!model?.reasoning) return [];
	const efforts = model.thinking?.efforts ?? [];
	return efforts.length === 0 ? [] : ["off", ...efforts];
}

function summarise(model: Model): ModelSummary {
	return { provider: model.provider, id: model.id, name: model.name ?? model.id };
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}


export function createSessionRpc(deps: SessionRpcDeps): SessionRequestHandler {
	const { pi, files } = deps;
	/** Set while a compaction this handler started is running. */
	let compacting = false;

	function requireContext(): ExtensionContext {
		const ctx = deps.context();
		if (!ctx) throw new Error("the session is not ready");
		return ctx;
	}

	const handlers: Record<string, (params: unknown) => unknown> = {
		async "session.info"(): Promise<SessionInfo> {
			const ctx = requireContext();
			const model = ctx.model;
			const usage = ctx.getContextUsage();
			return {
				cwd: files.root,
				pid: process.pid,
				sessionName: pi.getSessionName() ?? null,
				// The dashboard polls this, so it keeps the gate's cached level current.
				access: await deps.access.refresh(),
				idle: ctx.isIdle(),
				model: model ? summarise(model) : null,
				thinkingLevel: pi.getThinkingLevel() ?? null,
				thinkingLevels: thinkingLevelsFor(model),
				contextUsage: usage
					? {
							tokens: finiteOrNull(usage.tokens),
							contextWindow: finiteOrNull(usage.contextWindow),
							percent: finiteOrNull(usage.percent),
						}
					: null,
				models: ctx.models.list().map(summarise),
			};
		},
		"session.abort"() {
			requireContext().abort();
			return { ok: true };
		},
		"session.compact"(params) {
			const { instructions } = paramsRecord(params);
			if (instructions !== undefined && typeof instructions !== "string") {
				throw new RpcError(RpcCode.Invalid, "instructions must be a string");
			}
			const ctx = requireContext();
			if (!ctx.isIdle()) {
				throw new RpcError(RpcCode.Busy, "the session is working; wait for it to finish or abort it first");
			}
			if (compacting) throw new RpcError(RpcCode.Busy, "a compaction is already running");
			compacting = true;
			// Compaction runs for as long as a model turn; reply once it has started.
			void Promise.resolve()
				.then(() => ctx.compact(instructions?.trim() ? instructions : undefined))
				.catch((error: unknown) => {
					pi.logger.warn("omp-connected: compaction requested through omp-hub failed", {
						err: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					compacting = false;
				});
			return { ok: true };
		},
		async "session.set_model"(params) {
			const { provider, id } = paramsRecord(params);
			if (typeof provider !== "string" || typeof id !== "string") {
				throw new RpcError(RpcCode.Invalid, "provider and id must be strings");
			}
			const model = requireContext()
				.models.list()
				.find((candidate) => candidate.provider === provider && candidate.id === id);
			if (!model) throw new RpcError(RpcCode.NotFound, `no available model ${provider}/${id}`);
			if (!(await pi.setModel(model))) {
				throw new RpcError(RpcCode.Invalid, `no API key is available for ${provider}/${id}`);
			}
			return { ok: true };
		},
		"session.set_thinking"(params) {
			const { level } = paramsRecord(params);
			const levels = thinkingLevelsFor(requireContext().model);
			if (typeof level !== "string" || !levels.includes(level)) {
				throw new RpcError(
					RpcCode.Invalid,
					levels.length === 0
						? "the current model does not support thinking levels"
						: `level must be one of: ${levels.join(", ")}`,
				);
			}
			pi.setThinkingLevel(level as Parameters<typeof pi.setThinkingLevel>[0]);
			return { ok: true };
		},
		"files.list": (params) => files.list(params),
		"files.stat": (params) => files.stat(params),
		"files.read": (params) => files.read(params),
		"files.write": (params) => files.write(params),
		"files.write_abort": (params) => files.writeAbort(params),
		"files.mkdir": (params) => files.mkdir(params),
	};

	return async (method, params) => {
		const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
		if (!handler) throw new RpcError(RpcCode.MethodNotFound, `unknown method '${method}'`);
		if (method !== "session.info" && (await deps.access.current()) !== "control") {
			throw new RpcError(RpcCode.Forbidden, "this session is shared view-only");
		}
		return handler(params);
	};
}
