import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthResult } from "../auth/middleware.js";
import type { Ctx } from "../context.js";
import type { DeviceRow, MachineRow } from "../db/repos/index.js";
import { RelayError } from "../util/errors.js";

const TOUCH_THROTTLE_MS = 30_000;

declare module "fastify" {
	interface FastifyRequest {
		device?: DeviceRow;
		machine?: MachineRow;
		_rpDevice?: AuthResult<DeviceRow>;
		_rpMachine?: AuthResult<MachineRow>;
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
			const r = req._rpDevice ?? c().auth.device(req.headers);
			if (!r.ok) fail(r.reason);
			else {
				req.device = r.row;
				const now = Date.now();
				if (now - (r.row.last_seen_at ?? 0) >= TOUCH_THROTTLE_MS) {
					c().repos.devices.touch(r.row.id, now);
				}
			}
		},
		async machine(req) {
			const r = req._rpMachine ?? c().auth.machine(req.headers);
			if (!r.ok) fail(r.reason);
			else req.machine = r.row;
		},
		async deviceOrMachine(req) {
			const d = req._rpDevice ?? c().auth.device(req.headers);
			if (d.ok) {
				req.device = d.row;
				return;
			}
			const m = req._rpMachine ?? c().auth.machine(req.headers);
			if (m.ok) {
				req.machine = m.row;
				return;
			}
			fail(d.reason === "revoked" || m.reason === "revoked" ? "revoked" : "invalid");
		},
	};
}
