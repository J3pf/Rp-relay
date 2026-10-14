import type { PromptOpen, PromptState } from "@j3pf/rp-protocol";
import { type DB, stmt } from "../index.js";

export interface PromptRow {
	id: string;
	agent_id: string;
	kind: string;
	category: string;
	payload: string;
	state: PromptState;
	answer: string | null;
	resolved_by: string | null;
	answered_by_device: string | null;
	created_at: number;
	answered_at: number | null;
	resolved_at: number | null;
	expires_at: number | null;
	push_attempts: number;
}

export class PromptsRepo {
	constructor(private db: DB) {}
	get(id: string): PromptRow | undefined {
		return stmt(this.db, "SELECT * FROM prompts WHERE id=?").get(id) as PromptRow | undefined;
	}
	insert(agentId: string, p: PromptOpen, now: number): void {
		stmt(
			this.db,
			"INSERT INTO prompts(id,agent_id,kind,category,payload,state,created_at,expires_at) VALUES (?,?,?,?,?,'open',?,?)",
		).run(p.promptId, agentId, p.kind, p.category, JSON.stringify(p), now, p.expiresAt ?? null);
	}
	/** Reabre un prompt que el relay había cancelado/expirado pero que el plugin sigue mostrando. */
	reopen(id: string, p: PromptOpen): boolean {
		return (
			stmt(
				this.db,
				"UPDATE prompts SET state='open', resolved_at=NULL, resolved_by=NULL, answer=NULL, payload=?, expires_at=? WHERE id=? AND state IN ('cancelled','expired') AND resolved_by='relay_grace'",
			).run(JSON.stringify(p), p.expiresAt ?? null, id).changes > 0
		);
	}
	/** "Primera respuesta gana": transición atómica open → answered. */
	answer(id: string, answer: unknown, deviceId: string | null, now: number): boolean {
		return (
			stmt(
				this.db,
				"UPDATE prompts SET state='answered', answer=?, answered_by_device=?, answered_at=? WHERE id=? AND state='open' AND (expires_at IS NULL OR expires_at>?)",
			).run(JSON.stringify(answer), deviceId, now, id, now).changes > 0
		);
	}
	/** Cierra un prompt abierto o respondido. Devuelve la fila anterior si hubo transición. */
	close(
		id: string,
		state: "resolved" | "cancelled" | "expired",
		by: string,
		answer: unknown | null,
		now: number,
	): PromptRow | undefined {
		const prev = this.get(id);
		if (!prev || (prev.state !== "open" && prev.state !== "answered")) return undefined;
		const res = stmt(
			this.db,
			"UPDATE prompts SET state=?, resolved_by=?, resolved_at=?, answer=COALESCE(?, answer) WHERE id=? AND state IN ('open','answered')",
		).run(state, by, now, answer === null ? null : JSON.stringify(answer), id);
		return res.changes > 0 ? prev : undefined;
	}
	openForAgent(agentId: string, states: PromptState[] = ["open"]): PromptRow[] {
		const qs = states.map(() => "?").join(",");
		return stmt(this.db, `SELECT * FROM prompts WHERE agent_id=? AND state IN (${qs}) ORDER BY created_at`).all(
			agentId,
			...states,
		) as PromptRow[];
	}
	list(states: PromptState[]): PromptRow[] {
		const qs = states.map(() => "?").join(",");
		return stmt(this.db, `SELECT * FROM prompts WHERE state IN (${qs}) ORDER BY created_at`).all(
			...states,
		) as PromptRow[];
	}
	pendingAnswers(agentId: string): PromptRow[] {
		return stmt(this.db, "SELECT * FROM prompts WHERE agent_id=? AND state='answered' ORDER BY answered_at").all(
			agentId,
		) as PromptRow[];
	}
	expiredOpen(now: number): PromptRow[] {
		return stmt(this.db, "SELECT * FROM prompts WHERE state='open' AND expires_at IS NOT NULL AND expires_at<=?").all(
			now,
		) as PromptRow[];
	}
	/** Prompts `danger=high` abiertos que toca volver a notificar (a los 5 y 10 min; máx. 3 envíos). */
	repushDue(now: number, intervalMs: number, maxAttempts: number): PromptRow[] {
		return stmt(
			this.db,
			`SELECT * FROM prompts WHERE state='open' AND json_extract(payload,'$.danger')='high'
				 AND push_attempts>=1 AND push_attempts<? AND ?-created_at >= push_attempts*?`,
		).all(maxAttempts, now, intervalMs) as PromptRow[];
	}
	bumpPush(id: string): void {
		stmt(this.db, "UPDATE prompts SET push_attempts=push_attempts+1 WHERE id=?").run(id);
	}
	countOpenForAgent(agentId: string): number {
		return (
			stmt(this.db, "SELECT COUNT(*) AS n FROM prompts WHERE agent_id=? AND state IN ('open','answered')").get(
				agentId,
			) as { n: number }
		).n;
	}
	countOpenByAgent(): Map<string, number> {
		const m = new Map<string, number>();
		for (const r of stmt(
			this.db,
			"SELECT agent_id, COUNT(*) AS n FROM prompts WHERE state IN ('open','answered') GROUP BY agent_id",
		).all() as {
			agent_id: string;
			n: number;
		}[])
			m.set(r.agent_id, r.n);
		return m;
	}
	/** 'answered' sin entregar durante más de un día se da por expirado. */
	expireStaleAnswered(before: number): PromptRow[] {
		const rows = stmt(this.db, "SELECT * FROM prompts WHERE state='answered' AND answered_at<?").all(
			before,
		) as PromptRow[];
		const expired: PromptRow[] = [];
		const now = Date.now();
		for (const r of rows) {
			const prev = this.close(r.id, "expired", "relay_timeout", null, now);
			if (prev) expired.push(prev);
		}
		return expired;
	}
	purgeClosed(before: number): number {
		return stmt(this.db, "DELETE FROM prompts WHERE state NOT IN ('open','answered') AND resolved_at<?").run(before)
			.changes;
	}
}
