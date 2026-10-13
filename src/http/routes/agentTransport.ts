import { AgentSendReq } from "@j3pf/rp-protocol";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../../context.js";
import { RelayError } from "../../util/errors.js";
import type { LongPollRegistry } from "../../ws/agentGateway.js";
import type { HttpAuth } from "../auth.js";

const POLL_MS = 25_000;

/**
 * Transporte de respaldo long-poll del plugin (PROTOCOLO §7.1): el mismo protocolo del §4/§5 en lotes JSON.
 * `send` entrega al relay; todo lo que el relay envía al plugin (incluido `agent.welcome` y los `error`) sale por `poll`.
 */
export function registerAgentTransport(
	app: FastifyInstance,
	_c: () => Ctx,
	auth: HttpAuth,
	registry: LongPollRegistry,
): void {
	app.post("/v1/agent/send", { schema: { body: AgentSendReq }, preHandler: auth.machine }, async (req) => {
		return { ok: true, ...registry.send(req.machine!, req.body as unknown[]) };
	});

	type PollParams = { agentId: string; instance?: string; timeout?: number };
	const pollSchema = Type.Object({
		agentId: Type.String(),
		instance: Type.Optional(Type.String()),
		timeout: Type.Optional(Type.Integer({ minimum: 0, maximum: POLL_MS })),
	});
	const poll = async (req: FastifyRequest, reply: FastifyReply, p: PollParams) => {
		const entry = registry.get(p.agentId);
		if (!entry || entry.conn.machineId !== req.machine!.id) {
			throw new RelayError("not_found", "no hay sesión long-poll: envía agent.hello por /v1/agent/send");
		}
		if (p.instance && entry.conn.instance !== p.instance) {
			return reply.code(410).send({ error: { code: "conflict", message: "sesión reemplazada" }, closeCode: 4003 });
		}
		const ac = new AbortController();
		req.raw.on("close", () => ac.abort());
		const r = await entry.conn.poll(p.timeout ?? POLL_MS, ac.signal);
		if ("closed" in r) {
			registry.drop(p.agentId, entry);
			return reply
				.code(410)
				.send({ error: { code: "conflict", message: r.closed.reason || "sesión cerrada" }, closeCode: r.closed.code });
		}
		return { messages: r.messages };
	};
	// PROTOCOLO §7 lista `POST /v1/agent/poll`; GET con query string se admite por comodidad
	app.post("/v1/agent/poll", { schema: { body: pollSchema }, preHandler: auth.machine }, (req, reply) =>
		poll(req, reply, req.body as PollParams),
	);
	app.get("/v1/agent/poll", { schema: { querystring: pollSchema }, preHandler: auth.machine }, (req, reply) =>
		poll(req, reply, req.query as PollParams),
	);
}
