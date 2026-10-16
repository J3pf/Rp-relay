import {
	AgentCommsQuery,
	type CommView,
	MeshConversationQuery,
	type MeshConversationRes,
	MeshQuery,
	type MeshSnapshot,
} from "@j3pf/rp-protocol";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../context.js";
import type { CommRow } from "../../db/repos/comms.js";
import type { HttpAuth } from "../auth.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function clampedLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(MAX_LIMIT, limit ?? DEFAULT_LIMIT));
}

function deduplicate(comms: CommRow[]): CommRow[] {
	const byMessageId = new Map<string, CommRow[]>();
	const unique: CommRow[] = [];
	for (const comm of comms) {
		if (comm.message_id === null) {
			unique.push(comm);
			continue;
		}
		const rows = byMessageId.get(comm.message_id) ?? [];
		rows.push(comm);
		byMessageId.set(comm.message_id, rows);
	}
	for (const rows of byMessageId.values()) {
		unique.push(rows.find((row) => row.direction === "out") ?? rows[0]!);
	}
	return unique.sort(
		(a, b) => b.at - a.at || b.comm_id.localeCompare(a.comm_id) || a.agent_id.localeCompare(b.agent_id),
	);
}

function toCommViews(comms: CommRow[], c: () => Ctx): CommView[] {
	if (comms.length === 0) return [];
	const ctx = c();
	const snapshot = ctx.mesh.getSnapshot(null);
	const agentCache = new Map<string, ReturnType<typeof ctx.repos.agents.get>>();
	const agent = (agentId: string | null) => {
		if (agentId === null) return undefined;
		if (!agentCache.has(agentId)) agentCache.set(agentId, ctx.repos.agents.get(agentId));
		return agentCache.get(agentId);
	};
	return comms.map((comm) => {
		const senderId = comm.direction === "out" ? comm.agent_id : comm.peer_agent_id;
		const receiverId = comm.direction === "out" ? comm.peer_agent_id : comm.agent_id;
		const sender = agent(senderId);
		const receiver = agent(receiverId);
		const senderFallback = senderId ?? comm.peer_session_id ?? comm.peer_name ?? "";
		const receiverFallback = receiverId ?? comm.peer_session_id ?? comm.peer_name ?? "";
		const senderGroupId = snapshot.nodes.find((node) => node.agentId === senderId)?.groupId;
		const receiverGroupId = snapshot.nodes.find((node) => node.agentId === receiverId)?.groupId;
		return {
			commKey: comm.comm_id,
			fromAgentId: senderId,
			toAgentId: receiverId,
			fromName: sender?.session_name || sender?.session_id || senderFallback,
			toName: receiver?.session_name || receiver?.session_id || receiverFallback,
			action: comm.action,
			text: sender?.redacted ? null : comm.text,
			truncated: Boolean(comm.truncated),
			at: comm.at,
			groupId: senderGroupId ?? receiverGroupId ?? null,
		};
	});
}

export function registerMesh(app: FastifyInstance, c: () => Ctx, auth: HttpAuth): void {
	app.get<{ Querystring: MeshQuery }>(
		"/v1/mesh",
		{ schema: { querystring: MeshQuery }, preHandler: auth.device },
		async (req): Promise<MeshSnapshot> => c().mesh.getSnapshot(req.query.machineId ?? null),
	);

	app.get<{ Querystring: MeshConversationQuery }>(
		"/v1/mesh/conversation",
		{ schema: { querystring: MeshConversationQuery }, preHandler: auth.device },
		async (req): Promise<MeshConversationRes> => {
			const { a, b } = req.query;
			const before = req.query.before === undefined ? undefined : Number(req.query.before);
			const limit = clampedLimit(req.query.limit);
			const fetchedRows = c().repos.comms.listConversation(a, b, before, limit + 1);
			const hasNextPage = fetchedRows.length > limit;
			const items = toCommViews(deduplicate(fetchedRows), c).slice(0, limit);
			return {
				items,
				nextBefore: hasNextPage ? (items.at(-1)?.at ?? null) : null,
			};
		},
	);

	app.get<{
		Params: { agentId: string };
		Querystring: AgentCommsQuery;
	}>(
		"/v1/mesh/agents/:agentId/comms",
		{
			schema: {
				params: Type.Object({ agentId: Type.String() }),
				querystring: AgentCommsQuery,
			},
			preHandler: auth.device,
		},
		async (req) => {
			const agentId = decodeURIComponent(req.params.agentId);
			const limit = clampedLimit(req.query.limit);
			const comms = c().repos.comms.listByAgent(agentId, limit);
			return { items: toCommViews(deduplicate(comms), c) };
		},
	);
}
