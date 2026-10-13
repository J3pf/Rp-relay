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
		// por token si lo hay (varios dispositivos tras la misma IP), si no por IP
		keyGenerator: (req) =>
			typeof req.headers.authorization === "string" ? req.headers.authorization.slice(-24) : req.ip,
		allowList: (req) => req.url === "/healthz",
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
	registerAdmin(app, c);
	return app;
}
