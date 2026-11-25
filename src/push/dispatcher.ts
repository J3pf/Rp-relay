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
const DEFAULT_PUSH_RETRY_DELAY_MS = 100;
const MAX_TRACKED_PROMPTS = 10_000;
const PUSH_ID_PLACEHOLDER = "0".repeat(26);
const FIT_BODY_CLIP_PRIORITY = ["detail", "preview", "agentLabel", "machineContext", "machineName"] as const;
const FIT_BODY_DROP_PRIORITY = [
	"detail",
	"preview",
	"agentLabel",
	"machineContext",
	"machineName",
	"title",
	"message",
	"options",
] as const;
const FIT_BODY_REQUIRED_KEYS = new Set(["promptId", "agentId", "pushId", "machineId", "kind", "category"]);

export interface PushDispatcherOptions {
	retryDelayMs?: number;
}

function isRetryableApnsError(err: { code?: string; status?: number }): boolean {
	if (err.code === "apns/timeout" || err.code === "apns/stream-closed") return true;
	const status = err.status ?? 0;
	return status === 429 || status >= 500;
}

function isRetryableFcmError(err: { code?: string; status?: number }): boolean {
	if (
		err.code === "messaging/internal-error" ||
		err.code === "messaging/server-unavailable" ||
		err.code === "messaging/timeout"
	) {
		return true;
	}
	const status = err.status ?? 0;
	return status === 429 || status >= 500;
}

function jitteredDelayMs(baseMs: number): number {
	if (baseMs <= 0) return 0;
	return Math.max(1, Math.round(baseMs * (0.5 + Math.random() * 0.5)));
}

async function sendWithRetry(
	send: () => Promise<void>,
	isRetryable: (err: { code?: string; status?: number }) => boolean,
	retryDelayMs: number,
): Promise<void> {
	try {
		await send();
	} catch (firstErr) {
		if (!isRetryable(firstErr as { code?: string; status?: number })) throw firstErr;
		const delay = jitteredDelayMs(retryDelayMs);
		if (delay > 0) {
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, delay);
				t.unref();
			});
		}
		await send();
	}
}

type StringRef = { get: () => string; set: (value: string) => void };

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

function applyLegacyTrim(out: Record<string, unknown>, maxBytes: number): void {
	if (typeof out.message === "string") {
		const over = serializedBytes(out) - maxBytes;
		const keep = Math.max(0, Buffer.byteLength(out.message) - over - 3);
		out.message = `${Buffer.from(out.message).subarray(0, keep).toString("utf8").replace(/�$/, "")}…`;
	}
	if (serializedBytes(out) > maxBytes && Array.isArray(out.options))
		out.options = (out.options as unknown[]).slice(0, 3);
	if (serializedBytes(out) > maxBytes && typeof out.title === "string") out.title = `${out.title.slice(0, 120)}…`;
}

function collectStringRefs(value: unknown, set: (next: unknown) => void, refs: StringRef[]): void {
	if (typeof value === "string") {
		refs.push({ get: () => value, set: (next) => set(next) });
	} else if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			collectStringRefs(value[index], (next) => (value[index] = next), refs);
		}
	} else if (value && typeof value === "object") {
		for (const key of Object.keys(value).sort()) {
			collectStringRefs(
				(value as Record<string, unknown>)[key],
				(next) => ((value as Record<string, unknown>)[key] = next),
				refs,
			);
		}
	}
}

function clipStringRefToBudget(out: Record<string, unknown>, ref: StringRef, maxBytes: number): void {
	const chars = Array.from(ref.get());
	let low = 0;
	let high = chars.length;
	let best: string | undefined;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = `${chars.slice(0, mid).join("")}${mid < chars.length ? "…" : ""}`;
		ref.set(candidate);
		if (serializedBytes(out) <= maxBytes) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	ref.set(best ?? "");
}

