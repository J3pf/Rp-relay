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
	const tmp = `${target}.tmp-${process.pid}`;
	rmSync(tmp, { force: true });
	try {
		db.prepare("VACUUM INTO ?").run(tmp);
		try {
			chmodSync(tmp, 0o600);
		} catch {
			// sistemas de archivos sin permisos POSIX
		}
		renameSync(tmp, target);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
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
	const backups = listBackups(dir);
	if (backups.length <= 1) return 0;
	let protectedPath = backups[0]!.path;
	if (backups.every((b) => now - b.mtimeMs > keepDays * DAY)) {
		const newestValid = backups.find((b) => verifyDb(b.path).ok);
		if (newestValid) protectedPath = newestValid.path;
	}
	let n = 0;
	for (const b of backups) {
		if (b.path === protectedPath) continue;
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
 * Restaura una copia sobre `dbFile` (el relay debe estar parado). La base anterior y sus archivos
 * `-wal`/`-shm` se conservan como `<dbFile>.pre-restore-<fecha>` (+ `-wal`/`-shm`).
 */
export function restoreBackup(backupFile: string, dbFile: string, at = new Date()): { previous: string | null } {
	const v = verifyDb(backupFile);
	if (!v.ok) throw new Error(`la copia no es válida: ${v.detail}`);

	const tmpFile = `${dbFile}.restore-${process.pid}.tmp`;
	try {
		copyFileSync(backupFile, tmpFile);
		try {
			chmodSync(tmpFile, 0o600);
		} catch {
			// sistemas de archivos sin permisos POSIX
		}
		const staged = verifyDb(tmpFile);
		if (!staged.ok) throw new Error(`la base restaurada no pasó la verificación: ${staged.detail}`);
	} catch (e) {
		rmSync(tmpFile, { force: true });
		throw e;
	}

	let previous: string | null = null;
	let movedMain = false;
	let movedWal = false;
	let movedShm = false;
	const walFile = `${dbFile}-wal`;
	const shmFile = `${dbFile}-shm`;
	try {
		if (existsSync(dbFile)) {
			let prev = `${dbFile}.pre-restore-${stamp(at)}`;
			let n = 1;
			while (existsSync(prev)) prev = `${dbFile}.pre-restore-${stamp(at)}-${n++}`;
			previous = prev;
			renameSync(dbFile, previous);
			movedMain = true;
			if (existsSync(walFile)) {
				renameSync(walFile, `${previous}-wal`);
				movedWal = true;
			}
			if (existsSync(shmFile)) {
				renameSync(shmFile, `${previous}-shm`);
				movedShm = true;
			}
		} else {
			rmSync(walFile, { force: true });
			rmSync(shmFile, { force: true });
		}
		renameSync(tmpFile, dbFile);
		const after = verifyDb(dbFile);
		if (!after.ok) throw new Error(`la base restaurada no pasó la verificación: ${after.detail}`);
	} catch (e) {
		rmSync(tmpFile, { force: true });
		if (previous) {
			if (movedMain && existsSync(previous)) {
				rmSync(dbFile, { force: true });
				renameSync(previous, dbFile);
			}
			if (movedWal && existsSync(`${previous}-wal`)) {
				rmSync(walFile, { force: true });
				renameSync(`${previous}-wal`, walFile);
			}
			if (movedShm && existsSync(`${previous}-shm`)) {
				rmSync(shmFile, { force: true });
				renameSync(`${previous}-shm`, shmFile);
			}
		}
		throw e;
	}
	return { previous };
}
