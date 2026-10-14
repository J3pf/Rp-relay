import {
	type AgentEvent,
	type AgentHello,
	type AgentSnapshot,
	envelope,
	isDroppableEvent,
	isPersistedEvent,
} from "@j3pf/rp-protocol";
import type { Ctx } from "../context.js";
import type { MachineRow } from "../db/repos/index.js";
import type { AgentConn } from "../ws/conn.js";

export function previewOf(e: any): string | null {
	const m = e?.message;
	if (m?.role !== "assistant") return null;
	const c = m.content;
	const text =
		typeof c === "string"
			? c
			: Array.isArray(c)
				? c
						.filter((b: any) => b?.type === "text")
						.map((b: any) => String(b.text ?? ""))
						.join(" ")
				: "";
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return null;
	return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

const modelOf = (m: any): string | null => {
	if (!m) return null;
	if (typeof m === "string") return m;
	if (m.provider && m.id) return `${m.provider}/${m.id}`;
	return m.id ?? null;
};

export class AgentService {
	private graceTimers = new Map<string, NodeJS.Timeout>();

	constructor(private c: () => Ctx) {}

	/** Tras `agent.hello` validado: registra la conexión, responde `agent.welcome` y reconcilia prompts. */
	connect(conn: AgentConn, machine: MachineRow, h: AgentHello, reqId?: string): void {
		const { repos, hub, prompts, publisher, hosts } = this.c();
		const now = Date.now();
		this.clearGrace(h.agentId);
		const { row, epochChanged, previousSeq } = repos.agents.upsertFromHello(machine.id, h, now);
		conn.agentId = h.agentId;
		conn.instance = h.instance;
		conn.epoch = h.epoch;
		conn.lastSeq = epochChanged ? 0 : previousSeq;
		repos.machines.touch(machine.id, now);
		hub.registerAgent(conn as AgentConn & { agentId: string });

		const pendingAnswers = repos.prompts.pendingAnswers(h.agentId).map((p) => ({
			promptId: p.id,
			answer: JSON.parse(p.answer ?? "{}"),
			deviceId: p.answered_by_device ?? undefined,
		}));
		conn.send(
			envelope(
				"agent.welcome",
				{ serverTime: now, lastSeq: epochChanged ? null : row.last_seq, pendingAnswers, relayId: repos.meta.relayId() },
				reqId ? { re: reqId } : {},
			),
		);

		this.c().log.info(
			{
				agentId: h.agentId,
				machineId: machine.id,
				transport: conn.transport,
				epochChanged,
				openPrompts: h.openPrompts?.length ?? 0,
			},
			"agente conectado",
		);
		prompts.reconcile(h.agentId, h.openPrompts ?? []);
		hosts.onAgentHello(machine.id, h);
		publisher.agent(h.agentId);
		publisher.machine(machine.id);
	}

	onSnapshot(conn: AgentConn, s: AgentSnapshot): void {
		const { repos, publisher } = this.c();
		if (!conn.agentId) return;
		if (s.epoch !== conn.epoch) this.switchEpoch(conn, s.epoch);
		repos.events.putSnapshot(conn.agentId, s.epoch, s.seq, { entries: s.entries, truncated: s.truncated ?? false });
		conn.lastSeq = Math.max(conn.lastSeq, s.seq);
		repos.agents.setSeq(conn.agentId, s.seq);
		// los suscriptores que esperaban un historial sin snapshot pueden pedirlo de nuevo; avisamos con agents.update
		publisher.agent(conn.agentId);
	}

	private switchEpoch(conn: AgentConn, epoch: string): void {
		if (!conn.agentId) return;
		const { repos } = this.c();
		repos.agents.resetEpoch(conn.agentId, epoch);
		conn.epoch = epoch;
		conn.lastSeq = 0;
	}

	onEvent(conn: AgentConn, ev: AgentEvent): void {
		const { repos, hub, dispatcher, publisher } = this.c();
		const agentId = conn.agentId;
		if (!agentId) return;
		if (ev.epoch !== conn.epoch) this.switchEpoch(conn, ev.epoch);
		if (ev.seq <= conn.lastSeq) return; // reenvío (al menos una vez): ya visto
		conn.lastSeq = ev.seq;
		const e = ev.e as { type: string; [k: string]: unknown };
		const now = Date.now();
		let agentChanged = false;

		if (isPersistedEvent(e.type)) {
			repos.events.insert(agentId, ev.epoch, ev.seq, now, e.type, e);
			repos.agents.setSeq(agentId, ev.seq);
		}
		switch (e.type) {
			case "message_end": {
				const pv = previewOf(e);
				if (pv) {
					repos.agents.setPreview(agentId, pv);
					agentChanged = true;
				}
				break;
			}
			case "session_info_changed": {
				const name = (e.name ?? e.sessionName) as string | undefined;
				if (typeof name === "string") {
					repos.agents.setSession(agentId, name);
					agentChanged = true;
				}
				break;
			}
			case "model_select": {
				const m = modelOf(e.model);
				if (m) {
					repos.agents.setModel(agentId, m);
					agentChanged = true;
				}
				break;
			}
			case "thinking_level_select": {
				const lvl = (e.level ?? e.thinking) as string | undefined;
				if (typeof lvl === "string") repos.agents.setThinking(agentId, lvl);
				break;
			}
			case "agent_settled": {
				if (!e.aborted) dispatcher.settled(agentId, repos.agents.get(agentId)?.last_preview ?? null);
				break;
			}
			case "terminal_wait": {
				const title = typeof e.title === "string" ? e.title : null;
				const active = e.active === true;
				hub.broadcastApps(envelope("terminal_wait", { agentId, kind: e.kind as string | undefined, title, active }));
				if (active) dispatcher.terminalWait(agentId, title);
				break;
			}
		}
		repos.agents.touch(agentId, now);

		const out = envelope("agent.event", { agentId, epoch: ev.epoch, seq: ev.seq, e });
		const droppable = isDroppableEvent(e.type) || e.type === "tool_execution_update";
		for (const app of hub.subscribers(agentId)) hub.sendApp(app, out, droppable);
		if (agentChanged) publisher.agent(agentId);
	}

	onStatus(conn: AgentConn, d: { status: string; detail?: string | null }): void {
		const { repos, dispatcher, publisher } = this.c();
		if (!conn.agentId) return;
		const prev = repos.agents.get(conn.agentId)?.status;
		repos.agents.setStatus(conn.agentId, d.status, d.detail ?? null);
		if (d.status === "error" && prev !== "error") dispatcher.agentError(conn.agentId, d.detail ?? null);
		publisher.agent(conn.agentId);
	}

	onStatuses(conn: AgentConn, items: Record<string, string | null>): void {
		const { repos, publisher } = this.c();
		if (!conn.agentId) return;
		const raw = items["gentle:mode"];
		let mode: string | null = null;
		if (typeof raw === "string") {
			const m = /(AUTO|NORMAL|YOLO)/i.exec(raw);
			mode = m ? m[1]!.toLowerCase() : "unknown";
		}
		repos.agents.setStatuses(conn.agentId, items, mode);
		publisher.agent(conn.agentId);
	}

	/** Cierre de la conexión del agente. */
	disconnect(conn: AgentConn): void {
		const { repos, hub, publisher, config } = this.c();
		const agentId = conn.agentId;
		if (!agentId) return;
		if (!hub.unregisterAgent(conn)) return; // fue reemplazada por otra conexión: nada que hacer
		this.c().log.info({ agentId, machineId: conn.machineId }, "agente desconectado");
		repos.agents.setSeq(agentId, conn.lastSeq);
		repos.agents.setOffline(agentId, Date.now());
		publisher.agent(agentId);
		publisher.machine(conn.machineId);
		// los prompts abiertos se conservan una ventana de gracia por si el plugin reconecta
		if (repos.prompts.openForAgent(agentId).length > 0) this.armGrace(agentId, config.limits.promptGraceSeconds * 1000);
	}

	armGrace(agentId: string, ms: number): void {
		this.clearGrace(agentId);
		const t = setTimeout(() => {
			this.graceTimers.delete(agentId);
			const { hub, prompts } = this.c();
			if (hub.agents.has(agentId)) return;
			prompts.cancelOpenOfAgent(agentId);
		}, ms);
		t.unref();
		this.graceTimers.set(agentId, t);
	}

	private clearGrace(agentId: string): void {
		const t = this.graceTimers.get(agentId);
		if (t) clearTimeout(t);
		this.graceTimers.delete(agentId);
	}

	/** Al arrancar el relay: todos quedan offline y los prompts abiertos arrancan su ventana de gracia. */
	boot(): void {
		const { repos, config } = this.c();
		repos.agents.setAllOffline(Date.now());
		const ids = new Set(repos.prompts.list(["open"]).map((p) => p.agent_id));
		for (const id of ids) this.armGrace(id, config.limits.promptGraceSeconds * 1000);
	}

	forget(agentId: string): boolean {
		const { repos, hub, publisher, messages } = this.c();
		const a = repos.agents.get(agentId);
		if (!a || hub.agents.has(agentId)) return false;
		this.clearGrace(agentId);
		repos.agents.delete(agentId);
		messages.forget(agentId);
		publisher.agentRemoved(agentId);
		publisher.machine(a.machine_id);
		return true;
	}

	dispose(): void {
		for (const t of this.graceTimers.values()) clearTimeout(t);
		this.graceTimers.clear();
	}
}
