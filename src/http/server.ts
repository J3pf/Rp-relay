import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { Logger } from "pino";
import { registerBlobRoutes } from "../blobs/routes.js";
import type { Config } from "../config.js";
import type { Ctx } from "../context.js";
import { httpStatus, RelayError } from "../util/errors.js";
import type { LongPollRegistry } from "../ws/agentGateway.js";
import { makeHttpAuth } from "./auth.js";
import { registerAdmin } from "./routes/admin.js";
import { registerAgents } from "./routes/agents.js";
import { registerAgentTransport } from "./routes/agentTransport.js";
import { registerDevices, registerMachines } from "./routes/devices.js";
import { registerHealth } from "./routes/health.js";
import { registerMesh } from "./routes/mesh.js";
import { registerPair } from "./routes/pair.js";

export interface BuildHttpOptions {
	config: Config;
	log: Logger;
	c: () => Ctx;
	longPoll: LongPollRegistry;
	https?: { key: string | Buffer; cert: string | Buffer };
}

export async function buildHttp(o: BuildHttpOptions): Promise<FastifyInstance> {
	const { config, log, c } = o;
	const behindProxy = config.trustProxy ?? ["127.0.0.1", "::1", "localhost"].includes(config.listen.host);
	// SAFETY: withTypeProvider() changes only the compile-time provider type; the returned value remains the Fastify instance passed to route registrars.
	const app = Fastify({
		loggerInstance: log,
		trustProxy: behindProxy,
		bodyLimit: 2 * 1024 * 1024,
		logController: new LogController({ disableRequestLogging: true }),
		...(o.https ? { https: o.https } : {}),
	}).withTypeProvider<TypeBoxTypeProvider>() as unknown as FastifyInstance;

	await app.register(rateLimit, {
		global: true,
		max: 600,
		timeWindow: "1 minute",
		keyGenerator: (req) => {
			const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
			const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
			// Token verificado con formato estándar (rpd_/rpm_); si no es válido, agrupar por IP
			if (token.startsWith("rpd_")) {
				const d = c().auth.device(req.headers);
				req._rpDevice = d;
				if (d.ok) return `dev:${d.row.id}`;
			} else if (token.startsWith("rpm_")) {
				const m = c().auth.machine(req.headers);
				req._rpMachine = m;
				if (m.ok) return `mac:${m.row.id}`;
			}
			return behindProxy ? req.ip : (req.raw.socket?.remoteAddress ?? req.ip);
		},
		allowList: (req) => {
			if (req.url !== "/healthz") return false;
			const remote = req.raw.socket?.remoteAddress;
			return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
		},
	});
	await app.register(multipart, { limits: { fileSize: config.limits.blobMaxBytes + 1, files: 1, fields: 5 } });

	app.setErrorHandler((err, _req, reply) => {
		const e = err as { statusCode?: number; code?: string; validation?: unknown; message: string };
		if (err instanceof RelayError) {
			return reply
				.code(httpStatus(err.code))
				.send({ error: { code: err.code, message: err.message, ...(err.reason ? { reason: err.reason } : {}) } });
		}
		if (e.validation) return reply.code(400).send({ error: { code: "bad_request", message: e.message } });
		if (e.statusCode === 429)
			return reply.code(429).send({ error: { code: "rate_limited", message: "demasiadas peticiones" } });
		if (e.code === "FST_REQ_FILE_TOO_LARGE" || e.statusCode === 413)
			return reply.code(413).send({ error: { code: "too_large", message: "el archivo es demasiado grande" } });
		if (e.statusCode && e.statusCode < 500)
			return reply.code(e.statusCode).send({ error: { code: "bad_request", message: e.message } });
		log.error({ err: e.message }, "error no controlado en HTTP");
		return reply.code(500).send({ error: { code: "internal", message: "error interno" } });
	});
	app.setNotFoundHandler((_req, reply) =>
		reply.code(404).send({ error: { code: "not_found", message: "ruta no encontrada" } }),
	);

	const auth = makeHttpAuth(c);
	registerHealth(app, c);
	registerPair(app, c, auth);
	registerDevices(app, c, auth);
	registerMachines(app, c, auth);
	registerAgents(app, c, auth);
	registerAgentTransport(app, c, auth, o.longPoll);
	registerBlobRoutes(app, c, auth);
	registerMesh(app, c, auth);
	registerAdmin(app, c);
	return app;
}
