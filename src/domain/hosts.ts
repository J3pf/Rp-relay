import { type AgentHello, type Envelope, ErrorCode, envelope, errorEnvelope } from "@j3pf/rp-protocol";
import { ulid } from "ulid";
import type { Ctx } from "../context.js";
import type { AppConn, HostConn } from "../ws/conn.js";

const INITIAL_PROMPT_TTL_MS = 60_000;

interface PendingReq {
	conn: AppConn;
	machineId: string;
	reqEnvId: string | undefined;
	timer: NodeJS.Timeout;
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
	"host.spawn": 2,
	"host.kill": 1,
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
	onHostHello(conn: HostConn, hello: { hostname: string; roots: string[]; [k: string]: unknown }): void {
		const { repos, hub, publisher } = this.c();
		this.c().log.info({ machineId: conn.machineId, hostname: hello.hostname }, "rp-host conectado");
		repos.machines.setHostInfo(conn.machineId, hello);
		repos.machines.touch(conn.machineId, Date.now());
		hub.registerHost(conn);
		publisher.host(conn.machineId);
		publisher.machine(conn.machineId);
	}

	onHostClose(conn: HostConn): void {
		const { hub, publisher } = this.c();
		if (!hub.unregisterHost(conn)) return;
		for (const [id, p] of this.pending) {
			if (p.machineId !== conn.machineId) continue;
			clearTimeout(p.timer);
			this.pending.delete(id);
			p.conn.send(errorEnvelope(ErrorCode.HostOffline, "el host se desconectó", p.reqEnvId));
		}
		publisher.host(conn.machineId);
		publisher.machine(conn.machineId);
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

		const id = env.id ?? ulid();
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

	// ---- host → app ----
	onHostReply(conn: HostConn, env: Envelope): void {
		if (!env.re) return;
		const p = this.pending.get(env.re);
		if (!p || p.machineId !== conn.machineId) return;
		clearTimeout(p.timer);
		this.pending.delete(env.re);
		if (env.t === "host.spawned" && p.initialPrompt) {
			const spawnId = (env.d as { spawnId?: string }).spawnId;
			if (spawnId) this.holdInitialPrompt(conn.machineId, spawnId, p.initialPrompt);
		}
		p.conn.send({ ...env, re: p.reqEnvId ?? env.re });
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
