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
		db.pragma("temp_store = MEMORY");
		db.pragma("cache_size = -64000");
	}
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	return db;
}

const stmtCache = new WeakMap<DB, Map<string, Database.Statement>>();

/** Obtiene o compila un `PreparedStatement` cacheado por instancia de base de datos y sentencia SQL. */
export function stmt(db: DB, sql: string): Database.Statement {
	let map = stmtCache.get(db);
	if (!map) {
		map = new Map();
		stmtCache.set(db, map);
	}
	let s = map.get(sql);
	if (!s) {
		s = db.prepare(sql);
		map.set(sql, s);
	}
	return s;
}

export { Database };
