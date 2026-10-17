import {
	type AgentEvent,
	type AgentHello,
	type AgentSnapshot,
	CommEvent,
	envelope,
	isDroppableEvent,
	isPersistedEvent,
} from "@j3pf/rp-protocol";
import { Value } from "@sinclair/typebox/value";
import type { Ctx } from "../context.js";
import type { CommRow } from "../db/repos/comms.js";
import type { MachineRow } from "../db/repos/index.js";
import type { AgentConn } from "../ws/conn.js";
import { resolvePeerAgentId, resolvePeerAgentIdFromReply } from "./peerResolution.js";

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
		const { repos, hub, prompts, publisher, hosts, mesh } = this.c();
		const now = Date.now();
		this.clearGrace(h.agentId);
		const { row, epochChanged, previousSeq } = repos.agents.upsertFromHello(machine.id, h, now);
		this.resolveUnresolvedComms();
		conn.agentId = h.agentId;
		conn.instance = h.instance;
		conn.epoch = h.epoch;
		conn.lastSeq = epochChanged ? 0 : previousSeq;
		conn.lastTouchAt = now;
		repos.machines.touch(machine.id, now);
		hub.registerAgent(conn as AgentConn & { agentId: string });
		mesh.invalidate();

		const pendingAnswers = repos.prompts.pendingAnswers(h.agentId).flatMap((p) => {
			try {
				return [
					{
						promptId: p.id,
						answer: JSON.parse(p.answer ?? "{}"),
						deviceId: p.answered_by_device ?? undefined,
					},
				];
			} catch {
				return [];
			}
		});
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

	private resolveUnresolvedComms(): void {
		const { repos } = this.c();
		const allAgents = repos.agents.list();
		for (const comm of repos.comms.listUnresolved()) {
			let peerAgentId = resolvePeerAgentId(
				comm.agent_id,
				comm.machine_id,
				{
					sessionId: comm.peer_session_id,
					name: comm.peer_name,
					ref: comm.peer_ref,
					cwd: comm.peer_cwd,
				},
				allAgents,
			);
			if (!peerAgentId && comm.reply_to) {
				peerAgentId = resolvePeerAgentIdFromReply(comm.agent_id, repos.comms.findByMessageId(comm.reply_to), allAgents);
			}
			if (peerAgentId) repos.comms.setPeerAgentId(comm.agent_id, comm.comm_id, peerAgentId);
		}
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
		const e = ev.e as { type: string; [k: string]: unknown };
		const now = Date.now();
		let agentChanged = false;
		let storedComm: CommRow | undefined;
		const persisted = isPersistedEvent(e.type);
		const shouldTouch = now - (conn.lastTouchAt ?? 0) >= 30_000;

		const applyDbWrites = () => {
			if (persisted) {
				repos.events.insert(agentId, ev.epoch, ev.seq, now, e.type, e);
				repos.agents.setSeq(agentId, ev.seq);
			}
			switch (e.type) {
				case "comm": {
					if (!Value.Check(CommEvent, e)) {
						this.c().log.warn({ agentId, seq: ev.seq }, "invalid comm event payload; skipping comm persistence");
						break;
					}
					const comm = e;
					const validAction =
						comm.channel === "orchestrator"
							? comm.action === "message"
							: ["send", "ask", "reply", "handover"].includes(comm.action);
					if (!validAction) {
						this.c().log.warn(
							{ agentId, commId: comm.commId, channel: comm.channel, action: comm.action },
							"invalid comm channel/action combination; skipping comm persistence",
						);
						break;
					}
					const allAgents = repos.agents.list();
					let peerAgentId = resolvePeerAgentId(agentId, conn.machineId, comm.peer, allAgents);
					if (!peerAgentId && comm.replyTo) {
						peerAgentId = resolvePeerAgentIdFromReply(agentId, repos.comms.findByMessageId(comm.replyTo), allAgents);
					}
					storedComm = repos.comms.upsert({
						agent_id: agentId,
						comm_id: comm.commId,
						machine_id: conn.machineId,
						direction: comm.direction,
						channel: comm.channel,
						action: comm.action,
						peer_session_id: comm.peer.sessionId,
						peer_name: comm.peer.name,
						peer_cwd: comm.peer.cwd,
						peer_ref: comm.peer.ref,
						peer_agent_id: peerAgentId,
						message_id: comm.messageId,
						reply_to: comm.replyTo,
						expects_reply: comm.expectsReply,
						text: comm.text,
						truncated: comm.truncated,
						delivered: comm.delivered ?? null,
						at: comm.at,
					});
					break;
				}
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
						this.resolveUnresolvedComms();
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
			}
			if (shouldTouch) {
				conn.lastTouchAt = now;
				repos.agents.touch(agentId, now);
			}
		};

		if (persisted) repos.db.transaction(applyDbWrites)();
		else applyDbWrites();
		conn.lastSeq = ev.seq;

		if (storedComm) {
			this.c().mesh.onComm(storedComm);
			this.c().mesh.invalidate();
		} else if (agentChanged || e.type === "todo_update" || e.type === "subagent_update") {
			this.c().mesh.invalidate();
		}

		if (e.type === "agent_settled") {
			if (!e.aborted) dispatcher.settled(agentId, repos.agents.get(agentId)?.last_preview ?? null);
		} else if (e.type === "terminal_wait") {
			const title = typeof e.title === "string" ? e.title : null;
			const active = e.active === true;
			hub.broadcastApps(envelope("terminal_wait", { agentId, kind: e.kind as string | undefined, title, active }));
			if (active) dispatcher.terminalWait(agentId, title);
		}

		const out = envelope("agent.event", { agentId, epoch: ev.epoch, seq: ev.seq, e });
		const droppable = isDroppableEvent(e.type) || e.type === "tool_execution_update";
		for (const app of hub.subscribers(agentId)) hub.sendApp(app, out, droppable);
		if (agentChanged) publisher.agent(agentId);
	}

	onStatus(conn: AgentConn, d: { status: string; detail?: string | null }): void {
		const { repos, dispatcher, publisher, mesh } = this.c();
		if (!conn.agentId) return;
		const prev = repos.agents.get(conn.agentId)?.status;
		repos.agents.setStatus(conn.agentId, d.status, d.detail ?? null);
		mesh.invalidate();
		if (d.status === "error" && prev !== "error") dispatcher.agentError(conn.agentId, d.detail ?? null);
		publisher.agent(conn.agentId);
	}

	onStatuses(conn: AgentConn, items: Record<string, string | null>): void {
		const { repos, publisher, mesh } = this.c();
		if (!conn.agentId) return;
		const raw = items["gentle:mode"];
		let mode: string | null = null;
		if (typeof raw === "string") {
			const m = /(AUTO|NORMAL|YOLO)/i.exec(raw);
			mode = m ? m[1]!.toLowerCase() : "unknown";
		}
		repos.agents.setStatuses(conn.agentId, items, mode);
		mesh.invalidate();
		publisher.agent(conn.agentId);
	}

	/** Cierre de la conexión del agente. */
	disconnect(conn: AgentConn): void {
		const { repos, hub, publisher, config, mesh } = this.c();
		const agentId = conn.agentId;
		if (!agentId) return;
		if (!hub.unregisterAgent(conn)) return; // fue reemplazada por otra conexión: nada que hacer
		if (!repos.db.open) return;
		this.c().log.info({ agentId, machineId: conn.machineId }, "agente desconectado");
		repos.agents.setSeq(agentId, conn.lastSeq);
		repos.agents.setOffline(agentId, Date.now());
		mesh.invalidate();
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
		const { repos, hub, publisher, messages, mesh } = this.c();
		const a = repos.agents.get(agentId);
		if (!a || hub.agents.has(agentId)) return false;
		this.clearGrace(agentId);
		repos.agents.delete(agentId);
		mesh.invalidate();
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
