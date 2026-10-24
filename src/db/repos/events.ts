import { type DB, stmt } from "../index.js";

export interface EventRow {
	agent_id: string;
	epoch: string;
	seq: number;
	ts: number;
	type: string;
	payload: string;
}

export class EventsRepo {
	private putSnapshotTx?: (agentId: string, epoch: string, seq: number, payload: string) => void;
	constructor(private db: DB) {}
	/** Devuelve true si se insertó (false = duplicado por reenvío). */
	insert(agentId: string, epoch: string, seq: number, ts: number, type: string, payload: unknown): boolean {
		return (
			stmt(this.db, "INSERT OR IGNORE INTO events(agent_id,epoch,seq,ts,type,payload) VALUES (?,?,?,?,?,?)").run(
				agentId,
				epoch,
				seq,
				ts,
				type,
				JSON.stringify(payload),
			).changes > 0
		);
	}
	since(agentId: string, epoch: string, sinceSeq: number, limit = 5000): EventRow[] {
		return stmt(this.db, "SELECT * FROM events WHERE agent_id=? AND epoch=? AND seq>? ORDER BY seq LIMIT ?").all(
			agentId,
			epoch,
			sinceSeq,
			limit,
		) as EventRow[];
	}
	listByTypes(agentId: string, epoch: string, types: readonly string[], limit = 1000): EventRow[] {
		if (types.length === 0) return [];
		const placeholders = types.map(() => "?").join(",");
		return (
			stmt(
				this.db,
				`SELECT * FROM events WHERE agent_id=? AND epoch=? AND type IN (${placeholders}) ORDER BY seq DESC LIMIT ?`,
			).all(agentId, epoch, ...types, limit) as EventRow[]
		).reverse();
	}
	firstSeq(agentId: string, epoch: string): number | null {
		const r = stmt(this.db, "SELECT MIN(seq) AS s FROM events WHERE agent_id=? AND epoch=?").get(agentId, epoch) as {
			s: number | null;
		};
		return r.s;
	}
	count(agentId: string): number {
		return (stmt(this.db, "SELECT COUNT(*) AS n FROM events WHERE agent_id=?").get(agentId) as { n: number }).n;
	}
	putSnapshot(agentId: string, epoch: string, seq: number, payload: unknown): void {
		this.putSnapshotTx ??= this.db.transaction((aid: string, ep: string, s: number, p: string) => {
			stmt(this.db, "DELETE FROM snapshots WHERE agent_id=? AND epoch<>?").run(aid, ep);
			stmt(this.db, "DELETE FROM events WHERE agent_id=? AND epoch<>?").run(aid, ep);
			stmt(
				this.db,
				"INSERT INTO snapshots(agent_id,epoch,seq,payload) VALUES (?,?,?,?) ON CONFLICT(agent_id,epoch) DO UPDATE SET seq=excluded.seq,payload=excluded.payload",
			).run(aid, ep, s, p);
		});
		this.putSnapshotTx(agentId, epoch, seq, JSON.stringify(payload));
	}
	snapshot(
		agentId: string,
		epoch: string,
	): { seq: number; payload: { entries: unknown[]; truncated?: boolean; pruned?: boolean } } | undefined {
		const r = stmt(this.db, "SELECT seq,payload FROM snapshots WHERE agent_id=? AND epoch=?").get(agentId, epoch) as
			| { seq: number; payload: string }
			| undefined;
		return r ? { seq: r.seq, payload: JSON.parse(r.payload) } : undefined;
	}
	/** Retención: por antigüedad y por cantidad por agente. */
	prune(olderThan: number, perAgent: number): number {
		const affectedAgents = new Set<string>();
		for (const r of stmt(this.db, "SELECT DISTINCT agent_id FROM events WHERE ts<?").all(olderThan) as {
			agent_id: string;
		}[]) {
			affectedAgents.add(r.agent_id);
		}
		let n = stmt(this.db, "DELETE FROM events WHERE ts<?").run(olderThan).changes;
		const over = stmt(this.db, "SELECT agent_id, COUNT(*) AS c FROM events GROUP BY agent_id HAVING c>?").all(
			perAgent,
		) as { agent_id: string; c: number }[];
		for (const o of over) {
			affectedAgents.add(o.agent_id);
			n += stmt(
				this.db,
				`DELETE FROM events WHERE agent_id=? AND rowid IN (
					   SELECT rowid FROM events WHERE agent_id=? ORDER BY ts, seq LIMIT ?)`,
			).run(o.agent_id, o.agent_id, o.c - perAgent).changes;
		}
		for (const agentId of affectedAgents) {
			stmt(
				this.db,
				"UPDATE snapshots SET payload=json_set(payload, '$.truncated', json('true'), '$.pruned', json('true')) WHERE agent_id=?",
			).run(agentId);
		}
		return n;
	}
}
