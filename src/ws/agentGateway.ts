import {
	type AgentEvent,
	type AgentHello,
	type AgentSnapshot,
	CloseCode,
	type Envelope,
	ErrorCode,
	errorEnvelope,
	MIN_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	type PromptOpen,
	type PromptResolved,
	parseFrame,
	type UserMessageAck,
	validateMessage,
} from "@j3pf/rp-protocol";
import type { WebSocket } from "ws";
import type { Ctx } from "../context.js";
import type { MachineRow } from "../db/repos/index.js";
import { type AgentConn, startHeartbeat, WsConn } from "./conn.js";
import { LongPollConn } from "./longpoll.js";

/** Máquina de estados del protocolo plugin → relay; la comparten el transporte WS y el long-poll. */
export class AgentSession {
	private helloDone = false;
	constructor(
		private c: () => Ctx,
		readonly conn: AgentConn,
		readonly machine: MachineRow,
	) {}

	get ready(): boolean {
		return this.helloDone;
	}

	/** Procesa un sobre ya parseado. Devuelve false si la sesión debe cerrarse. */
	handle(env: Envelope): void {
		const { log } = this.c();
		if (env.v < MIN_PROTOCOL_VERSION || env.v > PROTOCOL_VERSION) {
			this.conn.send(
				errorEnvelope(
					ErrorCode.BadRequest,
					`versión de protocolo ${env.v} no soportada (el relay habla v${PROTOCOL_VERSION})`,
					env.id,
				),
			);
			this.conn.close(CloseCode.IncompatibleVersion, "incompatible protocol version");
			return;
		}
		if (!this.helloDone && env.t !== "agent.hello") {
			this.conn.send(errorEnvelope(ErrorCode.BadRequest, "el primer mensaje debe ser agent.hello", env.id));
			this.conn.close(CloseCode.InvalidFrame, "hello required");
			return;
		}
		const v = validateMessage("up", env);
		if (!v.ok) {
			this.conn.send(errorEnvelope(ErrorCode.BadRequest, v.message, env.id));
			if (env.t === "agent.hello") this.conn.close(CloseCode.InvalidFrame, "invalid hello");
			return;
		}
		if (log.isLevelEnabled("trace")) log.trace({ agentId: this.conn.agentId, t: env.t, d: env.d }, "plugin → relay");
		else if (log.isLevelEnabled("debug")) {
			log.debug(
				{ agentId: this.conn.agentId, t: env.t, bytes: JSON.stringify(env.d ?? null).length },
				"plugin → relay",
			);
		}
		try {
			this.dispatch(env);
		} catch (e) {
			log.error(
				{ err: (e as Error).message, t: env.t, agentId: this.conn.agentId },
				"error procesando mensaje del agente",
			);
			this.conn.send(errorEnvelope(ErrorCode.Internal, "error interno", env.id));
		}
	}

	private dispatch(env: Envelope): void {
		const ctx = this.c();
		const { agents, prompts, messages } = ctx;
		switch (env.t) {
			case "agent.hello": {
				const h = env.d as AgentHello;
				if (this.helloDone && this.conn.agentId !== h.agentId) {
					this.conn.close(CloseCode.InvalidFrame, "agentId changed");
					return;
				}
				if (!h.agentId.startsWith(`${this.machine.id}:`)) {
					this.conn.send(errorEnvelope(ErrorCode.Unauthorized, "agentId no pertenece a esta PC", env.id));
					this.conn.close(CloseCode.InvalidFrame, "agentId mismatch");
					return;
				}
				agents.connect(this.conn, this.machine, h, env.id);
				this.helloDone = true;
				return;
			}
			case "agent.snapshot":
				agents.onSnapshot(this.conn, env.d as AgentSnapshot);
				return;
			case "agent.event":
				agents.onEvent(this.conn, env.d as AgentEvent);
				return;
			case "agent.status":
				agents.onStatus(this.conn, env.d as { status: string; detail?: string | null });
				return;
			case "agent.statuses":
				agents.onStatuses(this.conn, (env.d as { items: Record<string, string | null> }).items);
				return;
			case "prompt.open": {
				const p = env.d as PromptOpen;
				prompts.onPluginOpen(this.conn.agentId!, { ...p, agentId: this.conn.agentId! });
				return;
			}
			case "prompt.resolved":
				prompts.onPluginResolved(this.conn.agentId!, env.d as PromptResolved);
				return;
			case "prompt.ack": {
				const a = env.d as { promptId: string; accepted: boolean };
				prompts.onAck(this.conn.agentId!, a.promptId, a.accepted);
				return;
			}
			case "user.message.ack":
				messages.onAck(this.conn.agentId!, env.d as UserMessageAck);
				return;
		}
	}

