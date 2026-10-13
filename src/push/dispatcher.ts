import { envelope, type NotifyCategory, type PushPromptBody } from "@j3pf/rp-protocol";
import type { Logger } from "pino";
import { ulid } from "ulid";
import type { Ctx } from "../context.js";
import type { DeviceRow, PromptRow } from "../db/repos/index.js";
import { HOUR, MINUTE } from "../util/time.js";
import { encryptPush } from "./crypto.js";
import { FCM_UNREGISTERED, type FcmSender } from "./fcm.js";
import { parsePrefs, type QuietHours, shouldNotify } from "./prefs.js";

export type PushKindName = "prompt" | "cancel" | "settled" | "error" | "terminal_wait" | "test";

export interface PushTarget {
	machineId: string;
	category: NotifyCategory;
	danger?: "low" | "medium" | "high";
	/** `agentId` al que se refiere la notificación (para la supresión de "terminado" si se está viendo) */
	agentId?: string;
}

export interface PushResult {
	deviceId: string;
	direct: "sent" | "queued" | "off";
	fcm: "sent" | "failed" | "off";
	error?: string;
}

const TTL_PROMPT = HOUR;
const TTL_OTHER = 10 * MINUTE;
const MAX_BODY_BYTES = 3000;

/** Recorta el cuerpo para respetar el límite FCM de 4 KB tras cifrar/base64 (PROTOCOLO §8.1). */
export function fitBody<T extends Record<string, unknown>>(body: T, maxBytes = MAX_BODY_BYTES): T {
	const out: Record<string, unknown> = { ...body };
	const size = () => Buffer.byteLength(JSON.stringify(out));
	if (size() <= maxBytes) return out as T;
	if (typeof out.message === "string") {
		const over = size() - maxBytes;
		const keep = Math.max(0, Buffer.byteLength(out.message) - over - 3);
		out.message = `${Buffer.from(out.message).subarray(0, keep).toString("utf8").replace(/�$/, "")}…`;
	}
	if (size() > maxBytes && Array.isArray(out.options)) out.options = (out.options as unknown[]).slice(0, 3);
	if (size() > maxBytes && typeof out.title === "string") out.title = `${out.title.slice(0, 120)}…`;
	return out as T;
}

export class PushDispatcher {
	private fcm: FcmSender | null;

	constructor(
		private c: () => Ctx,
		private log: Logger,
		fcm: FcmSender | null = null,
	) {
		this.fcm = fcm;
	}

	setFcm(sender: FcmSender | null): void {
		this.fcm = sender;
	}
	get fcmEnabled(): boolean {
		return this.fcm !== null;
	}

	// ---- eventos de dominio ----
	promptOpened(p: PromptRow): void {
		const { summaries, repos } = this.c();
		const prompt = summaries.prompt(p);
		const buttons = prompt.kind === "confirm" || (prompt.options?.length ?? 0) <= 3;
		const body: PushPromptBody & { pushId?: string } = {
			promptId: p.id,
			agentId: p.agent_id,
			agentLabel: prompt.agentLabel,
			machineId: prompt.machineId,
			machineName: prompt.machineName,
			machineContext: prompt.machineContext,
			kind: prompt.kind,
			category: prompt.category,
			title: prompt.title,
			message: prompt.message ? prompt.message.slice(0, 500) : null,
			options:
				prompt.kind === "questionnaire" || !buttons
					? []
					: (prompt.options ?? []).slice(0, 3).map((o) => ({ id: o.id, label: o.label })),
			allowFreeText: prompt.allowFreeText ?? false,
			danger: prompt.danger,
		};
		repos.prompts.bumpPush(p.id);
		const category: NotifyCategory = prompt.category === "permission" ? "permission" : "question";
		void this.fanOut("prompt", p.id, body, {
			machineId: prompt.machineId,
			category,
			danger: prompt.danger,
			agentId: p.agent_id,
		});
	}

	/** Re-push de un prompt `danger=high` que sigue abierto. */
	promptRepush(p: PromptRow): void {
		this.promptOpened(p);
	}

	promptCancelled(promptId: string, excludeDevice?: string | null): void {
		const { repos } = this.c();
		repos.outbox.dropPromptDeliveries(promptId, Date.now());
		void this.fanOut("cancel", promptId, { promptId }, null, { exclude: excludeDevice ?? undefined });
	}

	settled(agentId: string, preview: string | null): void {
		const { repos, summaries } = this.c();
		const a = repos.agents.get(agentId);
		const m = a ? repos.machines.get(a.machine_id) : undefined;
		if (!a || !m) return;
		void this.fanOut(
			"settled",
			agentId,
			{
				agentId,
				agentLabel: summaries.agentLabel(a),
				preview,
				machineId: m.id,
				machineName: m.name,
				machineContext: m.context,
			},
			{ machineId: m.id, category: "settled", agentId },
		);
	}

	agentError(agentId: string, detail: string | null): void {
		const { repos, summaries } = this.c();
		const a = repos.agents.get(agentId);
		const m = a ? repos.machines.get(a.machine_id) : undefined;
		if (!a || !m) return;
		void this.fanOut(
			"error",
			agentId,
			{
				agentId,
				agentLabel: summaries.agentLabel(a),
				detail,
				machineId: m.id,
				machineName: m.name,
				machineContext: m.context,
			},
			{ machineId: m.id, category: "error", agentId },
		);
	}

