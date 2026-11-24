import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Ctx } from "../../context.js";
import type { TypeBoxFastifyInstance } from "../server.js";

function resolveVersion(): string {
	try {
		const pkgPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

export const VERSION = resolveVersion();

export function registerHealth(app: TypeBoxFastifyInstance, c: () => Ctx): void {
	app.get("/healthz", async (_req, reply) => {
		const uptime = Math.round(process.uptime());
		try {
			c().repos.db.prepare("SELECT 1").get();
			return { ok: true, version: VERSION, uptime };
		} catch (e) {
			c().log.warn({ err: e instanceof Error ? e.message : String(e) }, "fallo en comprobación de salud de SQLite");
			return reply.code(503).send({ ok: false, version: VERSION, uptime });
		}
	});
}
