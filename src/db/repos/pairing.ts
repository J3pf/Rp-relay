import { type DB, stmt } from "../index.js";

export interface PairingRow {
	code_hash: Buffer;
	kind: "device" | "machine";
	expires_at: number;
	used_at: number | null;
	created_by: string | null;
	meta: string | null;
}

export const MAX_ACTIVE_PAIRING_CODES = 50;

export class PairingRepo {
	constructor(private db: DB) {}
	insert(c: {
		codeHash: Buffer;
		kind: "device" | "machine";
		expiresAt: number;
		createdBy: string | null;
		meta?: unknown;
	}): void {
		stmt(this.db, "INSERT INTO pairing_codes(code_hash,kind,expires_at,created_by,meta) VALUES (?,?,?,?,?)").run(
			c.codeHash,
			c.kind,
			c.expiresAt,
			c.createdBy,
			c.meta === undefined ? null : JSON.stringify(c.meta),
		);
		stmt(
			this.db,
			`DELETE FROM pairing_codes WHERE used_at IS NULL AND code_hash IN (
				SELECT code_hash FROM pairing_codes WHERE used_at IS NULL ORDER BY expires_at DESC LIMIT -1 OFFSET ?
			)`,
		).run(MAX_ACTIVE_PAIRING_CODES);
	}
	/** Consume el código de forma atómica; devuelve la fila sólo si era válido, del tipo pedido y no usado. */
	consume(codeHash: Buffer, kind: "device" | "machine", now: number): PairingRow | undefined {
		const row = stmt(
			this.db,
			"UPDATE pairing_codes SET used_at=? WHERE code_hash=? AND kind=? AND used_at IS NULL AND expires_at>? RETURNING *",
		).get(now, codeHash, kind, now) as PairingRow | undefined;
		return row;
	}
	purge(before: number): number {
		return stmt(this.db, "DELETE FROM pairing_codes WHERE expires_at<? OR used_at<?").run(before, before).changes;
	}
}
