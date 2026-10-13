import type { DB } from "../index.js";

export interface PairingRow {
	code_hash: Buffer;
	kind: "device" | "machine";
	expires_at: number;
	used_at: number | null;
	created_by: string | null;
	meta: string | null;
}

export class PairingRepo {
	constructor(private db: DB) {}
	insert(c: {
		codeHash: Buffer;
		kind: "device" | "machine";
		expiresAt: number;
		createdBy: string | null;
		meta?: unknown;
	}): void {
		this.db
			.prepare("INSERT INTO pairing_codes(code_hash,kind,expires_at,created_by,meta) VALUES (?,?,?,?,?)")
			.run(c.codeHash, c.kind, c.expiresAt, c.createdBy, c.meta === undefined ? null : JSON.stringify(c.meta));
	}
	/** Consume el código de forma atómica; devuelve la fila sólo si era válido, del tipo pedido y no usado. */
	consume(codeHash: Buffer, kind: "device" | "machine", now: number): PairingRow | undefined {
		const row = this.db
			.prepare(
				"UPDATE pairing_codes SET used_at=? WHERE code_hash=? AND kind=? AND used_at IS NULL AND expires_at>? RETURNING *",
			)
			.get(now, codeHash, kind, now) as PairingRow | undefined;
		return row;
	}
	purge(before: number): number {
		return this.db.prepare("DELETE FROM pairing_codes WHERE expires_at<? OR used_at<?").run(before, before).changes;
	}
}
