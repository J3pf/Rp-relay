import { type Answer, envelope, type PromptOpen, type PromptResolved } from "@j3pf/rp-protocol";
import type { Ctx } from "../context.js";
import type { PromptRow } from "../db/repos/index.js";
import { MINUTE } from "../util/time.js";
import type { AppConn } from "../ws/conn.js";

export type AnswerOutcome = { ok: true; queued: boolean } | { ok: false; reason: "already_resolved" | "not_found" };

type ResolvedBy = PromptResolved["by"];

/** Ciclo de vida de los prompts con semántica "primera respuesta gana" (PLAN-RELAY §5.2). */
export class PromptService {
	/** Respuestas WS pendientes de `prompt.ack`, para poder avisar si el ack llega con `accepted=false`. */
	private answerReqs = new Map<string, { conn: AppConn | null; reqId: string | undefined; deviceId: string }>();

	constructor(private c: () => Ctx) {}

	/** `prompt.open` del plugin (o reconciliación en `agent.hello`). */
	onPluginOpen(agentId: string, p: PromptOpen): void {
		const { repos, hub, summaries, publisher, dispatcher } = this.c();
		const existing = repos.prompts.get(p.promptId);
		if (existing) {
			if (
				existing.state === "cancelled" &&
				existing.resolved_by === "relay_grace" &&
				repos.prompts.reopen(p.promptId, p)
			) {
				// el plugin reconectó con el diálogo aún abierto tras haberlo cancelado el relay
			} else return;
		} else repos.prompts.insert(agentId, { ...p, agentId }, Date.now());
		const row = repos.prompts.get(p.promptId)!;
		this.c().log.info({ promptId: p.promptId, agentId, category: p.category, danger: p.danger }, "prompt abierto");
		hub.broadcastApps(envelope("prompt.opened", summaries.prompt(row)));
		dispatcher.promptOpened(row);
		publisher.agent(agentId);
		const a = repos.agents.get(agentId);
		if (a) publisher.machine(a.machine_id);
	}

	/** Respuesta de una app (WS o HTTP). Atómica: sólo la primera gana. */
	answer(
		promptId: string,
		answer: Answer,
		deviceId: string,
		via: { conn?: AppConn; reqId?: string } = {},
	): AnswerOutcome {
		const { repos, hub } = this.c();
		const row = repos.prompts.get(promptId);
		if (!row) return { ok: false, reason: "not_found" };
		if (!repos.prompts.answer(promptId, answer, deviceId, Date.now())) return { ok: false, reason: "already_resolved" };
		this.c().log.info(
			{ promptId, agentId: row.agent_id, deviceId, agentOnline: hub.agents.has(row.agent_id) },
			"prompt respondido desde la app",
		);
		this.answerReqs.set(promptId, { conn: via.conn ?? null, reqId: via.reqId, deviceId });
		const agentConn = hub.agents.get(row.agent_id);
		if (!agentConn) return { ok: true, queued: true };
		agentConn.send(envelope("prompt.answer", { promptId, answer, deviceId }));
		return { ok: true, queued: false };
	}

	/** `prompt.ack` del plugin tras recibir `prompt.answer`. */
	onAck(agentId: string, promptId: string, accepted: boolean): void {
		const { repos } = this.c();
		const row = repos.prompts.get(promptId);
		if (!row || row.agent_id !== agentId) return;
		const req = this.answerReqs.get(promptId);
		this.answerReqs.delete(promptId);
		if (accepted) {
			const ans = row.answer ? (JSON.parse(row.answer) as Answer) : null;
			const prev = repos.prompts.close(promptId, "resolved", "remote", ans, Date.now());
			if (prev) this.afterClose(prev, "remote", ans, row.answered_by_device ?? req?.deviceId ?? null);
		} else {
			const prev = repos.prompts.close(promptId, "resolved", "local", null, Date.now());
			if (prev) this.afterClose(prev, "local", null, null);
			if (req?.conn) {
				req.conn.send(
					envelope(
						"prompt.answer.result",
						{ ok: false, reason: "already_resolved" },
						req.reqId ? { re: req.reqId } : {},
					),
				);
			}
		}
	}

