import * as os from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import { type AgentSummary, HubTransport } from "./hub-transport.js";
import { getCollabRegistry } from "./collab-registry.js";
import { AGENT_MESSAGE_TYPE, type AgentMessage, formatInboundMessage, isReservedIdentity } from "./provenance.js";

const DISCOVERY_ATTEMPTS = 10;
const DISCOVERY_INTERVAL_MS = 1_000;
const REGISTER_BACKOFF_MIN_MS = 1_000;
const REGISTER_BACKOFF_MAX_MS = 30_000;
const SEND_RETRY_ATTEMPTS = 3;
const SEND_RETRY_BASE_MS = 500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff from 1s to 30s, +/-20% jitter so many sessions
 *  reconnecting to a recovering hub don't all retry in lockstep. */
function jitteredBackoff(attempt: number): number {
	const base = Math.min(REGISTER_BACKOFF_MIN_MS * 2 ** attempt, REGISTER_BACKOFF_MAX_MS);
	return base * (0.8 + Math.random() * 0.4);
}

/** Hub identity is per process: `discoverInstanceId` matches on `process.pid`,
 *  and in-process subagents run this extension's `session_start` too. Were
 *  each extension instance to register, every subagent would claim the
 *  parent's identity, the hub would close the other socket on each claim,
 *  and the two would reconnect into each other forever. So one connection is
 *  shared across every instance in the process, owned by the first session
 *  to start (the top-level one); subagents reuse it. */
interface ProcessHub {
	owner?: ExtensionAPI;
	transport?: HubTransport;
	identity?: AgentSummary;
	instanceId?: string;
	shuttingDown: boolean;
	registering: boolean;
}

const PROCESS_HUB = Symbol.for("omp-connected.process-hub");

