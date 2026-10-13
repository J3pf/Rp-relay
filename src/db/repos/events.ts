import type { DB } from "../index.js";

export interface EventRow {
	agent_id: string;
	epoch: string;
	seq: number;
	ts: number;
	type: string;
	payload: string;
}

export class EventsRepo {
	constructor(private db: DB) {}
	/** Devuelve true si se insertó (false = duplicado por reenvío). */
	insert(agentId: string, epoch: string, seq: number, ts: number, type: string, payload: unknown): boolean {
		return (
			this.db
				.prepare("INSERT OR IGNORE INTO events(agent_id,epoch,seq,ts,type,payload) VALUES (?,?,?,?,?,?)")
				.run(agentId, epoch, seq, ts, type, JSON.stringify(payload)).changes > 0
		);
	}
	since(agentId: string, epoch: string, sinceSeq: number, limit = 5000): EventRow[] {
		return this.db
			.prepare("SELECT * FROM events WHERE agent_id=? AND epoch=? AND seq>? ORDER BY seq LIMIT ?")
			.all(agentId, epoch, sinceSeq, limit) as EventRow[];
	}
	firstSeq(agentId: string, epoch: string): number | null {
		const r = this.db.prepare("SELECT MIN(seq) AS s FROM events WHERE agent_id=? AND epoch=?").get(agentId, epoch) as {
			s: number | null;
		};
		return r.s;
	}
	count(agentId: string): number {
		return (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE agent_id=?").get(agentId) as { n: number }).n;
	}
	putSnapshot(agentId: string, epoch: string, seq: number, payload: unknown): void {
		this.db.transaction(() => {
			this.db.prepare("DELETE FROM snapshots WHERE agent_id=? AND epoch<>?").run(agentId, epoch);
			this.db.prepare("DELETE FROM events WHERE agent_id=? AND epoch<>?").run(agentId, epoch);
			this.db
				.prepare(
					"INSERT INTO snapshots(agent_id,epoch,seq,payload) VALUES (?,?,?,?) ON CONFLICT(agent_id,epoch) DO UPDATE SET seq=excluded.seq,payload=excluded.payload",
				)
				.run(agentId, epoch, seq, JSON.stringify(payload));
		})();
	}
	snapshot(
		agentId: string,
		epoch: string,
	): { seq: number; payload: { entries: unknown[]; truncated?: boolean } } | undefined {
		const r = this.db.prepare("SELECT seq,payload FROM snapshots WHERE agent_id=? AND epoch=?").get(agentId, epoch) as
			| { seq: number; payload: string }
			| undefined;
		return r ? { seq: r.seq, payload: JSON.parse(r.payload) } : undefined;
	}
	/** Retención: por antigüedad y por cantidad por agente. */
	prune(olderThan: number, perAgent: number): number {
		let n = this.db.prepare("DELETE FROM events WHERE ts<?").run(olderThan).changes;
		const over = this.db
			.prepare("SELECT agent_id, COUNT(*) AS c FROM events GROUP BY agent_id HAVING c>?")
			.all(perAgent) as { agent_id: string; c: number }[];
		for (const o of over) {
			n += this.db
				.prepare(
					`DELETE FROM events WHERE agent_id=? AND rowid IN (
					   SELECT rowid FROM events WHERE agent_id=? ORDER BY ts, seq LIMIT ?)`,
				)
				.run(o.agent_id, o.agent_id, o.c - perAgent).changes;
		}
		return n;
	}
}
