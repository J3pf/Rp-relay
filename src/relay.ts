import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { CloseCode } from "@j3pf/rp-protocol";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { Authenticator } from "./auth/middleware.js";
import { PairingService } from "./auth/pairing.js";
import { backupNow, pruneBackups } from "./backup/index.js";
import { BlobStore } from "./blobs/store.js";
import { adminTokenPath, backupsDir, blobsDir, type Config, dbPath } from "./config.js";
import type { Ctx } from "./context.js";
import { type DB, openDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { Repos } from "./db/repos/index.js";
import { AgentService } from "./domain/agents.js";
import { EntityService } from "./domain/entities.js";
import { HistoryService } from "./domain/history.js";
import { HostService } from "./domain/hosts.js";
import { MeshService } from "./domain/mesh/service.js";
import { MessageService } from "./domain/messages.js";
import { PromptService } from "./domain/prompts.js";
import { Publisher } from "./domain/publisher.js";
import { Summaries } from "./domain/summaries.js";
import { buildHttp } from "./http/server.js";
import { type ApnsSender, createApnsSender } from "./push/apns.js";
import { PushDispatcher } from "./push/dispatcher.js";
import { createFirebaseSender, type FcmSender } from "./push/fcm.js";
import { runRetention } from "./retention.js";
import { AcmeChallengeServer, ensureAcmeCert, isFileTls, loadFileTls, needsRenewal } from "./tls/index.js";
import { createLogger } from "./util/log.js";
import { sdNotify, watchdogIntervalMs } from "./util/sd.js";
import { HOUR, MINUTE } from "./util/time.js";
import { LongPollRegistry } from "./ws/agentGateway.js";
import { Hub } from "./ws/hub.js";
import { attachWebSockets } from "./ws/index.js";

export interface RelayOptions {
	config: Config;
	log?: Logger;
	/** Sustituye el envío FCM real (tests). */
	fcmSender?: FcmSender | null;
	/** Sustituye el envío APNs real (tests). */
	apnsSender?: ApnsSender | null;
	/** No arrancar temporizadores periódicos (tests deterministas). */
	noTimers?: boolean;
}

function chmodDbFiles(dbFile: string): void {
	for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
		if (!existsSync(file)) continue;
		try {
			chmodSync(file, 0o600);
		} catch {
			// sistemas de archivos sin permisos POSIX
		}
	}
}

/** Ensambla y ejecuta el relay: DB, servicios, HTTP, WebSockets y tareas periódicas. */
export class Relay {
	readonly ctx: Ctx;
	readonly db: DB;
	private app?: FastifyInstance;
	private ws?: { close(): void };
	private longPoll?: LongPollRegistry;
	private timers: NodeJS.Timeout[] = [];
	private acme: AcmeChallengeServer | null = null;
	private stopped = false;
	private tlsActive = false;

	private constructor(
		readonly config: Config,
		readonly log: Logger,
		db: DB,
		ctx: Ctx,
		private opts: RelayOptions,
	) {
		this.db = db;
		this.ctx = ctx;
	}

	static async create(opts: RelayOptions): Promise<Relay> {
		const { config } = opts;
		const log = opts.log ?? createLogger(config.logLevel);
		mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
		const dbFile = dbPath(config);
		const db = openDb(dbFile);
		chmodDbFiles(dbFile);
		migrate(db, {
			beforeApply: (pending) => {
				// reversibilidad: copia previa a aplicar migraciones sobre una base con datos
				const hasData = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'").get();
				if (hasData) {
					const f = backupNow(db, backupsDir(config));
					log.info({ file: f, migrations: pending.map((m) => m.name) }, "copia previa a la migración");
				}
			},
		});
		const repos = new Repos(db);
		repos.meta.relayId();
		chmodDbFiles(dbFile);
		ensureAdminToken(config);

		const ctx = {} as Ctx;
		const get = () => ctx;
		const hub = new Hub({
			maxBufferedBytes: config.limits.maxBufferedBytes,
			hardBufferedBytes: config.limits.hardBufferedBytes,
		});
		let fcm: FcmSender | null = null;
		if (opts.fcmSender !== undefined) fcm = opts.fcmSender;
		else if (config.fcm) {
			try {
				fcm = await createFirebaseSender(config.fcm.serviceAccountFile, log);
			} catch (e) {
				log.error({ err: (e as Error).message }, "FCM no disponible; se continúa sólo con el canal directo");
			}
		}
		let apns: ApnsSender | null = null;
		if (opts.apnsSender !== undefined) apns = opts.apnsSender;
		else if (config.apns) {
			try {
				apns = createApnsSender(config.apns);
			} catch (e) {
				log.error({ err: (e as Error).message }, "APNs no disponible; se continúa sólo con los canales disponibles");
			}
		}
		Object.assign(ctx, {
			config,
			log,
			repos,
			hub,
			auth: new Authenticator(repos),
			pairing: new PairingService(repos, config.relayName),
			summaries: new Summaries(get),
			publisher: new Publisher(get),
			agents: new AgentService(get),
			prompts: new PromptService(get),
			messages: new MessageService(get),
			mesh: new MeshService(get),
			history: new HistoryService(get),
			hosts: new HostService(get),
			entities: new EntityService(get),
			dispatcher: new PushDispatcher(get, log, fcm, apns),
			blobs: new BlobStore(blobsDir(config), repos, config.limits),
		} satisfies Ctx);
		return new Relay(config, log, db, ctx, opts);
	}

