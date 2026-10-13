import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { bearer, safeEqual } from "../../auth/tokens.js";
import { adminTokenPath } from "../../config.js";
import type { Ctx } from "../../context.js";
import { RelayError } from "../../util/errors.js";

/**
 * API de administración para el CLI (`rp-relay revoke|push test|machines set` contra un relay en marcha).
 * Se autentica con `dataDir/admin.token` (0600) y se rechaza si la petición llega a través de un proxy
 * (cabecera `X-Forwarded-For`), de modo que no es alcanzable desde Internet aunque Caddy publique el resto.
 */
export function registerAdmin(app: FastifyInstance, c: () => Ctx): void {
	let adminToken: string | null = null;
	const load = (): string | null => {
		if (adminToken) return adminToken;
		try {
			adminToken = readFileSync(adminTokenPath(c().config), "utf8").trim();
		} catch {
			adminToken = null;
		}
		return adminToken;
	};
	const guard = async (req: { headers: Record<string, unknown> }) => {
		if (req.headers["x-forwarded-for"] || req.headers.forwarded)
			throw new RelayError("unauthorized", "no disponible a través de proxy");
		const tok = load();
		const given = bearer(req.headers.authorization as string | undefined);
		if (!tok || !given || !safeEqual(tok, given))
			throw new RelayError("unauthorized", "token de administración inválido");
	};

	app.get("/admin/status", { preHandler: guard as never }, async () => {
		const { hub, repos } = c();
		return {
			agentsOnline: hub.agents.size,
			apps: hub.apps.size,
			hosts: hub.hosts.size,
			devices: repos.devices.active().length,
			machines: repos.machines.list().length,
			fcm: c().dispatcher.fcmEnabled,
		};
	});

	app.post(
		"/admin/push-test",
		{ schema: { body: Type.Object({ deviceId: Type.Optional(Type.String()) }) }, preHandler: guard as never },
		async (req) => ({ results: await c().dispatcher.test((req.body as { deviceId?: string }).deviceId) }),
	);

	app.post(
		"/admin/revoke",
		{
			schema: {
				body: Type.Object({ kind: Type.Union([Type.Literal("device"), Type.Literal("machine")]), id: Type.String() }),
			},
			preHandler: guard as never,
		},
		async (req) => {
			const b = req.body as { kind: "device" | "machine"; id: string };
			const ok = b.kind === "device" ? c().entities.revokeDevice(b.id) : c().entities.revokeMachine(b.id);
			if (!ok) throw new RelayError("not_found", "no encontrado o ya revocado");
			return { ok: true };
		},
	);

	app.post<{ Params: { id: string } }>(
		"/admin/machines/:id",
		{
			schema: {
				body: Type.Object({
					name: Type.Optional(Type.String()),
					context: Type.Optional(Type.String()),
					color: Type.Optional(Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" })),
				}),
			},
			preHandler: guard as never,
		},
		async (req) => {
			if (!c().entities.patchMachine(req.params.id, req.body as never))
				throw new RelayError("not_found", "PC no encontrada");
			return { ok: true };
		},
	);
}
