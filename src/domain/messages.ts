import { type Attachment, envelope, type UserMessageAck } from "@j3pf/rp-protocol";
import { ulid } from "ulid";
import type { Ctx } from "../context.js";
import { RelayError } from "../util/errors.js";

export interface SendUserMessage {
	agentId: string;
	clientMsgId: string;
	text: string;
	attachments?: Attachment[];
	delivery?: "auto" | "steer" | "followUp";
	method?: "auto" | "api" | "interactive" | "herdr";
	asCommand?: boolean;
}

const KEEP = 500;

/** Enrutamiento de mensajes de usuario con idempotencia por `clientMsgId` (RESILIENCIA §3.2). */
export class MessageService {
	private done = new Map<string, Map<string, UserMessageAck>>();
	private pending = new Map<string, Promise<UserMessageAck>>();
	private waiters = new Map<string, { resolve: (a: UserMessageAck) => void; timer: NodeJS.Timeout }>();

	constructor(private c: () => Ctx) {}

	private key(agentId: string, clientMsgId: string) {
		return `${agentId}\u0000${clientMsgId}`;
	}

	async send(deviceId: string, m: SendUserMessage): Promise<UserMessageAck> {
		const { repos, hub, config } = this.c();
		const agent = repos.agents.get(m.agentId);
		if (!agent) throw new RelayError("not_found", "agente desconocido");
		const cached = this.done.get(m.agentId)?.get(m.clientMsgId);
		if (cached) return cached;
		const k = this.key(m.agentId, m.clientMsgId);
		const inflight = this.pending.get(k);
		if (inflight) return inflight;

		const conn = hub.agents.get(m.agentId);
		if (!conn) throw new RelayError("agent_offline", "el agente no está conectado");

		for (const att of m.attachments ?? []) {
			const blob = repos.blobs.get(att.blobId);
			if (!blob || blob.expires_at <= Date.now())
				throw new RelayError("not_found", `adjunto ${att.blobId} no existe o caducó`);
			if (blob.uploaded_by !== deviceId)
				throw new RelayError("unauthorized", `no tienes permisos sobre el adjunto ${att.blobId}`);
			repos.blobs.grant(att.blobId, agent.machine_id);
		}

		const p = new Promise<UserMessageAck>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(k);
				this.pending.delete(k);
				reject(new RelayError("agent_timeout", "el agente no confirmó el mensaje a tiempo"));
			}, config.limits.userMessageTimeoutMs);
			timer.unref();
			this.waiters.set(k, { resolve, timer });
		});
		this.pending.set(k, p);
		const ok = conn.send(
			envelope(
				"user.message",
				{
					clientMsgId: m.clientMsgId,
					deviceId,
					text: m.text,
					attachments: m.attachments ?? [],
					delivery: m.delivery ?? "auto",
					method: m.method ?? "auto",
					asCommand: m.asCommand ?? false,
				},
				{ id: ulid() },
			),
		);
		if (!ok) {
			const w = this.waiters.get(k);
			if (w) clearTimeout(w.timer);
			this.waiters.delete(k);
			this.pending.delete(k);
			throw new RelayError("agent_offline", "no se pudo entregar al agente");
		}
		return p;
	}

	/** `user.message.ack` del plugin. */
	onAck(agentId: string, ack: UserMessageAck): void {
		const k = this.key(agentId, ack.clientMsgId);
		let per = this.done.get(agentId);
		if (!per) {
			per = new Map();
			this.done.set(agentId, per);
		}
		per.set(ack.clientMsgId, ack);
		while (per.size > KEEP) per.delete(per.keys().next().value!);
		const w = this.waiters.get(k);
		this.waiters.delete(k);
		this.pending.delete(k);
		if (w) {
			clearTimeout(w.timer);
			w.resolve(ack);
		}
	}

	abort(agentId: string): void {
		const { hub } = this.c();
		const conn = hub.agents.get(agentId);
		if (!conn) throw new RelayError("agent_offline", "el agente no está conectado");
		conn.send(envelope("agent.abort", {}));
	}

	forget(agentId: string): void {
		this.done.delete(agentId);
	}

	dispose(): void {
		for (const w of this.waiters.values()) clearTimeout(w.timer);
		this.waiters.clear();
		this.pending.clear();
	}
}