	onClose(): void {
		if (this.conn.agentId) this.c().agents.disconnect(this.conn);
	}
}

/** Gateway WS `/ws/agent`. */
export function handleAgentSocket(c: () => Ctx, socket: WebSocket, machine: MachineRow): void {
	const conn = Object.assign(new WsConn(socket), {
		transport: "ws" as const,
		agentId: null as string | null,
		machineId: machine.id,
		instance: null as string | null,
		epoch: null as string | null,
		lastSeq: 0,
	});
	const session = new AgentSession(c, conn, machine);
	const { log } = c();
	startHeartbeat(socket);
	const helloTimer = setTimeout(() => {
		if (!session.ready) conn.close(CloseCode.InvalidFrame, "hello timeout");
	}, c().config.limits.helloTimeoutMs);
	helloTimer.unref();

	socket.on("message", (data, isBinary) => {
		if (isBinary) {
			conn.send(errorEnvelope(ErrorCode.BadRequest, "sólo se admiten frames de texto"));
			conn.close(CloseCode.InvalidFrame, "binary frame");
			return;
		}
		const parsed = parseFrame(data as Buffer);
		if (!parsed.ok) {
			conn.send(
				errorEnvelope(parsed.reason === "too_large" ? ErrorCode.TooLarge : ErrorCode.BadRequest, parsed.message),
			);
			conn.close(CloseCode.InvalidFrame, parsed.reason);
			return;
		}
		session.handle(parsed.env);
	});
	socket.on("close", () => {
		clearTimeout(helloTimer);
		session.onClose();
	});
	socket.on("error", (e) => log.debug({ err: e.message }, "error de socket de agente"));
}

/** Sesiones long-poll (transporte de respaldo): una por `agentId`, con expiración por inactividad. */
export class LongPollRegistry {
	private sessions = new Map<string, { session: AgentSession; conn: LongPollConn }>();
	private sweeper: NodeJS.Timeout;

	constructor(
		private c: () => Ctx,
		private idleMs = 60_000,
	) {
		this.sweeper = setInterval(() => this.sweep(), 10_000);
		this.sweeper.unref();
	}

	/** Un `POST /v1/agent/send`: procesa el lote; un `agent.hello` crea/reemplaza la sesión. */
	send(machine: MachineRow, messages: unknown[]): { accepted: number; rejected: number } {
		let accepted = 0;
		let rejected = 0;
		// el lote puede mezclar agentes de la PC (un plugin = un agente); se agrupa por la sesión que corresponda
		let current: { session: AgentSession; conn: LongPollConn } | undefined;
		for (const raw of messages) {
			const parsed = parseFrame(JSON.stringify(raw));
			if (!parsed.ok) {
				rejected++;
				continue;
			}
			const env = parsed.env;
			if (env.t === "agent.hello") {
				const h = env.d as { agentId?: string };
				const agentId = typeof h?.agentId === "string" ? h.agentId : null;
				if (!agentId) {
					rejected++;
					continue;
				}
				const conn = new LongPollConn(machine.id);
				const session = new AgentSession(this.c, conn, machine);
				current = { session, conn };
				session.handle(env);
				if (session.ready) this.sessions.set(agentId, current);
				accepted++;
				continue;
			}
			const target = current ?? this.byAgentHint(machine.id, env);
			if (!target) {
				rejected++;
				continue;
			}
			target.conn.touch();
			target.session.handle(env);
			accepted++;
		}
		return { accepted, rejected };
	}

	private byAgentHint(machineId: string, _env: Envelope) {
		const mine = [...this.sessions.values()].filter((s) => s.conn.machineId === machineId);
		return mine.length === 1 ? mine[0] : undefined;
	}

	get(agentId: string) {
		return this.sessions.get(agentId);
	}

	/** Retira la sesión (cerrada/reemplazada/inactiva) y notifica el cierre al dominio. */
	drop(agentId: string, entry: { session: AgentSession; conn: LongPollConn }): void {
		if (this.sessions.get(agentId) === entry) this.sessions.delete(agentId);
		entry.session.onClose();
	}

	private sweep(): void {
		const now = Date.now();
		for (const [id, e] of this.sessions) {
			if (e.conn.closed || now - e.conn.lastActivity > this.idleMs) {
				e.conn.close(CloseCode.Normal, "idle");
				this.drop(id, e);
			}
		}
	}

	dispose(): void {
		clearInterval(this.sweeper);
		for (const [id, e] of [...this.sessions]) {
			e.conn.close(CloseCode.ServiceRestart, "shutdown");
			this.drop(id, e);
		}
	}
}
