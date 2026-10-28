import {
	type AgentHello,
	type Envelope,
	ErrorCode,
	envelope,
	errorEnvelope,
	type MachineQuota,
} from "@j3pf/rp-protocol";
import { ulid } from "ulid";
import type { Ctx } from "../context.js";
import type { AppConn, HostConn } from "../ws/conn.js";

const INITIAL_PROMPT_TTL_MS = 60_000;

type HostRequestResult = { ok: true; d: any } | { ok: false; code: string; message: string };

interface PendingReq {
	conn?: AppConn;
	machineId: string;
	reqEnvId: string | undefined;
	timer: NodeJS.Timeout;
	resolve?: (result: HostRequestResult) => void;
	initialPrompt?: string;
}

interface HeldPrompt {
	text: string;
	expires: number;
}

/** Multiplicador del tiempo de espera por tipo (crear un agente tarda más que listar carpetas). */
const HOST_FORWARD: Record<string, number> = {
	"host.list_dirs": 1,
	"host.herdr_layout": 1,
	"host.herdr_close": 1,
	"host.spawn": 2,
	"host.kill": 1,
	"host.git_diff": 1,
	"host.git_discard": 1,
};

/** `rp-host` (PROTOCOLO §9): enrutamiento `host.*` app ⇄ host e `initialPrompt` retenido 60 s. */
export class HostService {
	private pending = new Map<string, PendingReq>();
	/** `machineId\0spawnId` → texto inicial a entregar al primer `agent.hello` con ese spawnId */
	private held = new Map<string, HeldPrompt>();
	/** hello de un agente con spawnId visto antes de que el host confirmara `host.spawned` */
	private unclaimed = new Map<string, { agentId: string; expires: number }>();

	constructor(private c: () => Ctx) {}

	// ---- conexión del host ----
	onHostHello(
		conn: HostConn,
		hello: { hostname: string; roots: string[]; quotas?: MachineQuota[]; [k: string]: unknown },
	): void {
		const { repos, hub, publisher } = this.c();
		this.c().log.info({ machineId: conn.machineId, hostname: hello.hostname }, "rp-host conectado");
		repos.machines.setHostInfo(conn.machineId, hello);
		repos.machines.setQuotas(conn.machineId, Array.isArray(hello.quotas) ? hello.quotas : null);
		repos.machines.touch(conn.machineId, Date.now());
		hub.registerHost(conn);
		publisher.host(conn.machineId);
		publisher.machine(conn.machineId);
	}

	onHostQuotas(conn: HostConn, body: { quotas: MachineQuota[] }): void {
		const { repos, publisher } = this.c();
		this.c().log.info({ machineId: conn.machineId, count: body.quotas?.length ?? 0 }, "rp-host actualizó cuotas");
		repos.machines.setQuotas(conn.machineId, body.quotas);
		repos.machines.touch(conn.machineId, Date.now());
		publisher.machine(conn.machineId);
	}

	onHostClose(conn: HostConn): void {
		const { hub, publisher, repos } = this.c();
		if (!hub.unregisterHost(conn)) return;
		this.cancelPendingForMachine(conn.machineId);
		if (!repos.db.open) return;
		publisher.host(conn.machineId);
		publisher.machine(conn.machineId);
	}

	onMachineRevoked(machineId: string): void {
		this.cancelPendingForMachine(machineId);
		const prefix = `${machineId}\u0000`;
		for (const k of this.held.keys()) if (k.startsWith(prefix)) this.held.delete(k);
		for (const k of this.unclaimed.keys()) if (k.startsWith(prefix)) this.unclaimed.delete(k);
	}

	private cancelPendingForMachine(machineId: string): void {
		for (const [id, p] of this.pending) {
			if (p.machineId !== machineId) continue;
			clearTimeout(p.timer);
			this.pending.delete(id);
			if (p.resolve) p.resolve({ ok: false, code: ErrorCode.HostOffline, message: "el host se desconectó" });
			else p.conn?.send(errorEnvelope(ErrorCode.HostOffline, "el host se desconectó", p.reqEnvId));
		}
	}

	// ---- app → host ----
	forward(app: AppConn, env: Envelope): void {
		const { hub, repos } = this.c();
		const d = (env.d ?? {}) as { machineId?: string; initialPrompt?: string };
		const machineId = d.machineId;
		const reply = (code: string, msg: string) => app.send(errorEnvelope(code, msg, env.id));
		if (!machineId) return void reply(ErrorCode.BadRequest, "falta machineId");
		const m = repos.machines.get(machineId);
		if (!m || m.revoked_at) return void reply(ErrorCode.NotFound, "PC desconocida");
		const host = hub.hosts.get(machineId);
		if (!host) return void reply(ErrorCode.HostOffline, "rp-host no está conectado en esa PC");

		const id = ulid();
		const timer = setTimeout(
			() => {
				this.pending.delete(id);
				app.send(errorEnvelope(ErrorCode.Timeout, "el host no respondió a tiempo", env.id));
			},
			(HOST_FORWARD[env.t] ?? 1) * this.c().config.limits.hostRequestTimeoutMs,
		);
		timer.unref();
		const req: PendingReq = { conn: app, machineId, reqEnvId: env.id, timer };
		if (env.t === "host.spawn" && typeof d.initialPrompt === "string" && d.initialPrompt)
			req.initialPrompt = d.initialPrompt;
		this.pending.set(id, req);
		// el host no necesita el texto inicial: lo entrega el relay al agente
		const body = { ...(env.d as object) } as Record<string, unknown>;
		if (env.t === "host.spawn") delete body.initialPrompt;
		if (!host.send(envelope(env.t, body, { id }))) {
			clearTimeout(timer);
			this.pending.delete(id);
			reply(ErrorCode.HostOffline, "no se pudo enviar al host");
		}
	}

