#!/usr/bin/env node
import { backupNow } from "../backup/index.js";
import { backupsDir, dbPath, loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { backup, restore } from "./backupCmd.js";
import { doctor } from "./doctor.js";
import { init } from "./init.js";
import { devices, machines, pushTest } from "./manage.js";
import { pair } from "./pair.js";
import { c } from "./util.js";

const HELP = `rp-relay — relay de RP (Pi ⇄ app Android)

Uso: rp-relay <comando> [opciones]

  init                       crea config, directorio de datos y base de datos
  serve                      arranca el servidor (lo usa systemd)
  pair device                código + QR para emparejar el teléfono
  pair machine [--name N] [--context personal|work]
                             código para emparejar una PC (en Pi: /rp pair <url> <código>)
  machines list|set <id> [--name --context --color]|revoke <id>
  devices list|revoke <id>
  push test [deviceId]       envía una notificación de prueba
  backup now|list            copia de seguridad (VACUUM INTO)
  restore <archivo> [--force]  restaura una copia (verifica integrity_check)
  migrate                    aplica migraciones pendientes
  doctor                     diagnóstico de configuración, DB, FCM, URL pública y reloj
  version

Opciones globales: --config <ruta>   (o RP_CONFIG; por defecto /etc/rp-relay/config.json)
`;

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	// --config es global: se traslada a RP_CONFIG antes de que cada comando cargue la configuración
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--config" && argv[i + 1]) {
			process.env.RP_CONFIG = argv[i + 1];
			argv.splice(i, 2);
			i--;
		} else if (argv[i]?.startsWith("--config=")) {
			process.env.RP_CONFIG = argv[i]!.slice(9);
			argv.splice(i, 1);
			i--;
		}
	}
	const [cmd, ...rest] = argv;
	switch (cmd) {
		case "init":
			return init(rest);
		case "serve": {
			const { serve } = await import("../main.js");
			await serve();
			return;
		}
		case "pair":
			return pair(rest);
		case "machines":
			return machines(rest);
		case "devices":
			return devices(rest);
		case "push":
			if (rest[0] !== "test") throw new Error("uso: rp-relay push test [deviceId]");
			return pushTest(rest.slice(1));
		case "backup":
			return backup(rest);
		case "restore":
			return restore(rest);
		case "migrate": {
			const config = loadConfig();
			const db = openDb(dbPath(config));
			const applied = migrate(db, { beforeApply: () => void backupNow(db, backupsDir(config)) });
			db.close();
			console.log(
				applied.length ? c.green(`✓ migraciones aplicadas: ${applied.join(", ")}`) : "Sin migraciones pendientes.",
			);
			return;
		}
		case "doctor":
			return doctor(rest);
		case "version":
		case "--version":
		case "-v": {
			const { VERSION } = await import("../http/routes/health.js");
			console.log(VERSION);
			return;
		}
		case undefined:
		case "help":
		case "--help":
		case "-h":
			console.log(HELP);
			return;
		default:
			console.error(`comando desconocido: ${cmd}\n`);
			console.error(HELP);
			process.exitCode = 2;
	}
}

main().catch((e: Error) => {
	console.error(c.red(`error: ${e.message}`));
	process.exit(1);
});
