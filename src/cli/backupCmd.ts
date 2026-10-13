import { parseArgs } from "node:util";
import { backupNow, listBackups, pruneBackups, restoreBackup, verifyDb } from "../backup/index.js";
import { backupsDir, dbPath } from "../config.js";
import { adminCall, c, fmtTime, open } from "./util.js";

export async function backup(argv: string[]): Promise<void> {
	const [sub] = argv;
	const { config, repos, close } = open();
	try {
		if (sub === "list") {
			const list = listBackups(backupsDir(config));
			for (const b of list) console.log(`${b.file}  ${fmtTime(b.mtimeMs)}  ${(b.size / 1024).toFixed(0)} KiB`);
			if (!list.length) console.log("No hay copias.");
			return;
		}
		if (sub && sub !== "now") throw new Error("uso: rp-relay backup now | list");
		const f = backupNow(repos.db, backupsDir(config));
		const pruned = pruneBackups(backupsDir(config), config.backup.keepDays);
		console.log(c.green(`✓ copia creada: ${f}`) + (pruned ? c.dim(` (${pruned} antiguas eliminadas)`) : ""));
	} finally {
		close();
	}
}

/** `rp-relay restore <archivo>`: verifica `integrity_check` y reemplaza la base (relay parado). */
export async function restore(argv: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { force: { type: "boolean" } },
	});
	const file = positionals[0];
	if (!file) throw new Error("uso: rp-relay restore <archivo.db> [--force]");
	const { loadConfig } = await import("../config.js");
	const config = loadConfig();
	const v = verifyDb(file);
	if (!v.ok) throw new Error(`la copia no es válida: ${v.detail}`);
	console.log(c.green("✓ integrity_check: ok"));
	const live = await adminCall(config, "GET", "/admin/status").catch(() => null);
	if (live && !values.force)
		throw new Error("el relay está en marcha: páralo antes de restaurar (systemctl stop rp-relay) o usa --force");
	const r = restoreBackup(file, dbPath(config));
	console.log(c.green(`✓ base restaurada en ${dbPath(config)}`));
	if (r.previous) console.log(c.dim(`  la base anterior se guardó en ${r.previous}`));
}