function clipBodyStrings(out: Record<string, unknown>, maxBytes: number): void {
	const clipOrder = [...FIT_BODY_CLIP_PRIORITY, ...Object.keys(out).sort()];
	for (const key of new Set(clipOrder)) {
		if (serializedBytes(out) <= maxBytes) break;
		const refs: StringRef[] = [];
		collectStringRefs(out[key], (next) => (out[key] = next), refs);
		for (const ref of refs) {
			if (serializedBytes(out) <= maxBytes) break;
			clipStringRefToBudget(out, ref, maxBytes);
		}
	}
}

function dropOverflowFields(out: Record<string, unknown>, maxBytes: number): void {
	for (const key of new Set([...FIT_BODY_DROP_PRIORITY, ...Object.keys(out).sort()])) {
		if (serializedBytes(out) <= maxBytes) break;
		if (!FIT_BODY_REQUIRED_KEYS.has(key)) delete out[key];
	}
	for (const key of Object.keys(out).sort()) {
		if (serializedBytes(out) <= maxBytes) break;
		delete out[key];
	}
}

/**
 * Fits the serialized body to its channel budget. Preserve the legacy trim order (message, options, title), then
 * clip remaining strings in fixed order (detail, preview, agentLabel, machineContext, machineName, then sorted keys);
 * if structured fields still overflow, drop optional fields in that same fixed order before any remaining keys.
 */
export function fitBody<T extends Record<string, unknown>>(body: T, maxBytes = MAX_BODY_BYTES): T {
	const out: Record<string, unknown> = { ...body };
	if (serializedBytes(out) <= maxBytes) return out as T;
	applyLegacyTrim(out, maxBytes);
	if (serializedBytes(out) <= maxBytes) return out as T;

	const cloned = structuredClone(out);
	clipBodyStrings(cloned, maxBytes);
	if (serializedBytes(cloned) > maxBytes) {
		dropOverflowFields(cloned, maxBytes);
	}
	return cloned as T;
}

