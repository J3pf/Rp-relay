import { CloseCode, type Envelope } from "@j3pf/rp-protocol";
import type { AgentConn, AppConn, HostConn } from "./conn.js";

export interface HubLimits {
	maxBufferedBytes: number;
	hardBufferedBytes: number;
}

/** Registro en memoria de las conexiones vivas (PLAN-RELAY §5.1). */
export class Hub {
	readonly agents = new Map<string, AgentConn>();
	readonly hosts = new Map<string, HostConn>();
	readonly apps = new Set<AppConn>();

	constructor(private limits: HubLimits) {}

	// ---- agentes ----
	/** Registra la conexión; si había otra del mismo agente se cierra con `4003`. */
	registerAgent(conn: AgentConn & { agentId: string }): AgentConn | undefined {
		const prev = this.agents.get(conn.agentId);
		this.agents.set(conn.agentId, conn);
		if (prev && prev !== conn) prev.close(CloseCode.Replaced, "replaced by newer connection");
		return prev && prev !== conn ? prev : undefined;
	}
	/** Devuelve true si `conn` era la conexión vigente del agente. */
	unregisterAgent(conn: AgentConn): boolean {
		if (!conn.agentId || this.agents.get(conn.agentId) !== conn) return false;
		this.agents.delete(conn.agentId);
		return true;
	}
	agentsOfMachine(machineId: string): AgentConn[] {
		return [...this.agents.values()].filter((a) => a.machineId === machineId);
	}

	// ---- hosts ----
	registerHost(conn: HostConn): HostConn | undefined {
		const prev = this.hosts.get(conn.machineId);
		this.hosts.set(conn.machineId, conn);
		if (prev && prev !== conn) prev.close(CloseCode.Replaced, "replaced by newer connection");
		return prev && prev !== conn ? prev : undefined;
	}
	unregisterHost(conn: HostConn): boolean {
		if (this.hosts.get(conn.machineId) !== conn) return false;
		this.hosts.delete(conn.machineId);
		return true;
	}

	// ---- apps ----
	addApp(conn: AppConn): void {
		this.apps.add(conn);
	}
	removeApp(conn: AppConn): void {
		this.apps.delete(conn);
	}
	appsOfDevice(deviceId: string, mode?: AppConn["mode"]): AppConn[] {
		return [...this.apps].filter((a) => a.deviceId === deviceId && (!mode || a.mode === mode));
	}
	readyApps(mode?: AppConn["mode"]): AppConn[] {
		return [...this.apps].filter((a) => a.ready && (!mode || a.mode === mode));
	}
	subscribers(agentId: string): AppConn[] {
		return [...this.apps].filter((a) => a.ready && a.mode === "foreground" && a.subs.has(agentId));
	}
	/** Dispositivos con la app en primer plano mirando ese agente. */
	devicesViewing(agentId: string): Set<string> {
		return new Set(this.subscribers(agentId).map((a) => a.deviceId));
	}

	/**
	 * Envía a una app aplicando contrapresión: bajo presión se descartan los eventos "droppable" (deltas) y
	 * si el consumidor no avanza en absoluto se cierra con 1013 para que reconecte y resincronice con `sinceSeq`.
	 */
	sendApp(conn: AppConn, env: Envelope, droppable = false): boolean {
		const buffered = conn.bufferedAmount;
		if (buffered > this.limits.hardBufferedBytes) {
			conn.close(CloseCode.TryAgainLater, "slow consumer");
			return false;
		}
		if (droppable && buffered > this.limits.maxBufferedBytes) return false;
		return conn.send(env);
	}

	broadcastApps(
		env: Envelope,
		opts: { mode?: AppConn["mode"]; droppable?: boolean; filter?: (c: AppConn) => boolean } = {},
	): number {
		let n = 0;
		for (const c of this.apps) {
			if (!c.ready) continue;
			if (opts.mode && c.mode !== opts.mode) continue;
			if (opts.filter && !opts.filter(c)) continue;
			if (this.sendApp(c, env, opts.droppable)) n++;
		}
		return n;
	}

	/** Corta todo lo de una PC (revocación): agentes, host. */
	closeMachine(machineId: string, code: number, reason: string): void {
		for (const c of this.agentsOfMachine(machineId)) {
			this.unregisterAgent(c);
			c.close(code, reason);
		}
		this.hosts.get(machineId)?.close(code, reason);
	}
	closeDevice(deviceId: string, code: number, reason: string): void {
		for (const c of this.appsOfDevice(deviceId)) c.close(code, reason);
	}

	/** Cierra todas las conexiones (cierre ordenado: 1012 = service restart). */
	closeAll(code: number, reason: string): void {
		for (const c of this.agents.values()) c.close(code, reason);
		for (const c of this.hosts.values()) c.close(code, reason);
		for (const c of this.apps) c.close(code, reason);
	}
	get size(): number {
		return this.agents.size + this.hosts.size + this.apps.size;
	}
}
