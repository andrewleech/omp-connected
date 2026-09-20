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