import { loadConfig } from "./config.js";
import { Relay } from "./relay.js";
import { createLogger } from "./util/log.js";

/** Arranca el relay con señales de cierre ordenado (lo usa `rp-relay serve` y systemd). */
export async function serve(): Promise<Relay> {
	const config = loadConfig();
	const log = createLogger(config.logLevel);
	const relay = await Relay.create({ config, log });
	await relay.start();

	let closing = false;
	const shutdown = (reason: string, code = 0) => {
		if (closing) return;
		closing = true;
		log.info({ reason }, "cerrando");
		const force = setTimeout(() => process.exit(code || 1), 10_000);
		force.unref();
		relay
			.stop()
			.catch((e) => log.error({ err: (e as Error).message }, "error al cerrar"))
			.finally(() => process.exit(code));
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("uncaughtException", (e) => {
		log.fatal({ err: e.message, stack: e.stack }, "excepción no controlada");
		shutdown("uncaughtException", 1);
	});
	process.on("unhandledRejection", (e) =>
		log.error({ err: e instanceof Error ? e.message : String(e) }, "promesa rechazada sin manejar"),
	);
	return relay;
}

export { Relay };
