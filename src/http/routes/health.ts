import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../context.js";

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

export function registerHealth(app: FastifyInstance, _c: () => Ctx): void {
	app.get("/healthz", async () => ({ ok: true, version: VERSION, uptime: Math.round(process.uptime()) }));
}
