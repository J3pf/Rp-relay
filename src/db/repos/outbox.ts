import { type DB, stmt } from "../index.js";

export interface OutboxRow {
	push_id: string;
	device_id: string;
	kind: string;
	ref_id: string | null;
	body: string;
	created_at: number;
	expires_at: number;
	acked_at: number | null;
}

/** Entregas del canal directo pendientes de `push.ack`. */
export class OutboxRepo {
	constructor(private db: DB) {}
	insert(r: Omit<OutboxRow, "acked_at">): void {
		stmt(
			this.db,
			"INSERT OR IGNORE INTO push_outbox(push_id,device_id,kind,ref_id,body,created_at,expires_at) VALUES (?,?,?,?,?,?,?)",
		).run(r.push_id, r.device_id, r.kind, r.ref_id, r.body, r.created_at, r.expires_at);
	}
	ack(pushId: string, deviceId: string, now: number): boolean {
		return (
			stmt(this.db, "UPDATE push_outbox SET acked_at=? WHERE push_id=? AND device_id=? AND acked_at IS NULL").run(
				now,
				pushId,
				deviceId,
			).changes > 0
		);
	}
	/** Cancela las entregas pendientes de un prompt (la notificación ya no hace falta) sin borrar los `cancel`. */
	dropPromptDeliveries(promptId: string, now: number): void {
		stmt(this.db, "UPDATE push_outbox SET acked_at=? WHERE ref_id=? AND kind='prompt' AND acked_at IS NULL").run(
			now,
			promptId,
		);
	}
	pendingFor(deviceId: string, now: number): OutboxRow[] {
		return stmt(
			this.db,
			"SELECT * FROM push_outbox WHERE device_id=? AND acked_at IS NULL AND expires_at>? ORDER BY created_at",
		).all(deviceId, now) as OutboxRow[];
	}
	purge(now: number): number {
		return stmt(this.db, "DELETE FROM push_outbox WHERE expires_at<? OR acked_at<?").run(now, now - 3_600_000).changes;
	}
}
