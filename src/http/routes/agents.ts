import { AgentMessageReq, Id, PromptAnswerReq } from "@j3pf/rp-protocol";
import { Type } from "@sinclair/typebox";
import type { Ctx } from "../../context.js";
import { RelayError } from "../../util/errors.js";
import type { HttpAuth } from "../auth.js";
import type { TypeBoxFastifyInstance } from "../server.js";

const IdParams = Type.Object({ id: Type.String() });

export function registerAgents(app: TypeBoxFastifyInstance, c: () => Ctx, auth: HttpAuth): void {
	app.get(
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

	app.delete("/v1/agents/:id", { schema: { params: IdParams }, preHandler: auth.device }, async (req) => {
		c().agents.purge(req.params.id);
		return { ok: true };
	});

	app.get("/v1/agents", { preHandler: auth.device }, async () => ({ agents: c().summaries.allAgents() }));

	app.post(
		"/v1/agents/:id/messages",
		{ schema: { params: IdParams, body: AgentMessageReq }, preHandler: auth.device },
		async (req) => {
			const ack = await c().messages.send(req.device!.id, {
				...req.body,
				agentId: req.params.id,
			});
			return ack;
		},
	);

	app.get(
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

	app.post(
		"/v1/prompts/:id/answer",
		{ schema: { params: IdParams, body: PromptAnswerReq }, preHandler: auth.device },
		async (req, reply) => {
			const r = c().prompts.answer(req.params.id, req.body.answer, req.device!.id);
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
