import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../context.js";

export const VERSION = "0.4.0";

export function registerHealth(app: FastifyInstance, _c: () => Ctx): void {
	app.get("/healthz", async () => ({ ok: true, version: VERSION, uptime: Math.round(process.uptime()) }));
}
