import { X509Certificate } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import { listBackups } from "../backup/index.js";
import {
	adminTokenPath,
	backupsDir,
	blobsDir,
	configPath,
	DEFAULT_CONFIG_PATH,
	dbPath,
	loadConfig,
} from "../config.js";
import { openDb } from "../db/index.js";
import { currentVersion, readMigrations } from "../db/migrate.js";
import { isFileTls } from "../tls/index.js";
import { c } from "./util.js";

type Level = "ok" | "warn" | "fail";
export interface Check {
	name: string;
	level: Level;
	detail: string;
}

/** `rp-relay doctor`: configuración, DB, permisos, FCM, publicUrl alcanzable, reloj, disco, TLS y copias. */
export async function runDoctor(opts: { fetchImpl?: typeof fetch } = {}): Promise<Check[]> {
	const out: Check[] = [];
	const add = (name: string, level: Level, detail: string) => out.push({ name, level, detail });
	const fetchFn = opts.fetchImpl ?? fetch;

	add(
		"Node.js",
		Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "fail",
		`v${process.versions.node} (se requiere ≥ 22)`,
	);

	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig();
		add(
			"Configuración",
			"ok",
			existsSync(configPath()) ? configPath() : `sin ${configPath()}: valores por defecto/RP_*`,
		);
	} catch (e) {
		add("Configuración", "fail", (e as Error).message);
		return out;
	}

	// directorio de datos y permisos
	try {
		accessSync(config.dataDir, constants.R_OK | constants.W_OK);
		add("Directorio de datos", "ok", config.dataDir);
	} catch {
		add("Directorio de datos", "fail", `${config.dataDir} no existe o no es escribible por este usuario`);
	}
	const tokenFile = adminTokenPath(config);
	if (existsSync(tokenFile)) {
		const mode = statSync(tokenFile).mode & 0o777;
		add(
			"admin.token",
			mode & 0o077 ? "warn" : "ok",
			mode & 0o077 ? `permisos ${mode.toString(8)}: debería ser 600` : "permisos 600",
		);
	}

	// base de datos
	const dbFile = dbPath(config);
	if (!existsSync(dbFile)) add("Base de datos", "fail", `${dbFile} no existe (ejecuta rp-relay init)`);
	else {
		try {
			const db = openDb(dbFile, { readonly: true });
			const q = db.pragma("quick_check") as { quick_check: string }[];
			const res = q.map((r) => r.quick_check).join("; ");
			const cur = currentVersion(db);
			const latest = Math.max(...readMigrations().map((m) => m.version));
			db.close();
			if (res !== "ok") add("Base de datos", "fail", `quick_check: ${res}`);
			else if (cur < latest)
				add(
					"Base de datos",
					"warn",
					`esquema v${cur}, hay migraciones pendientes hasta v${latest} (se aplican al arrancar)`,
				);
			else add("Base de datos", "ok", `quick_check ok, esquema v${cur}`);
		} catch (e) {
			add("Base de datos", "fail", (e as Error).message);
		}
	}

	// disco libre
	try {
		const s = statfsSync(config.dataDir);
		const freeMb = Math.round((s.bavail * s.bsize) / 1048576);
		add("Espacio en disco", freeMb < 200 ? "fail" : freeMb < 1024 ? "warn" : "ok", `${freeMb} MiB libres`);
	} catch {
		add("Espacio en disco", "warn", "no se pudo comprobar");
	}

	// copias
	const backups = listBackups(backupsDir(config));
	if (!config.backup.enabled) add("Copias de seguridad", "warn", "desactivadas en la configuración");
	else if (backups.length === 0)
		add("Copias de seguridad", "warn", "todavía no hay copias (se crean cada hora con el relay en marcha)");
	else {
		const age = (Date.now() - backups[0]!.mtimeMs) / 3_600_000;
		add(
			"Copias de seguridad",
			age > (config.backup.intervalMinutes / 60) * 3 + 1 ? "warn" : "ok",
			`${backups.length} copias, la última hace ${age.toFixed(1)} h`,
		);
	}
	add("Directorio de adjuntos", existsSync(blobsDir(config)) ? "ok" : "warn", blobsDir(config));

	// FCM
	if (!config.fcm) add("FCM", "ok", "no configurado (opcional): sólo canal de push directo");
	else {
		try {
			const sa = JSON.parse(readFileSync(config.fcm.serviceAccountFile, "utf8"));
			if (!sa.private_key || !sa.client_email || !sa.project_id)
				throw new Error("la cuenta de servicio no tiene private_key/client_email/project_id");
			try {
				await import("firebase-admin");
				const mode = statSync(config.fcm.serviceAccountFile).mode & 0o777;
				add(
					"FCM",
					mode & 0o077 ? "warn" : "ok",
					`proyecto ${sa.project_id}${mode & 0o077 ? ` — permisos ${mode.toString(8)}: usa chmod 600` : ""}`,
				);
			} catch {
				add("FCM", "fail", "firebase-admin no está instalado");
			}
		} catch (e) {
			add("FCM", "fail", (e as Error).message);
		}
	}

	// TLS
	if (config.tls) {
		if (isFileTls(config.tls)) {
			try {
				const exp = new X509Certificate(readFileSync(config.tls.cert)).validToDate;
				const days = Math.round((exp.getTime() - Date.now()) / 86_400_000);
				add("TLS (certificado)", days < 0 ? "fail" : days < 14 ? "warn" : "ok", `caduca en ${days} días`);
			} catch (e) {
				add("TLS (certificado)", "fail", (e as Error).message);
			}
		} else add("TLS (ACME)", "ok", `dominio ${config.tls.acme.domain}`);
	} else if (config.publicUrl.startsWith("https://") && config.listen.host !== "127.0.0.1") {
		add("TLS", "warn", "publicUrl es https pero el relay escucha sin TLS fuera de loopback");
	}

	// publicUrl alcanzable + reloj
	if (!/^https?:\/\//.test(config.publicUrl)) add("publicUrl", "fail", `${config.publicUrl} no es una URL http(s)`);
	else {
		if (config.publicUrl.startsWith("http://") && !/\/\/(127\.|localhost|\[::1\])/.test(config.publicUrl))
			add("publicUrl", "warn", "usa http:// fuera de loopback: la app Android exige TLS");
		try {
			const t0 = Date.now();
			const res = await fetchFn(`${config.publicUrl.replace(/\/$/, "")}/healthz`, {
				signal: AbortSignal.timeout(8000),
			});
			const body = (await res.json().catch(() => null)) as { ok?: boolean; version?: string } | null;
			if (res.ok && body?.ok) {
				add("publicUrl alcanzable", "ok", `${config.publicUrl} → relay ${body.version} (${Date.now() - t0} ms)`);
				const date = res.headers.get("date");
				if (date) {
					const skew = Math.abs(Date.now() - new Date(date).getTime()) / 1000;
					add("Reloj", skew > 60 ? "warn" : "ok", `desfase ≈ ${skew.toFixed(0)} s respecto al servidor HTTP`);
				}
			} else add("publicUrl alcanzable", "fail", `${config.publicUrl}/healthz respondió HTTP ${res.status}`);
		} catch (e) {
			add(
				"publicUrl alcanzable",
				"fail",
				`${config.publicUrl}: ${(e as Error).message} (¿relay parado, DNS o proxy sin configurar?)`,
			);
		}
	}
	return out;
}

export async function doctor(_argv: string[]): Promise<void> {
	const checks = await runDoctor();
	for (const k of checks) {
		const mark = k.level === "ok" ? c.green("✓") : k.level === "warn" ? c.yellow("!") : c.red("✗");
		console.log(`${mark} ${k.name.padEnd(24)} ${k.detail}`);
	}
	const fails = checks.filter((k) => k.level === "fail").length;
	const warns = checks.filter((k) => k.level === "warn").length;
	console.log(
		fails
			? c.red(`\n${fails} problema(s) y ${warns} aviso(s)`)
			: warns
				? c.yellow(`\n0 problemas, ${warns} aviso(s)`)
				: c.green("\nTodo en orden"),
	);
	if (fails) process.exitCode = 1;
}

export { DEFAULT_CONFIG_PATH };
