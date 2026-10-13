import { PairCodeRes, PairDeviceReq, PairDeviceRes, PairMachineReq, PairMachineRes } from "@j3pf/rp-protocol";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../context.js";
import type { HttpAuth } from "../auth.js";

export function registerPair(app: FastifyInstance, c: () => Ctx, auth: HttpAuth): void {
	// 5 intentos por minuto y por IP en el emparejamiento (ARQUITECTURA §6)
	const pairLimit = {
		rateLimit: {
			max: () => c().config.limits.pairAttemptsPerMinute,
			timeWindow: "1 minute",
			keyGenerator: (req: { ip: string }) => req.ip,
		},
	};
	app.post(
		"/v1/pair/device",
		{ schema: { body: PairDeviceReq, response: { 200: PairDeviceRes } }, config: pairLimit },
		async (req) => {
			const body = req.body as { code: string; name: string; fcmToken?: string | null };
			return c().pairing.pairDevice(body);
		},
	);

	app.post(
		"/v1/pair/machine",
		{ schema: { body: PairMachineReq, response: { 200: PairMachineRes } }, config: pairLimit },
		async (req) => {
			return c().pairing.pairMachine(req.body as { code: string; hostname: string; name?: string; context?: string });
		},
	);

	app.post(
		"/v1/pair/codes",
		{
			schema: {
				body: Type.Optional(Type.Object({ name: Type.Optional(Type.String()), context: Type.Optional(Type.String()) })),
				response: { 200: PairCodeRes },
			},
			preHandler: auth.device,
		},
		async (req) => {
			const meta = (req.body ?? {}) as { name?: string; context?: string };
			return c().pairing.createCode("machine", req.device!.id, meta);
		},
	);
}
