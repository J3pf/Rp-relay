import {
	type Answer,
	CloseCode,
	type Envelope,
	ErrorCode,
	envelope,
	errorEnvelope,
	MIN_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	parseFrame,
	validateMessage,
} from "@j3pf/rp-protocol";
import { ulid } from "ulid";
import type { WebSocket } from "ws";
import type { Ctx } from "../context.js";
import type { DeviceRow } from "../db/repos/index.js";
import { RelayError } from "../util/errors.js";
import { type AppConn, startHeartbeat, WsConn } from "./conn.js";

const TOUCH_EVERY_MS = 5 * 60_000;

class WsAppConn extends WsConn implements AppConn {
	readonly id = ulid();
	readonly subs = new Set<string>();
	ready = false;
	constructor(
		socket: WebSocket,
		readonly deviceId: string,
		readonly mode: "foreground" | "direct",
	) {
		super(socket);
	}
}

export class AppSession {
	private helloDone = false;
	private lastTouch = 0;
	constructor(
		private c: () => Ctx,
		readonly conn: AppConn,
		readonly device: DeviceRow,
	) {}

	get ready(): boolean {
		return this.helloDone;
	}

	touch(): void {
		const now = Date.now();
		if (now - this.lastTouch > TOUCH_EVERY_MS) {
			this.lastTouch = now;
			this.c().repos.devices.touch(this.device.id, now);
		}
	}

	handle(env: Envelope): void {
		const { log } = this.c();
		if (env.v < MIN_PROTOCOL_VERSION || env.v > PROTOCOL_VERSION) {
			this.conn.send(errorEnvelope(ErrorCode.BadRequest, `versión de protocolo ${env.v} no soportada`, env.id));
			this.conn.close(CloseCode.IncompatibleVersion, "incompatible protocol version");
			return;
		}
		if (!this.helloDone && env.t !== "app.hello") {
			this.conn.send(errorEnvelope(ErrorCode.BadRequest, "el primer mensaje debe ser app.hello", env.id));
			this.conn.close(CloseCode.InvalidFrame, "hello required");
			return;
		}
		const v = validateMessage("appUp", env);
		if (!v.ok) {
			this.conn.send(errorEnvelope(ErrorCode.BadRequest, v.message, env.id));
			if (env.t === "app.hello") this.conn.close(CloseCode.InvalidFrame, "invalid hello");
			return;
		}
		if (log.isLevelEnabled("trace")) log.trace({ deviceId: this.device.id, t: env.t, d: env.d }, "app → relay");
		else if (log.isLevelEnabled("debug")) {
			log.debug({ deviceId: this.device.id, t: env.t, bytes: JSON.stringify(env.d ?? null).length }, "app → relay");
		}
		try {
			this.dispatch(env);
		} catch (e) {
			if (e instanceof RelayError) this.conn.send(errorEnvelope(e.code, e.message, env.id, e.reason));
			else {
				log.error(
					{ err: (e as Error).message, t: env.t, deviceId: this.device.id },
					"error procesando mensaje de la app",
				);
				this.conn.send(errorEnvelope(ErrorCode.Internal, "error interno", env.id));
			}
		}
	}

	private reply(env: Envelope, t: string, d?: unknown): void {
		this.conn.send(envelope(t, d, env.id ? { re: env.id } : {}));
	}

