import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DB } from "../db/index.js";
import { DAY } from "../util/time.js";

const stamp = (d: Date) =>
	`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

/** Copia consistente con `VACUUM INTO` (segura con el relay en marcha, modo WAL). */
export function backupNow(db: DB, dir: string, at = new Date()): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let target = join(dir, `rp-${stamp(at)}.db`);
	let n = 1;
	while (existsSync(target)) target = join(dir, `rp-${stamp(at)}-${n++}.db`);
	db.prepare("VACUUM INTO ?").run(target);
	try {
		chmodSync(target, 0o600);
	} catch {
		// sistemas de archivos sin permisos POSIX
	}
	return target;
}

export function listBackups(dir: string): { file: string; path: string; mtimeMs: number; size: number }[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => /^rp-.*\.db$/.test(f))
		.map((f) => {
			const path = join(dir, f);
			const st = statSync(path);
			return { file: f, path, mtimeMs: st.mtimeMs, size: st.size };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function pruneBackups(dir: string, keepDays: number, now = Date.now()): number {
	let n = 0;
	for (const b of listBackups(dir)) {
		if (now - b.mtimeMs > keepDays * DAY) {
			rmSync(b.path, { force: true });
			n++;
		}
	}
	return n;
}

export interface VerifyResult {
	ok: boolean;
	detail: string;
}

/** `PRAGMA integrity_check` + presencia del esquema del relay. */
export function verifyDb(file: string): VerifyResult {
	let db: Database.Database | undefined;
	try {
		db = new Database(file, { readonly: true, fileMustExist: true });
		const rows = db.pragma("integrity_check") as { integrity_check: string }[];
		const res = rows.map((r) => r.integrity_check).join("; ");
		if (res !== "ok") return { ok: false, detail: `integrity_check: ${res}` };
		const t = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('devices','machines','agents','prompts')",
			)
			.all();
		if (t.length < 4) return { ok: false, detail: "no parece una base de datos de rp-relay (faltan tablas)" };
		return { ok: true, detail: "ok" };
	} catch (e) {
		return { ok: false, detail: (e as Error).message };
	} finally {
		db?.close();
	}
}

/**
 * Restaura una copia sobre `dbFile` (el relay debe estar parado). La base anterior se conserva como
 * `<dbFile>.pre-restore-<fecha>` y se descartan sus `-wal`/`-shm`.
 */
export function restoreBackup(backupFile: string, dbFile: string, at = new Date()): { previous: string | null } {
	const v = verifyDb(backupFile);
	if (!v.ok) throw new Error(`la copia no es válida: ${v.detail}`);
	let previous: string | null = null;
	if (existsSync(dbFile)) {
		previous = `${dbFile}.pre-restore-${stamp(at)}`;
		renameSync(dbFile, previous);
	}
	rmSync(`${dbFile}-wal`, { force: true });
	rmSync(`${dbFile}-shm`, { force: true });
	try {
		copyFileSync(backupFile, dbFile);
		try {
			chmodSync(dbFile, 0o600);
		} catch {
			// sistemas de archivos sin permisos POSIX
		}
		const after = verifyDb(dbFile);
		if (!after.ok) throw new Error(`la base restaurada no pasó la verificación: ${after.detail}`);
	} catch (e) {
		if (previous && existsSync(previous)) {
			rmSync(dbFile, { force: true });
			renameSync(previous, dbFile);
		}
		throw e;
	}
	return { previous };
}
