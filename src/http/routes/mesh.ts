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
import { buildCommView } from "../../domain/mesh/service.js";
import { deduplicateCommRows } from "../../domain/mesh/topology.js";
import { RelayError } from "../../util/errors.js";
import type { HttpAuth } from "../auth.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function clampedLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(MAX_LIMIT, limit ?? DEFAULT_LIMIT));
}

function toCommViews(comms: CommRow[], c: () => Ctx): CommView[] {
	if (comms.length === 0) return [];
	const ctx = c();
	const snapshot = ctx.mesh.getSnapshot(null);
	const nodesById = new Map(snapshot.nodes.map((node) => [node.agentId, node]));
	const agentCache = new Map<string, ReturnType<typeof ctx.repos.agents.get>>();
	const agent = (agentId: string) => {
		if (!agentCache.has(agentId)) agentCache.set(agentId, ctx.repos.agents.get(agentId));
		return agentCache.get(agentId);
	};
	return comms.map((comm) =>
		buildCommView(comm, {
			getAgent: agent,
			getNode: (agentId) => nodesById.get(agentId),
		}),
	);
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
			const fetchedRows = c().repos.comms.listConversation(a, b, before, (limit + 1) * 3);
			const deduped = deduplicateCommRows(fetchedRows);
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
			const comms = c().repos.comms.listByAgent(agentId, limit * 3);
			return { items: toCommViews(deduplicateCommRows(comms).slice(0, limit), c) };
		},
	);
}
