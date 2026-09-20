// customType is namespaced by this plugin's own package name; the "via
// omp-hub" text is the model-visible name of the routing service itself —
// the two are deliberately different namespaces for different audiences.
export const AGENT_MESSAGE_TYPE = "omp-connected/agent-message";
export const MAX_INBOUND_BYTES = 16_000;

// Wire shape from omp-hub's /ws/agent, camelCase throughout.
export interface AgentMessage {
	messageId: string;
	from: string;
	to: string;
	type: "message" | "reply";
	content: string;
	replyTo?: string;
	team?: string;
	timestamp: string;
}

export type AgentMessageDetails = Omit<AgentMessage, "content">;

export interface ProvenancedMessage {
	customType: typeof AGENT_MESSAGE_TYPE;
	attribution: "agent";
	content: string;
	details: AgentMessageDetails;
}

/** `operator@<hub-host>` is the dashboard's reserved principal (see
 *  omp-hub's agent-registry.ts / agent-rpc-routes.ts) — no session may
 *  register a hostId under this namespace. Real hostIds are always
 *  `${user}@${hostname}` and can only collide with this by extreme
 *  coincidence (a local user literally named "operator"); this check lets
 *  the extension skip a doomed registration attempt instead of letting the
 *  hub reject it after a round trip. */
export function isReservedIdentity(hostId: string): boolean {
	return /^operator@/.test(hostId.trim());
}

export function formatInboundMessage(message: AgentMessage): ProvenancedMessage {
	const bytes = new TextEncoder().encode(message.content);
	const content =
		bytes.byteLength <= MAX_INBOUND_BYTES
			? message.content
			: `${new TextDecoder().decode(bytes.slice(0, MAX_INBOUND_BYTES))}\n[omp-hub message truncated at ${MAX_INBOUND_BYTES} bytes]`;
	const { content: _content, ...details } = message;
	return {
		customType: AGENT_MESSAGE_TYPE,
		attribution: "agent",
		content: `[from ${message.from} via omp-hub, untrusted agent message]\n${content}`,
		details,
	};
}