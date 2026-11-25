import {
	type Channel,
	CloseCode,
	type Envelope,
	ErrorCode,
	errorEnvelope,
	MIN_PROTOCOL_VERSION,
	PING_INTERVAL_MS,
	PONG_TIMEOUT_MS,
	PROTOCOL_VERSION,
	parseFrame,
	validateMessage,
} from "@j3pf/rp-protocol";
import type { Logger } from "pino";
import { WebSocket } from "ws";

/** Conexión abstracta: WebSocket real o adaptador long-poll. */
export interface Conn {
	send(env: Envelope): boolean;
	sendSerialized?(raw: string): boolean;
	close(code: number, reason?: string): void;
	readonly bufferedAmount: number;
	readonly closed?: boolean;
}

export type AppMode = "foreground" | "direct";

export interface AgentConn extends Conn {
	readonly transport: "ws" | "longpoll";
	agentId: string | null;
	machineId: string;
	instance: string | null;
	epoch: string | null;
	/** Último `seq` aceptado de la conexión actual (descarta reenvíos). */
	lastSeq: number;
	lastTouchAt?: number;
}

export interface AppConn extends Conn {
	readonly id: string;
	readonly deviceId: string;
	readonly mode: AppMode;
	/** `agentId`s a los que está suscrita para eventos en vivo. */
	readonly subs: Set<string>;
	ready: boolean;
	/** Estado de pantalla del dispositivo (por defecto `true` para clientes que no envían `app.state`). */
	screenOn?: boolean;
}

export interface HostConn extends Conn {
	readonly machineId: string;
	ready: boolean;
}

const SLOW_CONSUMER_TERMINATE_MS = 500;

export class WsConn implements Conn {
	closed = false;
	private terminateTimer: NodeJS.Timeout | undefined;
	constructor(
		readonly socket: WebSocket,
		private readonly hardBufferedBytes = Number.POSITIVE_INFINITY,
	) {}
	send(env: Envelope): boolean {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
		if (this.socket.bufferedAmount > this.hardBufferedBytes) {
			this.close(CloseCode.TryAgainLater, "slow consumer");
			return false;
		}
		return this.sendSerialized(JSON.stringify(env));
	}
	sendSerialized(raw: string): boolean {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
		if (this.socket.bufferedAmount > this.hardBufferedBytes) {
			this.close(CloseCode.TryAgainLater, "slow consumer");
			return false;
		}
		try {
			this.socket.send(raw);
			return true;
		} catch {
			return false;
		}
	}
	get bufferedAmount(): number {
		return this.socket.bufferedAmount;
	}
	close(code: number, reason?: string): void {
		this.closed = true;
		try {
			if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
				const stalled = code === CloseCode.TryAgainLater && this.socket.bufferedAmount > this.hardBufferedBytes;
				this.socket.close(code, reason?.slice(0, 120));
				if (stalled) this.scheduleTerminate();
			}
		} catch {
			this.socket.terminate();
		}
	}
	private scheduleTerminate(): void {
		if (this.terminateTimer || this.socket.readyState === WebSocket.CLOSED) return;
		const clear = () => {
			if (this.terminateTimer) {
				clearTimeout(this.terminateTimer);
				this.terminateTimer = undefined;
			}
		};
		this.socket.once("close", clear);
		this.terminateTimer = setTimeout(() => {
			this.terminateTimer = undefined;
			this.socket.off("close", clear);
			if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
		}, SLOW_CONSUMER_TERMINATE_MS);
		this.terminateTimer.unref();
	}
}

export function bindWsGateway(opts: {
	socket: WebSocket;
	conn: WsConn;
	helloTimeoutMs: number;
	isReady: () => boolean;
	onEnvelope: (env: Envelope, frameBytes: number) => void;
	onClose: (code: number) => void;
	onError: (err: Error) => void;
}): void {
	const helloTimer = setTimeout(() => {
		if (!opts.isReady()) opts.conn.close(CloseCode.InvalidFrame, "hello timeout");
	}, opts.helloTimeoutMs);
	helloTimer.unref();

	opts.socket.on("message", (data, isBinary) => {
		if (opts.conn.closed) return;
		if (isBinary) {
			opts.conn.send(errorEnvelope(ErrorCode.BadRequest, "sólo se admiten frames de texto"));
			opts.conn.close(CloseCode.InvalidFrame, "binary frame");
			return;
		}
		const frameBytes = Buffer.isBuffer(data)
			? data.length
			: Array.isArray(data)
				? data.reduce((sum, chunk) => sum + chunk.length, 0)
				: data.byteLength;
		const parsed = parseFrame(data as Buffer);
		if (!parsed.ok) {
			opts.conn.send(
				errorEnvelope(parsed.reason === "too_large" ? ErrorCode.TooLarge : ErrorCode.BadRequest, parsed.message),
			);
			opts.conn.close(CloseCode.InvalidFrame, parsed.reason);
			return;
		}
		opts.onEnvelope(parsed.env, frameBytes);
	});
	opts.socket.on("close", (code) => {
		opts.conn.closed = true;
		clearTimeout(helloTimer);
		opts.onClose(code);
	});
	opts.socket.on("error", opts.onError);
}