	private dispatch(env: Envelope): void {
		const ctx = this.c();
		const { repos, hub, summaries, history, messages, prompts, dispatcher, hosts, agents, config } = ctx;
		const d = (env.d ?? {}) as any;
		switch (env.t) {
			case "app.hello": {
				if (d.deviceId !== this.device.id) {
					this.conn.send(errorEnvelope(ErrorCode.Unauthorized, "deviceId no coincide con el token", env.id));
					this.conn.close(CloseCode.Unauthorized, "device mismatch");
					return;
				}
				this.helloDone = true;
				this.conn.ready = true;
				this.lastTouch = 0;
				this.touch();
				this.reply(env, "app.welcome", {
					machines: summaries.allMachines(),
					agents: summaries.allAgents(),
					openPrompts: summaries.openPrompts(),
					relayId: repos.meta.relayId(),
					relayName: config.relayName,
					serverTime: Date.now(),
				});
				if (this.conn.mode === "direct") {
					dispatcher.flushDirect(this.device.id, (m) => this.conn.send(m));
				} else {
					const hostUpdates = repos.machines
						.list()
						.filter((m) => m.host_info || hub.hosts.has(m.id))
						.map((m) => {
							let info: any = {};
							if (m.host_info) {
								try {
									info = JSON.parse(m.host_info);
								} catch {
									info = {};
								}
							}
							return {
								machineId: m.id,
								hostname: info.hostname ?? m.hostname ?? m.name,
								roots: info.roots ?? [],
								online: hub.hosts.has(m.id),
								backends: info.backends ?? null,
								defaultBackend: info.defaultBackend ?? null,
								launchers: info.launchers ?? [],
								defaultLauncher: info.defaultLauncher ?? null,
							};
						});
					if (hostUpdates.length > 0) {
						this.conn.send(envelope("hosts.update", { upsert: hostUpdates, remove: [] }));
					}
				}
				return;
			}
			case "agent.subscribe": {
				if (this.conn.mode === "direct")
					throw new RelayError("bad_request", "el canal directo no admite suscripciones");
				const a = repos.agents.get(d.agentId);
				const m = a ? repos.machines.get(a.machine_id) : undefined;
				if (!a || !m || m.revoked_at) throw new RelayError("not_found", "agente desconocido");
				hub.subscribe(this.conn, d.agentId);
				const h = history.build(d.agentId, d.sinceSeq ?? null, d.epoch ?? null);
				const { needsResync, ...body } = h;
				this.reply(env, "agent.history", body);
				if (needsResync) hub.agents.get(d.agentId)?.send(envelope("agent.resync", {}));
				return;
			}
			case "agent.unsubscribe":
				hub.unsubscribe(this.conn, d.agentId);
				if (env.id) this.reply(env, "ack");
				return;
			case "mesh.subscribe": {
				const snapshot = ctx.mesh.subscribe(this.conn, d.machineId ?? null);
				this.conn.send(envelope("mesh.snapshot", snapshot, env.id ? { re: env.id } : {}));
				return;
			}
			case "mesh.unsubscribe":
				ctx.mesh.unsubscribe(this.conn);
				return;
			case "user.message": {
				const { agentId, ...rest } = d;
				messages
					.send(this.device.id, { agentId, ...rest })
					.then((ack) => this.reply(env, "user.message.ack", ack))
					.catch((e) => {
						if (e instanceof RelayError) this.conn.send(errorEnvelope(e.code, e.message, env.id, e.reason));
						else this.conn.send(errorEnvelope(ErrorCode.Internal, "error interno", env.id));
					});
				return;
			}
			case "agent.abort":
				messages.abort(d.agentId);
				this.reply(env, "ack");
				return;
			case "prompt.answer": {
				const r = prompts.answer(d.promptId, d.answer as Answer, this.device.id, { conn: this.conn, reqId: env.id });
				if (r.ok)
					this.reply(
						env,
						"prompt.answer.result",
						r.queued ? { ok: true, reason: "agent_offline_queued" } : { ok: true },
					);
				else this.reply(env, "prompt.answer.result", { ok: false, reason: r.reason });
				return;
			}
			case "agent.forget": {
				const a = repos.agents.get(d.agentId);
				if (!a) throw new RelayError("not_found", "agente desconocido");
				if (!agents.forget(d.agentId)) throw new RelayError("conflict", "no se puede olvidar un agente conectado");
				this.reply(env, "ack");
				return;
			}
			case "push.ack":
				dispatcher.ackDirect(this.device.id, d.pushId);
				return;
			case "host.list_dirs":
			case "host.herdr_layout":
			case "host.spawn":
			case "host.kill":
				hosts.forward(this.conn, env);
				return;
		}
	}

	onClose(): void {
		this.c().hub.removeApp(this.conn);
	}
}

/** Gateway WS `/ws/app?mode=foreground|direct`. */
export function handleAppSocket(
	c: () => Ctx,
	socket: WebSocket,
	device: DeviceRow,
	mode: "foreground" | "direct",
): void {
	const conn = new WsAppConn(socket, device.id, mode);
	const session = new AppSession(c, conn, device);
	const { hub, log } = c();
	hub.addApp(conn);
	log.info({ deviceId: device.id, mode, connId: conn.id }, "app conectada");
	startHeartbeat(socket, { onPong: () => session.touch() });
	const helloTimer = setTimeout(() => {
		if (!session.ready) conn.close(CloseCode.InvalidFrame, "hello timeout");
	}, c().config.limits.helloTimeoutMs);
	helloTimer.unref();

	socket.on("message", (data, isBinary) => {
		if (isBinary) {
			conn.close(CloseCode.InvalidFrame, "binary frame");
			return;
		}
		const parsed = parseFrame(data as Buffer);
		if (!parsed.ok) {
			conn.send(
				errorEnvelope(parsed.reason === "too_large" ? ErrorCode.TooLarge : ErrorCode.BadRequest, parsed.message),
			);
			conn.close(CloseCode.InvalidFrame, parsed.reason);
			return;
		}
		session.handle(parsed.env);
	});
	socket.on("close", (code) => {
		clearTimeout(helloTimer);
		session.onClose();
		log.info({ deviceId: device.id, mode, connId: conn.id, code }, "app desconectada");
	});
	socket.on("error", (e) => log.debug({ err: e.message }, "error de socket de app"));
}
