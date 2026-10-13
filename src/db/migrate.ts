import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

export interface MigrationFile {
	version: number;
	name: string;
	sql: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
	return readdirSync(dir)
		.filter((f) => /^\d{4}_.+\.sql$/.test(f))
		.sort()
		.map((f) => ({ version: Number(f.slice(0, 4)), name: f, sql: readFileSync(join(dir, f), "utf8") }));
}

export function currentVersion(db: Database): number {
	db.exec(
		"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
	);
	const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
	return row.v ?? 0;
}

export function pendingMigrations(db: Database, dir = MIGRATIONS_DIR): MigrationFile[] {
	const cur = currentVersion(db);
	return readMigrations(dir).filter((m) => m.version > cur);
}

/**
 * Aplica las migraciones pendientes, cada una en su propia transacción.
 * `beforeApply` permite hacer una copia de seguridad previa (reversibilidad) sólo si hay algo que aplicar.
 */
export function migrate(
	db: Database,
	opts: { dir?: string; beforeApply?: (pending: MigrationFile[]) => void } = {},
): number[] {
	const pending = pendingMigrations(db, opts.dir);
	if (pending.length === 0) return [];
	opts.beforeApply?.(pending);
	const applied: number[] = [];
	for (const m of pending) {
		db.transaction(() => {
			db.exec(m.sql);
			db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)").run(
				m.version,
				m.name,
				Date.now(),
			);
		})();
		applied.push(m.version);
	}
	return applied;
}