export type GatewayEnvelopeCheck = "ok" | "invalid" | "closed";

/**
 * Validates an inbound gateway envelope: closed-conn guard, protocol version, hello-first ordering,
 * TypeBox schema check, and consistent debug/trace logging.
 */
export function validateGatewayEnvelope(opts: {
	conn: Conn;
	env: Envelope;
	channel: Channel;
	helloType: string;
	ready: boolean;
	log: Logger;
	logContext: Record<string, unknown>;
	logMessage: string;
	frameBytes?: number;
}): GatewayEnvelopeCheck {
	const { conn, env, channel, helloType, ready, log, logContext, logMessage, frameBytes } = opts;
	if (conn.closed) return "closed";
	if (env.v < MIN_PROTOCOL_VERSION || env.v > PROTOCOL_VERSION) {
		conn.send(
			errorEnvelope(
				ErrorCode.BadRequest,
				`versión de protocolo ${env.v} no soportada (el relay habla v${PROTOCOL_VERSION})`,
				env.id,
			),
		);
		conn.close(CloseCode.IncompatibleVersion, "incompatible protocol version");
		return "closed";
	}
	if (!ready && env.t !== helloType) {
		conn.send(errorEnvelope(ErrorCode.BadRequest, `el primer mensaje debe ser ${helloType}`, env.id));
		conn.close(CloseCode.InvalidFrame, "hello required");
		return "closed";
	}
	const v = validateMessage(channel, env);
	if (!v.ok) {
		conn.send(errorEnvelope(ErrorCode.BadRequest, v.message, env.id));
		if (env.t === helloType) {
			conn.close(CloseCode.InvalidFrame, "invalid hello");
			return "closed";
		}
		return "invalid";
	}
	if (log.isLevelEnabled("trace")) log.trace({ ...logContext, t: env.t, d: env.d }, logMessage);
	else if (log.isLevelEnabled("debug")) {
		log.debug({ ...logContext, t: env.t, bytes: frameBytes ?? JSON.stringify(env.d ?? null).length }, logMessage);
	}
	return "ok";
}

/** Ping WS tras inactividad (`pingMs`); omite pings redundantes si hubo tráfico reciente y termina si no hay pong en `pongMs`. */
export function startHeartbeat(
	socket: WebSocket,
	opts: { pingMs?: number; pongMs?: number; onPong?: () => void } = {},
): () => void {
	const pingMs = opts.pingMs ?? PING_INTERVAL_MS;
	const pongMs = opts.pongMs ?? PONG_TIMEOUT_MS;
	let lastRxAt = Date.now();
	let pingTimer: NodeJS.Timeout | undefined;
	let pongTimer: NodeJS.Timeout | undefined;
	let stopped = false;

	const schedule = (delayMs: number) => {
		if (stopped) return;
		if (pingTimer) clearTimeout(pingTimer);
		pingTimer = setTimeout(onTick, Math.max(1, delayMs));
		pingTimer.unref();
	};

	const onTick = () => {
		pingTimer = undefined;
		if (stopped || socket.readyState !== WebSocket.OPEN) return;
		const idleMs = Date.now() - lastRxAt;
		if (idleMs < pingMs) {
			schedule(pingMs - idleMs);
			return;
		}
		try {
			socket.ping();
		} catch {
			return;
		}
		pongTimer ??= setTimeout(() => socket.terminate(), pongMs);
		pongTimer.unref();
	};

	const onPong = () => {
		lastRxAt = Date.now();
		if (pongTimer) {
			clearTimeout(pongTimer);
			pongTimer = undefined;
		}
		opts.onPong?.();
		schedule(pingMs);
	};

	const onMessage = () => {
		lastRxAt = Date.now();
		if (pongTimer) {
			clearTimeout(pongTimer);
			pongTimer = undefined;
			schedule(pingMs);
		}
	};

	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (pingTimer) {
			clearTimeout(pingTimer);
			pingTimer = undefined;
		}
		if (pongTimer) {
			clearTimeout(pongTimer);
			pongTimer = undefined;
		}
		socket.off("pong", onPong);
		socket.off("message", onMessage);
	};

	socket.on("pong", onPong);
	socket.on("message", onMessage);
	socket.once("close", stop);
	schedule(pingMs);
	return stop;
}
