import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const Limits = Type.Object({
	blobMaxBytes: Type.Integer({ minimum: 1024, default: 26_214_400 }),
	blobTtlDays: Type.Number({ minimum: 0.001, default: 7 }),
	eventRetentionDays: Type.Number({ minimum: 0.001, default: 7 }),
	eventsPerAgent: Type.Integer({ minimum: 10, default: 5000 }),
	offlineAgentRetentionDays: Type.Number({ minimum: 0.001, default: 7 }),
	promptRetentionDays: Type.Number({ minimum: 0.001, default: 30 }),
	promptGraceSeconds: Type.Number({ minimum: 0, default: 120 }),
	userMessageTimeoutMs: Type.Integer({ minimum: 100, default: 10_000 }),
	maxBufferedBytes: Type.Integer({ minimum: 1024, default: 1_048_576 }),
	hardBufferedBytes: Type.Integer({ minimum: 1024, default: 16_777_216 }),
	hostRequestTimeoutMs: Type.Integer({ minimum: 50, default: 15_000 }),
	helloTimeoutMs: Type.Integer({ minimum: 50, default: 10_000 }),
	pairAttemptsPerMinute: Type.Integer({ minimum: 1, default: 5 }),
});

export const ConfigSchema = Type.Object({
	listen: Type.Object({
		host: Type.String({ default: "127.0.0.1" }),
		port: Type.Integer({ minimum: 0, maximum: 65535, default: 8787 }),
		httpPort: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
	}),
	publicUrl: Type.String({ default: "http://127.0.0.1:8787" }),
	dataDir: Type.String({ default: "/var/lib/rp-relay" }),
	relayName: Type.String({ default: "rp-relay" }),
	logLevel: Type.String({ default: "info" }),
	trustProxy: Type.Optional(Type.Boolean()),
	fcm: Type.Optional(Type.Object({ serviceAccountFile: Type.String() })),
	tls: Type.Optional(
		Type.Union([
			Type.Object({ cert: Type.String(), key: Type.String() }),
			Type.Object({
				acme: Type.Object({ domain: Type.String(), email: Type.String(), directoryUrl: Type.Optional(Type.String()) }),
			}),
		]),
	),
	backup: Type.Object({
		enabled: Type.Boolean({ default: true }),
		intervalMinutes: Type.Number({ minimum: 0.01, default: 60 }),
		keepDays: Type.Number({ minimum: 0.001, default: 7 }),
	}),
	limits: Limits,
});
export type Config = Static<typeof ConfigSchema>;

export const DEFAULT_CONFIG_PATH = "/etc/rp-relay/config.json";

export function configPath(): string {
	return process.env.RP_CONFIG ?? DEFAULT_CONFIG_PATH;
}

type Json = Record<string, any>;

function applyEnv(raw: Json, env: NodeJS.ProcessEnv): Json {
	const c: Json = structuredClone(raw);
	c.listen ??= {};
	if (env.RP_LISTEN_HOST) c.listen.host = env.RP_LISTEN_HOST;
	if (env.RP_LISTEN_PORT) c.listen.port = Number(env.RP_LISTEN_PORT);
	if (env.RP_HTTP_PORT) c.listen.httpPort = Number(env.RP_HTTP_PORT);
	if (env.RP_PUBLIC_URL) c.publicUrl = env.RP_PUBLIC_URL;
	if (env.RP_DATA_DIR) c.dataDir = env.RP_DATA_DIR;
	if (env.RP_RELAY_NAME) c.relayName = env.RP_RELAY_NAME;
	if (env.LOG_LEVEL) c.logLevel = env.LOG_LEVEL;
	else if (env.RP_LOG_LEVEL) c.logLevel = env.RP_LOG_LEVEL;
	if (env.RP_TRUST_PROXY) c.trustProxy = env.RP_TRUST_PROXY === "true" || env.RP_TRUST_PROXY === "1";
	if (env.RP_FCM_SERVICE_ACCOUNT_FILE) c.fcm = { serviceAccountFile: env.RP_FCM_SERVICE_ACCOUNT_FILE };
	if (env.RP_TLS_CERT && env.RP_TLS_KEY) c.tls = { cert: env.RP_TLS_CERT, key: env.RP_TLS_KEY };
	if (env.RP_ACME_DOMAIN && env.RP_ACME_EMAIL)
		c.tls = { acme: { domain: env.RP_ACME_DOMAIN, email: env.RP_ACME_EMAIL } };
	return c;
}

/** Normaliza (aplica defaults) y valida un objeto de configuración. */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
	const merged = applyEnv((raw ?? {}) as Json, env);
	merged.listen ??= {};
	merged.backup ??= {};
	merged.limits ??= {};
	const withDefaults = Value.Default(ConfigSchema, merged);
	const cleaned = Value.Clean(ConfigSchema, withDefaults);
	if (!Value.Check(ConfigSchema, cleaned)) {
		const errs = [...Value.Errors(ConfigSchema, cleaned)].map((e) => `${e.path || "/"}: ${e.message}`);
		throw new Error(`configuración inválida:\n  ${errs.join("\n  ")}`);
	}
	return cleaned as Config;
}

export function loadConfig(path: string = configPath(), env: NodeJS.ProcessEnv = process.env): Config {
	let raw: unknown = {};
	if (existsSync(path)) {
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			throw new Error(`no se pudo leer ${path}: ${(e as Error).message}`);
		}
	} else if (!env.RP_DATA_DIR && !env.RP_PUBLIC_URL) {
		// sin archivo ni variables: se ejecuta con valores por defecto (útil en Docker con RP_*)
	}
	return parseConfig(raw, env);
}

export const dbPath = (c: Config): string => join(c.dataDir, "relay.db");
export const blobsDir = (c: Config): string => join(c.dataDir, "blobs");
export const backupsDir = (c: Config): string => join(c.dataDir, "backups");
export const adminTokenPath = (c: Config): string => join(c.dataDir, "admin.token");
