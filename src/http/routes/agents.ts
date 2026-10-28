import { AgentMessageReq, type Answer as AnswerT, Id, PromptAnswerReq } from "@j3pf/rp-protocol";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../context.js";
import { RelayError } from "../../util/errors.js";
import type { HttpAuth } from "../auth.js";

export function registerAgents(app: FastifyInstance, c: () => Ctx, auth: HttpAuth): void {
	app.get<{ Querystring: { machineId?: string; before?: number; limit?: number } }>(
		"/v1/agents/archived",
		{
			schema: {
				querystring: Type.Object({
					machineId: Type.Optional(Id),
					before: Type.Optional(Type.Number()),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
				}),
			},
			preHandler: auth.device,
		},
		async (req) => c().agents.listArchived(req.query),
	);

	app.delete<{ Params: { id: string } }>("/v1/agents/:id", { preHandler: auth.device }, async (req) => {
		c().agents.purge(req.params.id);
		return { ok: true };
	});

	app.get("/v1/agents", { preHandler: auth.device }, async () => ({ agents: c().summaries.allAgents() }));

	app.post<{ Params: { id: string } }>(
		"/v1/agents/:id/messages",
		{ schema: { body: AgentMessageReq }, preHandler: auth.device },
		async (req) => {
			const ack = await c().messages.send(req.device!.id, {
				...(req.body as object),
				agentId: decodeURIComponent(req.params.id),
			} as never);
			return ack;
		},
	);

	app.get<{ Querystring: { state?: string } }>(
		"/v1/prompts",
		{ schema: { querystring: Type.Object({ state: Type.Optional(Type.String()) }) }, preHandler: auth.device },
		async (req) => {
			const { repos, summaries } = c();
			const states = (req.query.state ?? "open").split(",").map((s) => s.trim());
			const valid = states.filter((s): s is "open" | "answered" | "resolved" | "cancelled" | "expired" =>
				["open", "answered", "resolved", "cancelled", "expired"].includes(s),
			);
			if (valid.length === 0) throw new RelayError("bad_request", "state inválido");
			return { prompts: summaries.prompts(repos.prompts.list(valid)) };
		},
	);

	app.post<{ Params: { id: string } }>(
		"/v1/prompts/:id/answer",
		{ schema: { body: PromptAnswerReq }, preHandler: auth.device },
		async (req, reply) => {
			const r = c().prompts.answer(req.params.id, (req.body as { answer: AnswerT }).answer, req.device!.id);
			if (r.ok) return r.queued ? { ok: true, reason: "agent_offline_queued" } : { ok: true };
			if (r.reason === "not_found") throw new RelayError("not_found", "pregunta no encontrada");
			return reply.code(409).send({
				ok: false,
				reason: "already_resolved",
				error: { code: "conflict", message: "la pregunta ya fue resuelta" },
			});
		},
	);
}
