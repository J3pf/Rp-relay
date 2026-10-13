import { MachinePatch, NotifyPrefs, PushChannelReq } from "@j3pf/rp-protocol";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../context.js";
import type { DeviceRow } from "../../db/repos/index.js";
import type { MachinePatchRow } from "../../db/repos/machines.js";
import { parsePrefs } from "../../push/prefs.js";
import { RelayError } from "../../util/errors.js";
import type { HttpAuth } from "../auth.js";

const present = (d: DeviceRow, me: string, live: boolean) => ({
	deviceId: d.id,
	name: d.name,
	createdAt: d.created_at,
	lastSeenAt: d.last_seen_at,
	revoked: d.revoked_at !== null,
	current: d.id === me,
	direct: d.direct_enabled === 1,
	fcm: d.fcm_token !== null,
	connected: live,
});

export function registerDevices(app: FastifyInstance, c: () => Ctx, auth: HttpAuth): void {
	app.put("/v1/devices/me/push", { schema: { body: PushChannelReq }, preHandler: auth.device }, async (req) => {
		const b = req.body as { fcmToken?: string | null; direct: boolean };
		c().repos.devices.setPush(req.device!.id, b.fcmToken, b.direct);
		return { ok: true };
	});

	app.post("/v1/devices/me/push-test", { preHandler: auth.device }, async (req) => {
		const results = await c().dispatcher.test(req.device!.id);
		return { ok: results.some((r) => r.direct !== "off" || r.fcm === "sent"), results };
	});

	app.put("/v1/devices/me/prefs", { schema: { body: NotifyPrefs }, preHandler: auth.device }, async (req) => {
		c().repos.devices.setPrefs(req.device!.id, req.body);
		return { ok: true };
	});
	app.get("/v1/devices/me/prefs", { preHandler: auth.device }, async (req) => parsePrefs(req.device!.notify_prefs));

	app.get("/v1/devices", { preHandler: auth.device }, async (req) => {
		const { repos, hub } = c();
		return { devices: repos.devices.list().map((d) => present(d, req.device!.id, hub.appsOfDevice(d.id).length > 0)) };
	});

	app.delete<{ Params: { id: string } }>("/v1/devices/:id", { preHandler: auth.device }, async (req) => {
		if (!c().entities.revokeDevice(req.params.id)) throw new RelayError("not_found", "dispositivo no encontrado");
		return { ok: true };
	});
}

export function registerMachines(app: FastifyInstance, c: () => Ctx, auth: HttpAuth): void {
	app.get("/v1/machines", { preHandler: auth.device }, async () => ({ machines: c().summaries.allMachines() }));

	app.delete<{ Params: { id: string } }>("/v1/machines/:id", { preHandler: auth.device }, async (req) => {
		if (!c().entities.revokeMachine(req.params.id)) throw new RelayError("not_found", "PC no encontrada");
		return { ok: true };
	});

	app.patch<{ Params: { id: string } }>(
		"/v1/machines/:id",
		{ schema: { body: MachinePatch }, preHandler: auth.device },
		async (req) => {
			if (!c().entities.patchMachine(req.params.id, req.body as MachinePatchRow)) {
				throw new RelayError("not_found", "PC no encontrada");
			}
			const m = c().repos.machines.get(req.params.id)!;
			return c().summaries.machine(m);
		},
	);
}
