import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

export function openDb(path: string, opts: { readonly?: boolean } = {}): DB {
	if (path !== ":memory:" && !opts.readonly) mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { readonly: opts.readonly ?? false });
	if (!opts.readonly) {
		db.pragma("journal_mode = WAL");
		db.pragma("synchronous = NORMAL");
	}
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	return db;
}

export { Database };
