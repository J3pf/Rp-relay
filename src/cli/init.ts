import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { adminTokenPath, backupsDir, blobsDir, DEFAULT_CONFIG_PATH, dbPath, parseConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { Repos } from "../db/repos/index.js";
import { c } from "./util.js";

/** `rp-relay init`: crea la configuración, el directorio de datos y la base de datos (interactivo o con flags). */
export async function init(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			config: { type: "string" },
			"public-url": { type: "string" },
			"data-dir": { type: "string" },
			name: { type: "string" },
			host: { type: "string" },
			port: { type: "string" },
			"fcm-file": { type: "string" },
			"tls-cert": { type: "string" },
			"tls-key": { type: "string" },
			"acme-domain": { type: "string" },
			"acme-email": { type: "string" },
			yes: { type: "boolean", short: "y" },
			force: { type: "boolean" },
		},
	});
	const configFile = values.config ?? process.env.RP_CONFIG ?? DEFAULT_CONFIG_PATH;
	const interactive = !values.yes && process.stdin.isTTY === true;
	const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
	const ask = async (q: string, def: string): Promise<string> => {
		if (!rl) return def;
		const a = (await rl.question(`${q} [${def}]: `)).trim();
		return a || def;
	};

	const publicUrl = values["public-url"] ?? (await ask("URL pública del relay (https://…)", "http://127.0.0.1:8787"));
	const relayName = values.name ?? (await ask("Nombre del relay", "Servidor casa"));
	const dataDir = values["data-dir"] ?? (await ask("Directorio de datos", "/var/lib/rp-relay"));
	rl?.close();

	const raw: Record<string, unknown> = {
		listen: { host: values.host ?? "127.0.0.1", port: Number(values.port ?? 8787) },
		publicUrl,
		dataDir,
		relayName,
	};
	if (values["fcm-file"]) raw.fcm = { serviceAccountFile: values["fcm-file"] };
	if (values["tls-cert"] && values["tls-key"]) raw.tls = { cert: values["tls-cert"], key: values["tls-key"] };
	if (values["acme-domain"] && values["acme-email"])
		raw.tls = { acme: { domain: values["acme-domain"], email: values["acme-email"] } };
	const config = parseConfig(raw, {});

	if (existsSync(configFile) && !values.force) {
		console.log(c.yellow(`• ${configFile} ya existe: se conserva (usa --force para sobrescribir)`));
	} else {
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o640 });
		console.log(c.green(`✓ configuración escrita en ${configFile}`));
	}

	mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
	mkdirSync(blobsDir(config), { recursive: true });
	mkdirSync(backupsDir(config), { recursive: true });
	const db = openDb(dbPath(config));
	const applied = migrate(db);
	const repos = new Repos(db);
	const relayId = repos.meta.relayId();
	db.close();
	const tokenFile = adminTokenPath(config);
	if (!existsSync(tokenFile)) writeFileSync(tokenFile, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
	console.log(
		c.green(
			`✓ base de datos lista en ${dbPath(config)}${applied.length ? ` (migraciones: ${applied.join(", ")})` : ""}`,
		),
	);
	console.log(c.dim(`  relayId: ${relayId}`));
	console.log(
		`\nSiguientes pasos:\n  1. systemctl enable --now rp-relay   (o: rp-relay serve)\n  2. rp-relay pair device      → escanea el QR con la app RP\n  3. rp-relay pair machine     → en cada PC: /rp pair <url> <código>\n  4. rp-relay doctor`,
	);
}
