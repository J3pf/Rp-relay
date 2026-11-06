import { envelope, type NotifyCategory, type PushPromptBody } from "@j3pf/rp-protocol";
import type { Logger } from "pino";
import { ulid } from "ulid";
import type { Ctx } from "../context.js";
import type { DeviceRow, PromptRow } from "../db/repos/index.js";
import { HOUR, MINUTE } from "../util/time.js";
import { APNS_BAD_TOKEN, type ApnsSender, BAD_DEVICE_TOKEN, fitApnsCollapseId } from "./apns.js";
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
	apns: "sent" | "failed" | "off";
	error?: string;
}

const TTL_PROMPT = HOUR;
const TTL_OTHER = 10 * MINUTE;
const MAX_BODY_BYTES = 3000;
const APNS_MAX_BODY_BYTES = 2900;

/**
 * Fits the serialized body to its channel budget. Preserve the legacy trim order (message, options, title), then
 * clip remaining strings in fixed order (detail, preview, agentLabel, machineContext, machineName, then sorted keys);
 * if structured fields still overflow, drop optional fields in that same fixed order before any remaining keys.
 */
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
	if (size() <= maxBytes) return out as T;

	const clone = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(clone);
		if (value && typeof value === "object")
			return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clone(nested)]));
		return value;
	};
	for (const key of Object.keys(out)) out[key] = clone(out[key]);

	type StringRef = { get: () => string; set: (value: string) => void };
	const collectStrings = (value: unknown, set: (next: unknown) => void, refs: StringRef[]): void => {
		if (typeof value === "string") {
			refs.push({ get: () => value, set: (next) => set(next) });
		} else if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				collectStrings(value[index], (next) => (value[index] = next), refs);
			}
		} else if (value && typeof value === "object") {
			for (const key of Object.keys(value).sort()) {
				collectStrings(
					(value as Record<string, unknown>)[key],
					(next) => ((value as Record<string, unknown>)[key] = next),
					refs,
				);
			}
		}
	};
	const clipOrder = ["detail", "preview", "agentLabel", "machineContext", "machineName", ...Object.keys(out).sort()];
	for (const key of new Set(clipOrder)) {
		if (size() <= maxBytes) break;
		const refs: StringRef[] = [];
		collectStrings(out[key], (next) => (out[key] = next), refs);
		for (const ref of refs) {
			if (size() <= maxBytes) break;
			const chars = Array.from(ref.get());
			let low = 0;
			let high = chars.length;
			let best: string | undefined;
			while (low <= high) {
				const mid = Math.floor((low + high) / 2);
				const candidate = `${chars.slice(0, mid).join("")}${mid < chars.length ? "…" : ""}`;
				ref.set(candidate);
				if (size() <= maxBytes) {
					best = candidate;
					low = mid + 1;
				} else high = mid - 1;
			}
			ref.set(best ?? "");
		}
	}

	if (size() > maxBytes) {
		const optionalOrder = [
			"detail",
			"preview",
			"agentLabel",
			"machineContext",
			"machineName",
			"title",
			"message",
			"options",
		];
		const required = new Set(["promptId", "agentId", "pushId", "machineId", "kind", "category"]);
		for (const key of new Set([...optionalOrder, ...Object.keys(out).sort()])) {
			if (size() <= maxBytes) break;
			if (!required.has(key)) delete out[key];
		}
		for (const key of Object.keys(out).sort()) {
			if (size() <= maxBytes) break;
			delete out[key];
		}
	}
	return out as T;
}

export function buildApnsPayload(pushKey: Buffer, kind: PushKindName, body: Record<string, unknown>) {
	const enc = encryptPush(pushKey, fitBody(body, APNS_MAX_BODY_BYTES));
	return {
		aps: {
			"mutable-content": 1,
			alert: { title: "RemotePi", body: "Tienes una notificación pendiente" },
		},
		v: "1",
		k: kind,
		...enc,
	};
}

export class PushDispatcher {
	private fcm: FcmSender | null;
	private apns: ApnsSender | null;

	constructor(
		private c: () => Ctx,
		private log: Logger,
		fcm: FcmSender | null = null,
		apns: ApnsSender | null = null,
	) {
		this.fcm = fcm;
		this.apns = apns;
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
		if (repos.agents.get(p.agent_id)?.archived_at != null) return;
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
		this.c().repos.outbox.dropPromptDeliveries(p.id, Date.now());
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
		if (!a || a.archived_at !== null || !m) return;
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
		if (!a || a.archived_at !== null || !m) return;
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
		if (!a || a.archived_at !== null || !m) return;
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
		let quiet: QuietHours | null = null;
		if (machine?.quiet_hours) {
			try {
				quiet = JSON.parse(machine.quiet_hours) as QuietHours;
			} catch {
				quiet = null;
			}
		}
		// "terminado" sólo si ningún dispositivo tiene la app en primer plano viendo ese agente (PLAN-RELAY §5.5)
		if (target?.category === "settled" && target.agentId && hub.devicesViewing(target.agentId).size > 0) return [];
		const eligible: DeviceRow[] = [];
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
			eligible.push(d);
		}
		return Promise.all(eligible.map((d) => this.deliver(d, kind, ref, body, now)));
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
		const res: PushResult = { deviceId: d.id, direct: "off", fcm: "off", apns: "off" };
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

		if (this.apns && d.apns_token) {
			try {
				const apnsConfig = this.c().config.apns;
				const environment = d.apns_env ?? apnsConfig?.env ?? "production";
				await this.apns.send({
					host: environment === "sandbox" ? "api.development.push.apple.com" : "api.push.apple.com",
					token: d.apns_token,
					payload: buildApnsPayload(d.push_key, kind, { ...body, pushId }),
					headers: {
						topic: apnsConfig?.bundleId ?? "",
						collapseId: fitApnsCollapseId(ref),
						pushType: "alert",
						priority: kind === "prompt" || kind === "test" ? 10 : 5,
					},
				});
				res.apns = "sent";
			} catch (e) {
				res.apns = "failed";
				const err = e as { code?: string; status?: number; message?: string };
				res.error ??= err.message;
				if (err.code === APNS_BAD_TOKEN || err.code === BAD_DEVICE_TOKEN || err.status === 410) {
					repos.devices.clearApns(d.id);
					this.log.info({ deviceId: d.id, status: err.status }, "token APNs no registrado: eliminado");
				} else this.log.warn({ deviceId: d.id, code: err.code }, "fallo al enviar APNs");
			}
		}
		return res;
	}

	/** Al conectarse un canal directo: reenvía lo pendiente (los prompts ya resueltos y los agentes archivados se descartan). */
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
			} else if (row.ref_id) {
				// settled / error / terminal_wait: el `ref_id` es el agentId, y un agente archivado ya no notifica.
				if (repos.agents.get(row.ref_id)?.archived_at != null) {
					repos.outbox.ack(row.push_id, deviceId, now);
					continue;
				}
			}
			let parsedBody: unknown;
			try {
				parsedBody = JSON.parse(row.body);
			} catch {
				repos.outbox.ack(row.push_id, deviceId, now);
				continue;
			}
			if (send(envelope("push.notify", { pushId: row.push_id, k: row.kind, body: parsedBody }))) n++;
		}
		return n;
	}

	ackDirect(deviceId: string, pushId: string): void {
		this.c().repos.outbox.ack(pushId, deviceId, Date.now());
	}
}
