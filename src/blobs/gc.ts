import type { Logger } from "pino";
import type { BlobStore } from "./store.js";

/** Tarea periódica de limpieza de adjuntos. */
export function startBlobGc(store: BlobStore, log: Logger, everyMs = 15 * 60_000): () => void {
	const run = () => {
		store
			.gc()
			.then((n) => n > 0 && log.info({ removed: n }, "adjuntos eliminados por caducidad"))
			.catch((e) => log.warn({ err: (e as Error).message }, "fallo en la limpieza de adjuntos"));
	};
	const t = setInterval(run, everyMs);
	t.unref();
	return () => clearInterval(t);
}