	/** Dirección real tras `start()` (útil con puerto 0). */
	get address(): { host: string; port: number } {
		const a = this.app!.server.address() as AddressInfo;
		return { host: a.address, port: a.port };
	}
	get baseUrl(): string {
		const a = this.address;
		const host = a.host === "::" || a.host === "0.0.0.0" ? "127.0.0.1" : a.host.includes(":") ? `[${a.host}]` : a.host;
		return `${this.tlsActive ? "https" : "http"}://${host}:${a.port}`;
	}
	get wsUrl(): string {
		return this.baseUrl.replace(/^http/, "ws");
	}

	private clearTimers(): void {
		for (const t of this.timers) {
			clearInterval(t);
			clearTimeout(t);
		}
		this.timers = [];
	}

	async start(): Promise<void> {
		const { config, log, ctx } = this;
		try {
			let tlsMaterial: { key: Buffer; cert: Buffer } | undefined;
			if (config.tls) {
				if (isFileTls(config.tls)) tlsMaterial = loadFileTls(config.tls);
				else {
					this.acme = new AcmeChallengeServer(config.publicUrl, log);
					await this.acme.listen(config.listen.httpPort ?? 80);
					tlsMaterial = await ensureAcmeCert(config, this.acme, log);
				}
				this.tlsActive = true;
			}

			this.longPoll = new LongPollRegistry(() => ctx);
			this.app = await buildHttp({ config, log, c: () => ctx, longPoll: this.longPoll, https: tlsMaterial });
			this.ws = attachWebSockets(this.app.server, () => ctx);
			ctx.agents.boot();
			await this.app.listen({ host: config.listen.host, port: config.listen.port });
			log.info(
				{ ...this.address, tls: this.tlsActive, fcm: ctx.dispatcher.fcmEnabled, apns: ctx.dispatcher.apnsEnabled },
				"rp-relay escuchando",
			);

			if (!this.opts.noTimers) this.startTimers();
			sdNotify("READY=1", `STATUS=escuchando en ${this.address.port}`);
		} catch (err) {
			await this.cleanupPartialStart();
			throw err;
		}
	}

	private async cleanupPartialStart(): Promise<void> {
		this.clearTimers();
		const run = async (step: string, fn: () => void | Promise<void>) => {
			try {
				await fn();
			} catch (e) {
				this.log.warn(
					{ step, err: e instanceof Error ? e.message : String(e) },
					"error limpiando arranque parcial de rp-relay",
				);
			}
		};
		const ws = this.ws;
		this.ws = undefined;
		if (ws) await run("ws", () => ws.close());
		const app = this.app;
		this.app = undefined;
		if (app) await run("app", () => app.close());
		const longPoll = this.longPoll;
		this.longPoll = undefined;
		if (longPoll) await run("longPoll", () => longPoll.dispose());
		const acme = this.acme;
		this.acme = null;
		if (acme) await run("acme", () => acme.close());
		this.tlsActive = false;
	}

	private every(ms: number, fn: () => void | Promise<void>): void {
		let running = false;
		const t = setInterval(() => {
			if (running) return;
			running = true;
			Promise.resolve()
				.then(fn)
				.catch((e) => this.log.warn({ err: e instanceof Error ? e.message : String(e) }, "tarea periódica fallida"))
				.finally(() => {
					running = false;
				});
		}, ms);
		t.unref();
		this.timers.push(t);
	}

