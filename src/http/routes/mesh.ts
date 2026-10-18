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
import { agentDisplayName } from "../../domain/agentNames.js";
import { RelayError } from "../../util/errors.js";
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
		const primary = rows.find((row) => row.direction === "out") ?? rows[0]!;
		const peerAgentId =
			primary.peer_agent_id ??
			(primary.direction === "out"
				? (rows.find((row) => row.direction === "in" && row.agent_id !== primary.agent_id)?.agent_id ?? null)
				: (rows.find((row) => row.direction === "out" && row.agent_id !== primary.agent_id)?.agent_id ?? null));
		unique.push({
			...primary,
			peer_agent_id: peerAgentId,
			reply_to: primary.reply_to ?? rows.find((row) => row.reply_to !== null)?.reply_to ?? null,
			text: primary.text ?? rows.find((row) => row.text !== null)?.text ?? null,
			at: Math.min(...rows.map((row) => row.at)),
		});
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
		const senderCandidate = sender ?? {
			session_name: comm.direction === "in" ? comm.peer_name : null,
			session_id: comm.direction === "in" ? comm.peer_session_id : null,
			cwd: comm.direction === "in" ? comm.peer_cwd : null,
			id: senderId,
		};
		const receiverCandidate = receiver ?? {
			session_name: comm.direction === "out" ? comm.peer_name : null,
			session_id: comm.direction === "out" ? comm.peer_session_id : null,
			cwd: comm.direction === "out" ? comm.peer_cwd : null,
			id: receiverId,
		};
		const senderNode = senderId ? snapshot.nodes.find((node) => node.agentId === senderId) : undefined;
		const receiverNode = receiverId ? snapshot.nodes.find((node) => node.agentId === receiverId) : undefined;
		return {
			commKey: comm.comm_id,
			fromAgentId: senderId,
			toAgentId: receiverId,
			fromName: senderNode?.name ?? agentDisplayName(senderCandidate),
			toName: receiverNode?.name ?? agentDisplayName(receiverCandidate),
			action: comm.action,
			text: sender?.redacted ? null : comm.text,
			truncated: Boolean(comm.truncated),
			at: comm.at,
			groupId: senderNode?.groupId ?? receiverNode?.groupId ?? null,
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
			let before: number | undefined;
			if (req.query.before !== undefined) {
				const beforeNum = Number(req.query.before);
				if (Number.isNaN(beforeNum) || beforeNum <= 0) {
					throw new RelayError("bad_request", "before debe ser un timestamp numérico válido");
				}
				before = beforeNum;
			}
			const limit = clampedLimit(req.query.limit);
			const fetchedRows = c().repos.comms.listConversation(a, b, before, (limit + 1) * 2);
			const deduped = deduplicate(fetchedRows);
			const hasNextPage = deduped.length > limit;
			const page = deduped.slice(0, limit);
			const items = toCommViews(page, c);
			return {
				items,
				nextBefore: hasNextPage ? (page.at(-1)?.at ?? null) : null,
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
			const comms = c().repos.comms.listByAgent(agentId, limit * 2);
			return { items: toCommViews(deduplicate(comms).slice(0, limit), c) };
		},
	);
}
