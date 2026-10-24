import { CloseCode, type Envelope } from "@j3pf/rp-protocol";
import type { AgentConn, AppConn, HostConn } from "./conn.js";

export interface HubLimits {
	maxBufferedBytes: number;
	hardBufferedBytes: number;
}

/** Registro en memoria de las conexiones vivas (PLAN-RELAY §5.1). */
export class Hub {
	private static readonly EMPTY_SUBS: readonly AppConn[] = [];
	readonly agents = new Map<string, AgentConn>();
	readonly hosts = new Map<string, HostConn>();
	readonly apps = new Set<AppConn>();
	private subsByAgent = new Map<string, Set<AppConn>>();
	private meshSubs = new Map<AppConn, string | null>();
	private meshSubscriberListeners = new Set<() => void>();

	constructor(private limits: HubLimits) {}

	onMeshSubscribersChanged(listener: () => void): void {
		this.meshSubscriberListeners.add(listener);
	}

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
		this.unsubscribeMesh(conn);
		for (const agentId of conn.subs) {
			const set = this.subsByAgent.get(agentId);
			if (set) {
				set.delete(conn);
				if (set.size === 0) this.subsByAgent.delete(agentId);
			}
		}
	}
	subscribe(conn: AppConn, agentId: string): void {
		conn.subs.add(agentId);
		if (conn.ready && conn.mode === "foreground") {
			let set = this.subsByAgent.get(agentId);
			if (!set) {
				set = new Set();
				this.subsByAgent.set(agentId, set);
			}
			set.add(conn);
		}
	}
	unsubscribe(conn: AppConn, agentId: string): void {
		conn.subs.delete(agentId);
		const set = this.subsByAgent.get(agentId);
		if (set) {
			set.delete(conn);
			if (set.size === 0) this.subsByAgent.delete(agentId);
		}
	}
	subscribeMesh(conn: AppConn, machineId: string | null): void {
		this.meshSubs.set(conn, machineId);
		this.notifyMeshSubscribersChanged();
	}
	unsubscribeMesh(conn: AppConn): void {
		if (!this.meshSubs.delete(conn)) return;
		this.notifyMeshSubscribersChanged();
	}
	hasMeshSubscribers(): boolean {
		return this.meshSubs.size > 0;
	}
	meshSubscribers(): Map<AppConn, string | null> {
		return new Map(this.meshSubs);
	}
	private notifyMeshSubscribersChanged(): void {
		for (const listener of this.meshSubscriberListeners) listener();
	}
	appsOfDevice(deviceId: string, mode?: AppConn["mode"]): AppConn[] {
		return [...this.apps].filter((a) => a.deviceId === deviceId && (!mode || a.mode === mode));
	}
	readyApps(mode?: AppConn["mode"]): AppConn[] {
		return [...this.apps].filter((a) => a.ready && (!mode || a.mode === mode));
	}
	subscribers(agentId: string): Iterable<AppConn> {
		return this.subsByAgent.get(agentId) ?? Hub.EMPTY_SUBS;
	}
	/** Dispositivos con la app en primer plano mirando ese agente. */
	devicesViewing(agentId: string): Set<string> {
		const out = new Set<string>();
		for (const a of this.subscribers(agentId)) out.add(a.deviceId);
		return out;
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
		const host = this.hosts.get(machineId);
		if (host) {
			this.unregisterHost(host);
			host.close(code, reason);
		}
	}
	closeDevice(deviceId: string, code: number, reason: string): void {
		for (const c of this.appsOfDevice(deviceId)) {
			this.removeApp(c);
			c.close(code, reason);
		}
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