function wrapApnsPayload(enc: { n: string; c: string }, kind: PushKindName) {
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

export function buildApnsPayload(pushKey: Buffer, kind: PushKindName, body: Record<string, unknown>) {
	return wrapApnsPayload(encryptPush(pushKey, fitBody(body, APNS_MAX_BODY_BYTES)), kind);
}

export class PushDispatcher {
	private fcm: FcmSender | null;
	private apns: ApnsSender | null;
	private retryDelayMs: number;
	private deliveredPromptDevices = new Map<string, Set<string>>();

	constructor(
		private c: () => Ctx,
		private log: Logger,
		fcm: FcmSender | null = null,
		apns: ApnsSender | null = null,
		opts: PushDispatcherOptions = {},
	) {
		this.fcm = fcm;
		this.apns = apns;
		this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_PUSH_RETRY_DELAY_MS;
	}

	setFcm(sender: FcmSender | null): void {
		this.fcm = sender;
	}
	get fcmEnabled(): boolean {
		return this.fcm !== null;
	}
	get apnsEnabled(): boolean {
		return this.apns !== null;
	}
	close(): void {
		this.deliveredPromptDevices.clear();
		this.apns?.close?.();
	}

	private recordPromptDelivery(promptId: string, devices: DeviceRow[]): void {
		let set = this.deliveredPromptDevices.get(promptId);
		if (set) {
			this.deliveredPromptDevices.delete(promptId);
		} else {
			set = new Set();
		}
		for (const d of devices) set.add(d.id);
		this.deliveredPromptDevices.set(promptId, set);
		while (this.deliveredPromptDevices.size > MAX_TRACKED_PROMPTS) {
			const oldest = this.deliveredPromptDevices.keys().next().value;
			if (oldest === undefined) break;
			this.deliveredPromptDevices.delete(oldest);
		}
	}

	// ---- eventos de dominio ----
	promptOpened(p: PromptRow): void {
		const { summaries, repos } = this.c();
		const agentRow = repos.agents.get(p.agent_id);
		if (!agentRow || agentRow.archived_at != null) return;
		const redacted = agentRow.redacted === 1;
		const prompt = summaries.prompt(p);
		const buttons = prompt.kind === "confirm" || (prompt.options?.length ?? 0) <= 3;
		const body: PushPromptBody & { pushId?: string; redacted?: boolean } = {
			promptId: p.id,
			agentId: p.agent_id,
			agentLabel: prompt.agentLabel,
			machineId: prompt.machineId,
			machineName: prompt.machineName,
			machineContext: prompt.machineContext,
			kind: prompt.kind,
			category: prompt.category,
			title: redacted ? prompt.agentLabel : prompt.title,
			message: redacted ? null : prompt.message ? prompt.message.slice(0, 500) : null,
			options:
				redacted || prompt.kind === "questionnaire" || !buttons
					? []
					: (prompt.options ?? []).slice(0, 3).map((o) => ({ id: o.id, label: o.label })),
			allowFreeText: redacted ? false : (prompt.allowFreeText ?? false),
			danger: prompt.danger,
			...(redacted ? { redacted: true } : {}),
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
		const delivered = this.deliveredPromptDevices.get(promptId);
		if (delivered) {
			const targets = excludeDevice ? [...delivered].filter((id) => id !== excludeDevice) : [...delivered];
			delivered.clear();
			if (targets.length === 0) return;
			void this.fanOut("cancel", promptId, { promptId }, null, { only: targets });
			return;
		}
		void this.fanOut("cancel", promptId, { promptId }, null, { exclude: excludeDevice ?? undefined });
	}

	private notifyAgentEvent(
		agentId: string,
		kind: "settled" | "error" | "terminal_wait",
		field: "preview" | "detail" | "title",
		value: string | null,
	): void {
		const { repos, summaries } = this.c();
		const a = repos.agents.get(agentId);
		const m = a ? repos.machines.get(a.machine_id) : undefined;
		if (!a || a.archived_at !== null || !m) return;
		const redacted = a.redacted === 1;
		void this.fanOut(
			kind,
			agentId,
			{
				agentId,
				agentLabel: summaries.agentLabel(a),
				[field]: redacted ? null : value,
				machineId: m.id,
				machineName: m.name,
				machineContext: m.context,
				...(redacted ? { redacted: true } : {}),
			},
			{ machineId: m.id, category: kind, agentId },
		);
	}

	settled(agentId: string, preview: string | null): void {
		this.notifyAgentEvent(agentId, "settled", "preview", preview);
	}

	agentError(agentId: string, detail: string | null): void {
		this.notifyAgentEvent(agentId, "error", "detail", detail);
	}

	terminalWait(agentId: string, title: string | null): void {
		this.notifyAgentEvent(agentId, "terminal_wait", "title", title);
	}

	terminalWaitCleared(agentId: string): void {
		this.c().repos.outbox.dropByRefAndKind(agentId, "terminal_wait", Date.now());
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
		if (kind === "prompt") this.recordPromptDelivery(ref, eligible);
		if (eligible.length === 0) return [];
		const preFitted = fitBody({ ...body, pushId: PUSH_ID_PLACEHOLDER }, MAX_BODY_BYTES);
		const preFittedApns =
			this.apns && eligible.some((d) => Boolean(d.apns_token)) ? fitBody(preFitted, APNS_MAX_BODY_BYTES) : null;
		return Promise.all(eligible.map((d) => this.deliver(d, kind, ref, preFitted, preFittedApns, now)));
	}

	private async deliver(
		d: DeviceRow,
		kind: PushKindName,
		ref: string,
		preFitted: Record<string, unknown>,
		preFittedApns: Record<string, unknown> | null,
		now: number,
	): Promise<PushResult> {
		const { repos, hub } = this.c();
		const pushId = ulid();
		const full = { ...preFitted, pushId };
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
			const fcm = this.fcm;
			const fcmToken = d.fcm_token;
			try {
				const enc = encryptPush(d.push_key, full);
				const fcmMsg = {
					token: fcmToken,
					data: { v: "1", k: kind, n: enc.n, c: enc.c },
					android: {
						priority: kind === "prompt" || kind === "test" ? ("high" as const) : ("normal" as const),
						ttl,
						collapseKey: ref,
					},
				};
				await sendWithRetry(() => fcm.send(fcmMsg), isRetryableFcmError, this.retryDelayMs);
				res.fcm = "sent";
			} catch (e) {
				res.fcm = "failed";
				const err = e as { code?: string; status?: number; message?: string };
				res.error = err.message;
				if (err.code === FCM_UNREGISTERED) {
					repos.devices.clearFcm(d.id);
					this.log.info({ deviceId: d.id }, "token FCM no registrado: eliminado");
				} else {
					this.log.warn(
						{ deviceId: d.id, code: err.code, status: err.status, err: err.message },
						"fallo al enviar FCM",
					);
				}
			}
		}

		if (this.apns && d.apns_token) {
			const apns = this.apns;
			const apnsToken = d.apns_token;
			try {
				const apnsConfig = this.c().config.apns;
				const environment = d.apns_env ?? apnsConfig?.env ?? "production";
				const apnsBody = preFittedApns ? { ...preFittedApns, pushId } : full;
				const apnsMsg = {
					host: (environment === "sandbox" ? "api.development.push.apple.com" : "api.push.apple.com") as
						| "api.push.apple.com"
						| "api.development.push.apple.com",
					token: apnsToken,
					payload: wrapApnsPayload(encryptPush(d.push_key, apnsBody), kind),
					headers: {
						topic: apnsConfig?.bundleId ?? "",
						collapseId: fitApnsCollapseId(ref),
						pushType: "alert",
						priority: kind === "prompt" || kind === "test" ? (10 as const) : (5 as const),
					},
				};
				await sendWithRetry(() => apns.send(apnsMsg), isRetryableApnsError, this.retryDelayMs);
				res.apns = "sent";
			} catch (e) {
				res.apns = "failed";
				const err = e as { code?: string; status?: number; message?: string };
				res.error ??= err.message;
				if (err.code === APNS_BAD_TOKEN || err.code === BAD_DEVICE_TOKEN || err.status === 410) {
					repos.devices.clearApns(d.id);
					this.log.info({ deviceId: d.id, status: err.status }, "token APNs no registrado: eliminado");
				} else {
					this.log.warn(
						{ deviceId: d.id, code: err.code, status: err.status, err: err.message },
						"fallo al enviar APNs",
					);
				}
			}
		}
		return res;
	}

	/** Al conectarse un canal directo: reenvía lo pendiente (los prompts ya resueltos y los agentes archivados se descartan). */
	flushDirect(deviceId: string, send: (msg: ReturnType<typeof envelope>) => boolean): number {
		const { repos } = this.c();
		const now = Date.now();
		const pending = repos.outbox.pendingFor(deviceId, now);
		if (pending.length === 0) return 0;
		const stalePushIds: string[] = [];
		const toSend: Array<{ pushId: string; kind: string; body: unknown }> = [];
		for (const row of pending) {
			if (row.kind === "prompt" && row.ref_id) {
				const p = repos.prompts.get(row.ref_id);
				if (p?.state !== "open") {
					stalePushIds.push(row.push_id);
					continue;
				}
			} else if (row.ref_id) {
				// settled / error / terminal_wait: el `ref_id` es el agentId, y un agente archivado ya no notifica.
				if (repos.agents.get(row.ref_id)?.archived_at != null) {
					stalePushIds.push(row.push_id);
					continue;
				}
			}
			let parsedBody: unknown;
			try {
				parsedBody = JSON.parse(row.body);
			} catch {
				stalePushIds.push(row.push_id);
				continue;
			}
			toSend.push({ pushId: row.push_id, kind: row.kind, body: parsedBody });
		}
		if (stalePushIds.length > 0) {
			repos.db.transaction(() => {
				for (const pushId of stalePushIds) repos.outbox.ack(pushId, deviceId, now);
			})();
		}
		let n = 0;
		for (const item of toSend) {
			if (send(envelope("push.notify", { pushId: item.pushId, k: item.kind, body: item.body }))) n++;
		}
		return n;
	}

	ackDirect(deviceId: string, pushId: string): void {
		this.c().repos.outbox.ack(pushId, deviceId, Date.now());
	}
}