	/** Sends an RPC initiated by the relay and resolves every failure as a result. */
	request(machineId: string, t: string, d: any): Promise<HostRequestResult> {
		return new Promise((resolve) => {
			let id: string | undefined;
			let timer: NodeJS.Timeout | undefined;
			try {
				const host = this.c().hub.hosts.get(machineId);
				if (!host || host.closed) {
					resolve({ ok: false, code: ErrorCode.HostOffline, message: "rp-host no está conectado en esa PC" });
					return;
				}
				id = ulid();
				timer = setTimeout(
					() => {
						this.pending.delete(id!);
						resolve({ ok: false, code: ErrorCode.Timeout, message: "el host no respondió a tiempo" });
					},
					(HOST_FORWARD[t] ?? 1) * this.c().config.limits.hostRequestTimeoutMs,
				);
				timer.unref();
				this.pending.set(id, { machineId, reqEnvId: undefined, timer, resolve });
				if (!host.send(envelope(t, d, { id }))) {
					clearTimeout(timer);
					this.pending.delete(id);
					resolve({ ok: false, code: ErrorCode.HostOffline, message: "no se pudo enviar al host" });
				}
			} catch {
				if (timer) clearTimeout(timer);
				if (id) this.pending.delete(id);
				resolve({ ok: false, code: ErrorCode.HostOffline, message: "no se pudo enviar al host" });
			}
		});
	}

	// ---- host → app ----
	onHostReply(conn: HostConn, env: Envelope): void {
		if (!env.re) return;
		const p = this.pending.get(env.re);
		if (!p || p.machineId !== conn.machineId) return;
		clearTimeout(p.timer);
		this.pending.delete(env.re);
		if (p.resolve) {
			if (env.t === "error") {
				const error = env.d as { code?: unknown; message?: unknown };
				p.resolve({
					ok: false,
					code: typeof error?.code === "string" ? error.code : ErrorCode.Internal,
					message: typeof error?.message === "string" ? error.message : "error interno",
				});
			} else p.resolve({ ok: true, d: env.d });
			return;
		}
		if (env.t === "host.spawned" && p.initialPrompt) {
			const spawnId = (env.d as { spawnId?: string }).spawnId;
			if (spawnId) this.holdInitialPrompt(conn.machineId, spawnId, p.initialPrompt);
		}
		p.conn?.send({ ...env, re: p.reqEnvId ?? env.re });
	}

	private holdInitialPrompt(machineId: string, spawnId: string, text: string): void {
		const k = `${machineId}\u0000${spawnId}`;
		const seen = this.unclaimed.get(k);
		if (seen && seen.expires > Date.now()) {
			this.unclaimed.delete(k);
			this.deliverInitial(seen.agentId, text);
			return;
		}
		this.held.set(k, { text, expires: Date.now() + INITIAL_PROMPT_TTL_MS });
	}

	/** `agent.hello` con `spawnId`: entrega el `initialPrompt` retenido (o recuerda el hello unos segundos). */
	onAgentHello(machineId: string, h: AgentHello): void {
		const spawnId = h.spawnId;
		if (!spawnId) return;
		const k = `${machineId}\u0000${spawnId}`;
		const held = this.held.get(k);
		if (held) {
			this.held.delete(k);
			if (held.expires > Date.now()) this.deliverInitial(h.agentId, held.text);
			return;
		}
		this.unclaimed.set(k, { agentId: h.agentId, expires: Date.now() + INITIAL_PROMPT_TTL_MS });
	}

	private deliverInitial(agentId: string, text: string): void {
		const { messages, log } = this.c();
		messages
			.send("relay", { agentId, clientMsgId: ulid(), text, delivery: "auto", method: "auto" })
			.catch((e) => log.warn({ agentId, err: (e as Error).message }, "no se pudo entregar el initialPrompt"));
	}

	sweep(now = Date.now()): void {
		for (const [k, v] of this.held) if (v.expires <= now) this.held.delete(k);
		for (const [k, v] of this.unclaimed) if (v.expires <= now) this.unclaimed.delete(k);
	}

	dispose(): void {
		for (const p of this.pending.values()) clearTimeout(p.timer);
		this.pending.clear();
	}
}
