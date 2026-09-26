// JSON-RPC 2.0 framing for omp-hub's /ws/agent endpoint.

export interface JsonRpcRequest<M extends string = string, P = unknown> {
	jsonrpc: "2.0";
	id: string;
	method: M;
	params: P;
}

export interface JsonRpcResult<R = unknown> {
	jsonrpc: "2.0";
	id: string;
	result: R;
}

export interface JsonRpcErrorPayload {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcError {
	jsonrpc: "2.0";
	id: string;
	error: JsonRpcErrorPayload;
}

export type JsonRpcResponse<R = unknown> = JsonRpcResult<R> | JsonRpcError;

/** Error codes the extension replies with to hub-pushed requests. */
export const RpcCode = {
	NotFound: -32001,
	Exists: -32002,
	Forbidden: -32003,
	Invalid: -32004,
	Changed: -32005,
	Busy: -32006,
	MethodNotFound: -32601,
	Internal: -32603,
} as const;

/** A failure with a JSON-RPC error code, thrown by request handlers and
 *  replied to the hub as `{ error: { code, message } }`. */
export class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "RpcError";
	}
}

/** Converts any thrown value into a JSON-RPC error payload; anything that is
 *  not an RpcError is an internal failure. */
export function toErrorPayload(error: unknown): JsonRpcErrorPayload {
	if (error instanceof RpcError) return { code: error.code, message: error.message };
	return { code: RpcCode.Internal, message: error instanceof Error ? error.message : String(error) };
}

/** A request's params as an object; absent params read as `{}`. */
export function paramsRecord(params: unknown): Record<string, unknown> {
	if (params === undefined || params === null) return {};
	if (typeof params !== "object" || Array.isArray(params)) {
		throw new RpcError(RpcCode.Invalid, "params must be an object");
	}
	return params as Record<string, unknown>;
}

export function isJsonRpcResult<R>(msg: JsonRpcResponse<R>): msg is JsonRpcResult<R> {
	return "result" in msg;
}

export function requestId(): string {
	return crypto.randomUUID();
}

export function makeRequest<M extends string, P>(method: M, params: P): JsonRpcRequest<M, P> {
	return { jsonrpc: "2.0", id: requestId(), method, params };
}

export function hubWebSocketUrl(hubUrl: string): string {
	const url = new URL(hubUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = `${url.pathname.replace(/\/$/, "")}/ws/agent`;
	return url.toString();
}