	private startTimers(): void {
		const { ctx, config, log } = this;
		this.every(15_000, () => {
			ctx.prompts.sweep();
			ctx.hosts.sweep();
		});
		this.every(HOUR, async () => {
			const s = await runRetention(ctx);
			log.info(s, "retención ejecutada");
		});
		const first = setTimeout(
			() => void runRetention(ctx).catch((e) => log.warn({ err: (e as Error).message }, "retención inicial fallida")),
			5_000,
		);
		first.unref();
		this.timers.push(first);
		if (config.backup.enabled) {
			this.every(config.backup.intervalMinutes * MINUTE, () => {
				this.backup();
			});
		}
		const wd = watchdogIntervalMs();
		if (wd) {
			this.every(wd, () => {
				this.db.prepare("SELECT 1").get(); // si la DB no responde, no se notifica y systemd reinicia
				sdNotify("WATCHDOG=1");
			});
		}
		if (config.tls && !isFileTls(config.tls) && this.acme) {
			this.every(12 * HOUR, async () => {
				const f = join(config.dataDir, "acme", "fullchain.pem");
				if (!existsSync(f) || !needsRenewal(readFileSync(f))) return;
				const m = await ensureAcmeCert(config, this.acme!, log, true);
				this.setSecureContext({ key: m.key, cert: m.cert });
				log.info("certificado ACME renovado");
			});
		} else if (config.tls && isFileTls(config.tls)) {
			const t = config.tls;
			this.every(12 * HOUR, () => {
				const m = loadFileTls(t);
				this.setSecureContext({ key: m.key, cert: m.cert });
			});
		}
	}

	private setSecureContext(options: { key: Buffer; cert: Buffer }): void {
		// SAFETY: The app server is a TLS server in the renewal branches that call this method.
		const server = this.app!.server as unknown as {
			setSecureContext(options: Record<string, unknown>): void;
		};
		server.setSecureContext(options);
	}

	backup(): string {
		const dir = backupsDir(this.config);
		const f = backupNow(this.db, dir);
		const pruned = pruneBackups(dir, this.config.backup.keepDays);
		this.log.info({ file: f, pruned }, "copia de seguridad creada");
		return f;
	}

	/** Cierre ordenado (SIGTERM): deja de aceptar, avisa con 1012, vacía escrituras y cierra la DB. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		const { ctx, log } = this;
		sdNotify("STOPPING=1");
		this.clearTimers();
		const runStep = async (step: string, fn: () => void | Promise<void>) => {
			try {
				await fn();
			} catch (e) {
				log.warn({ step, err: e instanceof Error ? e.message : String(e) }, "error durante el cierre de rp-relay");
			}
		};
		try {
			// persistir el último seq visto de cada agente conectado antes de cerrar el hub
			await runStep("persist_seqs", () => {
				for (const c of ctx.hub.agents.values()) {
					if (!c.agentId) continue;
					try {
						ctx.repos.agents.setSeq(c.agentId, c.lastSeq);
					} catch (e) {
						log.warn(
							{ step: "persist_seqs", agentId: c.agentId, err: e instanceof Error ? e.message : String(e) },
							"error persistiendo secuencia de agente",
						);
					}
				}
			});
			await runStep("longPoll", () => this.longPoll?.dispose());
			await runStep("hub", () => ctx.hub.closeAll(CloseCode.ServiceRestart, "service restart"));
			// dar un instante a que los close frames salgan antes de cerrar los sockets
			await new Promise((r) => setTimeout(r, 150));
			await runStep("ws", () => this.ws?.close());
			await runStep("app", async () => {
				await this.app?.close();
			});
			await runStep("acme", async () => {
				await this.acme?.close();
			});
			await runStep("agents", () => ctx.agents.dispose());
			await runStep("messages", () => ctx.messages.dispose());
			await runStep("mesh", () => ctx.mesh.dispose());
			await runStep("hosts", () => ctx.hosts.dispose());
			await runStep("dispatcher", () => ctx.dispatcher.close());
		} finally {
			try {
				this.db.pragma("wal_checkpoint(TRUNCATE)");
			} catch {
				// la DB puede estar ya cerrada
			}
			try {
				this.db.close();
			} catch {
				// la DB puede estar ya cerrada
			}
			log.info("rp-relay detenido");
		}
	}
}

export function ensureAdminToken(config: Config): void {
	const f = adminTokenPath(config);
	if (existsSync(f)) return;
	writeFileSync(f, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
	try {
		chmodSync(f, 0o600);
	} catch {
		// sistemas de archivos sin permisos POSIX
	}
}
