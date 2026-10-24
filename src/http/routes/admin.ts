import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
	const load = (force = false): string | null => {
		if (adminToken && !force) return adminToken;
		try {
			adminToken = readFileSync(adminTokenPath(c().config), "utf8").trim();
		} catch {
			adminToken = null;
		}
		return adminToken;
	};
	const failedAttempts = new Map<string, { count: number; resetAt: number }>();
	const guard = async (req: FastifyRequest) => {
		if (
			req.headers["x-forwarded-for"] ||
			req.headers.forwarded ||
			req.headers["x-real-ip"] ||
			req.headers["cf-connecting-ip"] ||
			req.headers["true-client-ip"]
		)
			throw new RelayError("unauthorized", "no disponible a través de proxy");
		const remote = req.raw?.socket?.remoteAddress;
		if (remote) {
			const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
			if (!isLoopback) throw new RelayError("unauthorized", "acceso administrativo restringido a loopback");
		}
		const ipKey = remote ?? "local";
		const now = Date.now();
		const entry = failedAttempts.get(ipKey);
		if (entry && entry.resetAt > now && entry.count >= 10) {
			throw new RelayError("rate_limited", "demasiados intentos fallidos de administración");
		}
		const given = bearer(req.headers.authorization);
		let tok = load();
		if (tok && given && !safeEqual(tok, given)) {
			tok = load(true);
		}
		if (!tok || !given || !safeEqual(tok, given)) {
			const cur = entry && entry.resetAt > now ? entry.count + 1 : 1;
			if (failedAttempts.size >= 100 && !failedAttempts.has(ipKey)) failedAttempts.clear();
			failedAttempts.set(ipKey, { count: cur, resetAt: now + 60_000 });
			throw new RelayError("unauthorized", "token de administración inválido");
		}
		failedAttempts.delete(ipKey);
	};

	app.get("/admin/status", { preHandler: guard }, async () => {
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

	app.post<{ Body: { deviceId?: string } }>(
		"/admin/push-test",
		{ schema: { body: Type.Object({ deviceId: Type.Optional(Type.String()) }) }, preHandler: guard },
		async (req) => ({ results: await c().dispatcher.test(req.body.deviceId) }),
	);

	app.post<{ Body: { kind: "device" | "machine"; id: string } }>(
		"/admin/revoke",
		{
			schema: {
				body: Type.Object({ kind: Type.Union([Type.Literal("device"), Type.Literal("machine")]), id: Type.String() }),
			},
			preHandler: guard,
		},
		async (req) => {
			const b = req.body;
			const ok = b.kind === "device" ? c().entities.revokeDevice(b.id) : c().entities.revokeMachine(b.id);
			if (!ok) throw new RelayError("not_found", "no encontrado o ya revocado");
			return { ok: true };
		},
	);

	app.post<{ Params: { id: string }; Body: { name?: string; context?: string; color?: string } }>(
		"/admin/machines/:id",
		{
			schema: {
				body: Type.Object({
					name: Type.Optional(Type.String()),
					context: Type.Optional(Type.String()),
					color: Type.Optional(Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" })),
				}),
			},
			preHandler: guard,
		},
		async (req) => {
			if (!c().entities.patchMachine(req.params.id, req.body)) throw new RelayError("not_found", "PC no encontrada");
			return { ok: true };
		},
	);
}
