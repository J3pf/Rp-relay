import { type DB, stmt } from "../index.js";

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
	private deleteTx?: (id: string) => void;
	constructor(private db: DB) {}
	insert(b: BlobRow): void {
		stmt(
			this.db,
			"INSERT INTO blobs(id,sha256,name,mime,size,uploaded_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)",
		).run(b.id, b.sha256, b.name, b.mime, b.size, b.uploaded_by, b.created_at, b.expires_at);
	}
	get(id: string): BlobRow | undefined {
		return stmt(this.db, "SELECT * FROM blobs WHERE id=?").get(id) as BlobRow | undefined;
	}
	grant(blobId: string, machineId: string): void {
		stmt(this.db, "INSERT OR IGNORE INTO blob_grants(blob_id,machine_id) VALUES (?,?)").run(blobId, machineId);
	}
	granted(blobId: string, machineId: string): boolean {
		return (
			stmt(this.db, "SELECT 1 FROM blob_grants WHERE blob_id=? AND machine_id=?").get(blobId, machineId) !== undefined
		);
	}
	expired(now: number): BlobRow[] {
		return stmt(this.db, "SELECT * FROM blobs WHERE expires_at<=?").all(now) as BlobRow[];
	}
	delete(id: string): void {
		this.deleteTx ??= this.db.transaction((blobId: string) => {
			stmt(this.db, "DELETE FROM blob_grants WHERE blob_id=?").run(blobId);
			stmt(this.db, "DELETE FROM blobs WHERE id=?").run(blobId);
		});
		this.deleteTx(id);
	}
	all(): BlobRow[] {
		return stmt(this.db, "SELECT * FROM blobs").all() as BlobRow[];
	}
}