	terminalWait(agentId: string, title: string | null): void {
		const { repos, summaries } = this.c();
		const a = repos.agents.get(agentId);
		const m = a ? repos.machines.get(a.machine_id) : undefined;
		if (!a || !m) return;
		void this.fanOut(
			"terminal_wait",
			agentId,
			{
				agentId,
				agentLabel: summaries.agentLabel(a),
				title,
				machineId: m.id,
				machineName: m.name,
				machineContext: m.context,
			},
			{ machineId: m.id, category: "terminal_wait", agentId },
		);
	}

	/** Notificación de prueba: ignora preferencias y devuelve el resultado por canal. */
	async test(deviceId?: string): Promise<PushResult[]> {
		const { repos } = this.c();
		const devices = deviceId
			? [repos.devices.get(deviceId)].filter((d): d is DeviceRow => !!d && !d.revoked_at)
			: repos.devices.active();
		return this.fanOut("test", "test", { message: "Notificación de prueba de rp-relay", relayTime: Date.now() }, null, {
			only: devices.map((d) => d.id),
		});
	}

	// ---- núcleo ----
	/** Nunca rechaza: un fallo de envío no debe tumbar el flujo de dominio que lo originó. */
	private async fanOut(
		kind: PushKindName,
		ref: string,
		body: Record<string, unknown>,
		target: PushTarget | null,
		opts: { exclude?: string; only?: string[] } = {},
	): Promise<PushResult[]> {
		try {
			return await this.fanOutInner(kind, ref, body, target, opts);
		} catch (e) {
			this.log.error({ err: (e as Error).message, kind, ref }, "fallo al despachar la notificación");
			return [];
		}
	}

	private async fanOutInner(
		kind: PushKindName,
		ref: string,
		body: Record<string, unknown>,
		target: PushTarget | null,
		opts: { exclude?: string; only?: string[] } = {},
	): Promise<PushResult[]> {
		const { repos, hub } = this.c();
		const now = Date.now();
		const machine = target ? repos.machines.get(target.machineId) : undefined;
		const quiet: QuietHours | null = machine?.quiet_hours ? (JSON.parse(machine.quiet_hours) as QuietHours) : null;
		// "terminado" sólo si ningún dispositivo tiene la app en primer plano viendo ese agente (PLAN-RELAY §5.5)
		if (target?.category === "settled" && target.agentId && hub.devicesViewing(target.agentId).size > 0) return [];
		const results: PushResult[] = [];
		for (const d of repos.devices.active()) {
			if (opts.only && !opts.only.includes(d.id)) continue;
			if (opts.exclude && d.id === opts.exclude) continue;
			if (target) {
				if (
					!shouldNotify({
						prefs: parsePrefs(d.notify_prefs),
						machineId: target.machineId,
						machineQuiet: quiet,
						category: target.category,
						danger: target.danger,
						now,
					})
				)
					continue;
			}
			results.push(await this.deliver(d, kind, ref, body, now));
		}
		return results;
	}

	private async deliver(
		d: DeviceRow,
		kind: PushKindName,
		ref: string,
		body: Record<string, unknown>,
		now: number,
	): Promise<PushResult> {
		const { repos, hub } = this.c();
		const pushId = ulid();
		const full = fitBody({ ...body, pushId });
		const res: PushResult = { deviceId: d.id, direct: "off", fcm: "off" };
		const ttl = kind === "prompt" ? TTL_PROMPT : TTL_OTHER;

		if (d.direct_enabled) {
			repos.outbox.insert({
				push_id: pushId,
				device_id: d.id,
				kind,
				ref_id: ref,
				body: JSON.stringify(full),
				created_at: now,
				expires_at: now + ttl,
			});
			const conns = hub.appsOfDevice(d.id, "direct").filter((c) => c.ready);
			let sent = false;
			for (const c of conns) if (c.send(envelope("push.notify", { pushId, k: kind, body: full }))) sent = true;
			res.direct = sent ? "sent" : "queued";
		}

		if (this.fcm && d.fcm_token) {
			try {
				const enc = encryptPush(d.push_key, full);
				await this.fcm.send({
					token: d.fcm_token,
					data: { v: "1", k: kind, n: enc.n, c: enc.c },
					android: { priority: kind === "prompt" || kind === "test" ? "high" : "normal", ttl, collapseKey: ref },
				});
				res.fcm = "sent";
			} catch (e) {
				res.fcm = "failed";
				const err = e as { code?: string; message?: string };
				res.error = err.message;
				if (err.code === FCM_UNREGISTERED) {
					repos.devices.clearFcm(d.id);
					this.log.info({ deviceId: d.id }, "token FCM no registrado: eliminado");
				} else this.log.warn({ deviceId: d.id, code: err.code }, "fallo al enviar FCM");
			}
		}
		return res;
	}

	/** Al conectarse un canal directo: reenvía lo pendiente (los prompts ya resueltos se descartan). */
	flushDirect(deviceId: string, send: (msg: ReturnType<typeof envelope>) => boolean): number {
		const { repos } = this.c();
		const now = Date.now();
		let n = 0;
		for (const row of repos.outbox.pendingFor(deviceId, now)) {
			if (row.kind === "prompt" && row.ref_id) {
				const p = repos.prompts.get(row.ref_id);
				if (p?.state !== "open") {
					repos.outbox.ack(row.push_id, deviceId, now);
					continue;
				}
			}
			if (send(envelope("push.notify", { pushId: row.push_id, k: row.kind, body: JSON.parse(row.body) }))) n++;
		}
		return n;
	}

	ackDirect(deviceId: string, pushId: string): void {
		this.c().repos.outbox.ack(pushId, deviceId, Date.now());
	}
}
