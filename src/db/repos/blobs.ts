import type { DB } from "../index.js";

export interface BlobRow {
	id: string;
	sha256: string;
	name: string | null;
	mime: string | null;
	size: number;
	uploaded_by: string | null;
	created_at: number;
	expires_at: number;
}

export class BlobsRepo {
	constructor(private db: DB) {}
	insert(b: BlobRow): void {
		this.db
			.prepare("INSERT INTO blobs(id,sha256,name,mime,size,uploaded_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)")
			.run(b.id, b.sha256, b.name, b.mime, b.size, b.uploaded_by, b.created_at, b.expires_at);
	}
	get(id: string): BlobRow | undefined {
		return this.db.prepare("SELECT * FROM blobs WHERE id=?").get(id) as BlobRow | undefined;
	}
	grant(blobId: string, machineId: string): void {
		this.db.prepare("INSERT OR IGNORE INTO blob_grants(blob_id,machine_id) VALUES (?,?)").run(blobId, machineId);
	}
	granted(blobId: string, machineId: string): boolean {
		return (
			this.db.prepare("SELECT 1 FROM blob_grants WHERE blob_id=? AND machine_id=?").get(blobId, machineId) !== undefined
		);
	}
	expired(now: number): BlobRow[] {
		return this.db.prepare("SELECT * FROM blobs WHERE expires_at<=?").all(now) as BlobRow[];
	}
	delete(id: string): void {
		this.db.transaction(() => {
			this.db.prepare("DELETE FROM blob_grants WHERE blob_id=?").run(id);
			this.db.prepare("DELETE FROM blobs WHERE id=?").run(id);
		})();
	}
	all(): BlobRow[] {
		return this.db.prepare("SELECT * FROM blobs").all() as BlobRow[];
	}
}