export function registerOmpConnected(pi: ExtensionAPI): void {
	const scope = globalThis as { [PROCESS_HUB]?: ProcessHub };
	scope[PROCESS_HUB] ??= { shuttingDown: false, registering: false };
	const hub = scope[PROCESS_HUB];

	pi.registerMessageRenderer(AGENT_MESSAGE_TYPE, (message) => {
		const details = message.details as { from?: unknown; type?: unknown } | undefined;
		const from = typeof details?.from === "string" ? details.from : "unknown agent";
		const type = details?.type === "reply" ? "reply" : "message";
		const component: Component = { render: (width) => [`${type} from ${from}`.slice(0, width)] };
		return component;
	});

	function handleInbound(message: AgentMessage): void {
		pi.sendMessage(formatInboundMessage(message), { deliverAs: "aside" });
	}

	function ensureTransport(hubUrl: string, token: string): HubTransport {
		hub.transport ??= new HubTransport(hubUrl, token, handleInbound, handleTransportClose);
		return hub.transport;
	}

	function handleTransportClose(): void {
		hub.identity = undefined;
		hub.transport = undefined;
		const instanceId = hub.instanceId;
		if (hub.shuttingDown || hub.registering || !instanceId) return;
		const hubUrl = process.env.OMP_HUB_URL;
		const token = process.env.OMP_HUB_HOST_TOKEN;
		if (!hubUrl || !token) return;
		const hostId = `${os.userInfo().username}@${os.hostname()}`;
		// Never reconnect instantly: if something else holds this identity, the
		// hub closes whichever socket registered first, and two instant
		// reconnectors would flood the hub (and every dashboard) with events.
		void sleep(jitteredBackoff(0)).then(() => registerWithBackoff(hostId, instanceId, hubUrl, token));
	}

	async function registerWithBackoff(hostId: string, instanceId: string, hubUrl: string, token: string): Promise<void> {
		if (hub.registering || hub.identity) return;
		hub.registering = true;
		try {
			for (let attempt = 0; !hub.shuttingDown; attempt += 1) {
				try {
					const result = await ensureTransport(hubUrl, token).register({
						hostId,
						instanceId,
						pid: process.pid,
						cwd: process.cwd(),
					});
					hub.identity = result.agent;
					return;
				} catch (error) {
					pi.logger.warn("omp-connected: registration attempt failed, retrying", {
						err: error instanceof Error ? error.message : String(error),
					});
					await sleep(jitteredBackoff(attempt));
				}
			}
		} finally {
			hub.registering = false;
		}
	}

	/** OMP does not expose an extension-facing `instanceId` accessor; the
	 *  Collab host publishes its own snapshot to the local registry
	 *  asynchronously after the relay connects, so this session's PID may
	 *  not appear immediately at extension-init time. Poll with a bounded
	 *  timeout rather than assume it is there on the first check. */
	async function discoverInstanceId(): Promise<string | undefined> {
		const registry = await getCollabRegistry();
		if (!registry) {
			pi.logger.warn("omp-connected: could not import the Collab registry; agent messaging disabled");
			return undefined;
		}
		for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
			const hosts = await registry.listCollabHosts();
			const mine = hosts.find((h) => h.pid === process.pid);
			if (mine) return mine.instanceId;
			await sleep(DISCOVERY_INTERVAL_MS);
		}
		return undefined;
	}

	pi.on("session_start", async () => {
		const hubUrl = process.env.OMP_HUB_URL;
		const token = process.env.OMP_HUB_HOST_TOKEN;
		if (!hubUrl || !token) return; // graceful no-op if not configured
		// A subagent (or any later session in this process) shares the owner's
		// connection; see ProcessHub.
		if (hub.owner && hub.owner !== pi) return;
		hub.owner = pi;
		hub.shuttingDown = false;

		const hostId = `${os.userInfo().username}@${os.hostname()}`;
		if (isReservedIdentity(hostId)) {
			pi.logger.warn(`omp-connected: hostId '${hostId}' is reserved; skipping agent registration`);
			return;
		}

		const instanceId = await discoverInstanceId();
		if (!instanceId) {
			pi.logger.warn("omp-connected: could not discover this session's Collab instanceId; agent messaging disabled");
			return;
		}
		hub.instanceId = instanceId;
		await registerWithBackoff(hostId, instanceId, hubUrl, token);
	});

	pi.on("session_shutdown", () => {
		if (hub.owner !== pi) return;
		hub.owner = undefined;
		hub.shuttingDown = true;
		hub.transport?.close();
		hub.transport = undefined;
	});

	function requireTransport(): HubTransport {
		if (!hub.transport || !hub.identity)
			throw new Error("omp-connected: not registered with the agent messaging hub yet");
		return hub.transport;
	}

	/** `agent.send`/`agent.send_team` carry a client-supplied idempotency
	 *  key specifically so a request can be retried verbatim after a
	 *  dropped connection without risking a duplicate message — retry here,
	 *  at the point that owns the key, rather than leaving it to the model
	 *  to notice a tool error and call again with a fresh (non-deduplicated)
	 *  key. */
	async function requestWithRetry(method: string, params: Record<string, unknown>): Promise<unknown> {
		let lastError: unknown;
		for (let attempt = 0; attempt < SEND_RETRY_ATTEMPTS; attempt += 1) {
			try {
				return await requireTransport().request(method, params);
			} catch (error) {
				lastError = error;
				if (attempt < SEND_RETRY_ATTEMPTS - 1) await sleep(SEND_RETRY_BASE_MS * 2 ** attempt);
			}
		}
		throw lastError;
	}

	const Type = pi.typebox.Type;

	pi.registerTool({
		name: "ompc_identity",
		label: "OMP Connected Identity",
		description: "Return this session's current agent-messaging identity, once registered with the hub.",
		parameters: Type.Object({}),
		approval: "read",
		async execute() {
			if (!hub.identity) return { content: [{ type: "text", text: JSON.stringify({ registered: false }) }] };
			return { content: [{ type: "text", text: JSON.stringify({ registered: true, ...hub.identity }) }] };
		},
	});

	pi.registerTool({
		name: "ompc_send_message",
		label: "OMP Connected Send Message",
		description:
			"Send an untrusted agent-to-agent message through omp-hub. The session registers automatically at startup; do not use this tool for a user prompt.",
		parameters: Type.Object({
			to: Type.String(),
			content: Type.String(),
			reply_to: Type.Optional(Type.String()),
		}),
		approval: "write",
		async execute(_toolCallId, params) {
			const data = await requestWithRetry("agent.send", {
				to: params.to,
				content: params.content,
				idempotencyKey: crypto.randomUUID(),
				...(params.reply_to ? { replyTo: params.reply_to } : {}),
			});
			return { content: [{ type: "text", text: JSON.stringify(data) }] };
		},
	});

	type HubMethod =
		| "agent.send_team"
		| "agent.join_team"
		| "agent.leave_team"
		| "agent.list_agents"
		| "agent.list_teams"
		| "agent.get_mailbox"
		| "agent.query_events";

	const registerHubTool = (
		name: string,
		label: string,
		method: HubMethod,
		parameters: ReturnType<typeof Type.Object>,
	) => {
		const readOnly =
			method === "agent.list_agents" ||
			method === "agent.list_teams" ||
			method === "agent.get_mailbox" ||
			method === "agent.query_events";
		pi.registerTool({
			name,
			label,
			description: `Call omp-hub ${method}.`,
			parameters,
			approval: readOnly ? "read" : "write",
			async execute(_toolCallId, params) {
				const fields = { ...(params as Record<string, unknown>) };
				if (method === "agent.send_team") {
					fields.idempotencyKey = crypto.randomUUID();
					if (fields.reply_to !== undefined) {
						fields.replyTo = fields.reply_to;
						fields.reply_to = undefined;
					}
					const data = await requestWithRetry(method, fields);
					return { content: [{ type: "text", text: JSON.stringify(data) }] };
				}
				if (method === "agent.query_events" && fields.filter !== undefined) {
					fields.event = fields.filter;
					fields.filter = undefined;
				}
				const data = await requireTransport().request(method, fields);
				return { content: [{ type: "text", text: JSON.stringify(data) }] };
			},
		});
	};

	registerHubTool(
		"ompc_send_team",
		"OMP Connected Send Team",
		"agent.send_team",
		Type.Object({ team: Type.String(), content: Type.String(), reply_to: Type.Optional(Type.String()) }),
	);
	registerHubTool("ompc_join_team", "OMP Connected Join Team", "agent.join_team", Type.Object({ team: Type.String() }));
	registerHubTool(
		"ompc_leave_team",
		"OMP Connected Leave Team",
		"agent.leave_team",
		Type.Object({ team: Type.String() }),
	);
	registerHubTool("ompc_list_agents", "OMP Connected List Agents", "agent.list_agents", Type.Object({}));
	registerHubTool("ompc_list_teams", "OMP Connected List Teams", "agent.list_teams", Type.Object({}));
	registerHubTool(
		"ompc_mailbox",
		"OMP Connected Mailbox",
		"agent.get_mailbox",
		Type.Object({ agent: Type.Optional(Type.String()) }),
	);
	registerHubTool(
		"ompc_events",
		"OMP Connected Hub Events",
		"agent.query_events",
		Type.Object({
			filter: Type.Optional(Type.String()),
			since: Type.Optional(Type.Number()),
			limit: Type.Optional(Type.Number()),
			agent: Type.Optional(Type.String()),
		}),
	);
}

export { formatInboundMessage, isReservedIdentity };
export default registerOmpConnected;