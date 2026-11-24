import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, {
	type FastifyBaseLogger,
	type FastifyInstance,
	LogController,
	type RawReplyDefaultExpression,
	type RawRequestDefaultExpression,
	type RawServerDefault,
} from "fastify";
import type { Logger } from "pino";
import { bearer, tokenKind } from "../auth/tokens.js";
import { registerBlobRoutes } from "../blobs/routes.js";
import { type Config, effectiveTrustProxy } from "../config.js";
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

export type TypeBoxFastifyInstance = FastifyInstance<
	RawServerDefault,
	RawRequestDefaultExpression,
	RawReplyDefaultExpression,
	FastifyBaseLogger,
	TypeBoxTypeProvider
>;

export async function buildHttp(o: BuildHttpOptions): Promise<TypeBoxFastifyInstance> {
	const { config, log, c } = o;
	const trustProxy = effectiveTrustProxy(config);
	const behindProxy = Boolean(trustProxy);
	const fastifyTrustProxy =
		typeof trustProxy === "number"
			? trustProxy > 0
				? (_address: string, hop: number) => hop < trustProxy
				: false
			: trustProxy;
	const app = Fastify({
		loggerInstance: log as FastifyBaseLogger,
		trustProxy: fastifyTrustProxy,
		bodyLimit: 2 * 1024 * 1024,
		logController: new LogController({ disableRequestLogging: true }),
		...(o.https ? { https: o.https } : {}),
	}).withTypeProvider<TypeBoxTypeProvider>();

	await app.register(rateLimit, {
		global: true,
		max: 600,
		timeWindow: "1 minute",
		keyGenerator: (req) => {
			const kind = tokenKind(bearer(req.headers.authorization));
			// Token verificado con formato estándar (rpd_/rpm_); si no es válido, agrupar por IP
			if (kind === "device") {
				const d = c().auth.device(req.headers);
				req._rpDevice = d;
				if (d.ok) return `dev:${d.row.id}`;
			} else if (kind === "machine") {
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