	/** `prompt.resolved` del plugin (resuelto en la terminal, timeout o cancelado). */
	onPluginResolved(agentId: string, r: PromptResolved): void {
		const { repos } = this.c();
		const row = repos.prompts.get(r.promptId);
		if (!row || row.agent_id !== agentId) return;
		const state = r.by === "cancelled" ? "cancelled" : r.by === "timeout" ? "expired" : "resolved";
		const prev = repos.prompts.close(r.promptId, state, r.by, r.answer ?? null, Date.now());
		this.answerReqs.delete(r.promptId);
		if (prev) this.afterClose(prev, r.by, r.answer ?? null, r.byDeviceId ?? null);
	}

	/** El relay cancela por su cuenta (gracia tras desconexión, expiración). */
	cancelByRelay(row: PromptRow, why: "grace" | "timeout"): void {
		const { repos, hub } = this.c();
		const state = why === "grace" ? "cancelled" : "expired";
		const prev = repos.prompts.close(
			row.id,
			state,
			why === "grace" ? "relay_grace" : "relay_timeout",
			null,
			Date.now(),
		);
		if (!prev) return;
		if (why === "timeout") hub.agents.get(row.agent_id)?.send(envelope("prompt.cancel", { promptId: row.id }));
		this.afterClose(prev, why === "grace" ? "cancelled" : "timeout", null, null);
	}

	/** Difunde la resolución, retira la notificación y actualiza contadores. */
	private afterClose(prev: PromptRow, by: ResolvedBy, answer: Answer | null, byDeviceId: string | null): void {
		const { repos, hub, publisher, dispatcher, log } = this.c();
		log.info({ promptId: prev.id, agentId: prev.agent_id, by }, "prompt cerrado");
		this.answerReqs.delete(prev.id);
		const body: PromptResolved = { promptId: prev.id, by, answer };
		if (byDeviceId) body.byDeviceId = byDeviceId;
		hub.broadcastApps(envelope("prompt.resolved", body));
		dispatcher.promptCancelled(prev.id, by === "remote" ? byDeviceId : null);
		publisher.agent(prev.agent_id);
		const a = repos.agents.get(prev.agent_id);
		if (a) publisher.machine(a.machine_id);
	}

	/** Periódico: expira prompts con `expiresAt` vencido y vuelve a notificar los `danger=high` abiertos. */
	sweep(now = Date.now()): { expired: number; repushed: number } {
		const { repos, dispatcher } = this.c();
		let expired = 0;
		for (const row of repos.prompts.expiredOpen(now)) {
			this.cancelByRelay(row, "timeout");
			expired++;
		}
		let repushed = 0;
		for (const row of repos.prompts.repushDue(now, 5 * MINUTE, 3)) {
			dispatcher.promptRepush(row);
			repushed++;
		}
		return { expired, repushed };
	}

	/** Cancela los prompts abiertos de un agente (tras la ventana de gracia sin reconexión). */
	cancelOpenOfAgent(agentId: string): number {
		let n = 0;
		for (const row of this.c().repos.prompts.openForAgent(agentId, ["open"])) {
			this.cancelByRelay(row, "grace");
			n++;
		}
		return n;
	}

	/** Reconciliación con `agent.hello.openPrompts`. */
	reconcile(agentId: string, incoming: PromptOpen[]): void {
		const { repos } = this.c();
		const ids = new Set(incoming.map((p) => p.promptId));
		for (const p of incoming) this.onPluginOpen(agentId, p);
		for (const row of repos.prompts.openForAgent(agentId, ["open"])) {
			if (ids.has(row.id)) continue;
			// el plugin ya no lo muestra: se resolvió en la terminal mientras no había conexión
			const prev = repos.prompts.close(row.id, "resolved", "local", null, Date.now());
			if (prev) this.afterClose(prev, "local", null, null);
		}
	}
}
