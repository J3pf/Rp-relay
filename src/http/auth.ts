import type { FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../context.js";
import type { DeviceRow, MachineRow } from "../db/repos/index.js";
import { RelayError } from "../util/errors.js";

declare module "fastify" {
	interface FastifyRequest {
		device?: DeviceRow;
		machine?: MachineRow;
	}
}

type Hook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface HttpAuth {
	device: Hook;
	machine: Hook;
	deviceOrMachine: Hook;
}

/** Hooks `preHandler` de autenticación Bearer (token de dispositivo o de PC). */
export function makeHttpAuth(c: () => Ctx): HttpAuth {
	const fail = (reason: string): never => {
		throw new RelayError("unauthorized", reason === "revoked" ? "token revocado" : "token inválido o ausente");
	};
	return {
		async device(req) {
			const r = c().auth.device(req.headers);
			if (!r.ok) fail(r.reason);
			else {
				req.device = r.row;
				c().repos.devices.touch(r.row.id, Date.now());
			}
		},
		async machine(req) {
			const r = c().auth.machine(req.headers);
			if (!r.ok) fail(r.reason);
			else req.machine = r.row;
		},
		async deviceOrMachine(req) {
			const d = c().auth.device(req.headers);
			if (d.ok) {
				req.device = d.row;
				return;
			}
			const m = c().auth.machine(req.headers);
			if (m.ok) {
				req.machine = m.row;
				return;
			}
			fail(d.reason === "revoked" || m.reason === "revoked" ? "revoked" : "invalid");
		},
	};
}
