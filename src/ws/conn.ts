import {
	CloseCode,
	type Envelope,
	ErrorCode,
	errorEnvelope,
	PING_INTERVAL_MS,
	PONG_TIMEOUT_MS,
	parseFrame,
} from "@j3pf/rp-protocol";
import { WebSocket } from "ws";

/** Conexión abstracta: WebSocket real o adaptador long-poll. */
export interface Conn {
	send(env: Envelope): boolean;
	close(code: number, reason?: string): void;
	readonly bufferedAmount: number;
	readonly closed?: boolean | { code: number; reason: string } | null;
}

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
	readonly mode: "foreground" | "direct";
	/** `agentId`s a los que está suscrita para eventos en vivo. */
	readonly subs: Set<string>;
	ready: boolean;
}

export interface HostConn extends Conn {
	readonly machineId: string;
	ready: boolean;
}

export class WsConn implements Conn {
	closed = false;
	constructor(readonly socket: WebSocket) {}
	send(env: Envelope): boolean {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
		try {
			this.socket.send(JSON.stringify(env));
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
			if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
				this.socket.close(code, reason?.slice(0, 120));
		} catch {
			this.socket.terminate();
		}
	}
}

export function bindWsGateway(opts: {
	socket: WebSocket;
	conn: WsConn;
	helloTimeoutMs: number;
	isReady: () => boolean;
	onEnvelope: (env: Envelope) => void;
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
		const parsed = parseFrame(data as Buffer);
		if (!parsed.ok) {
			opts.conn.send(
				errorEnvelope(parsed.reason === "too_large" ? ErrorCode.TooLarge : ErrorCode.BadRequest, parsed.message),
			);
			opts.conn.close(CloseCode.InvalidFrame, parsed.reason);
			return;
		}
		opts.onEnvelope(parsed.env);
	});
	opts.socket.on("close", (code) => {
		opts.conn.closed = true;
		clearTimeout(helloTimer);
		opts.onClose(code);
	});
	opts.socket.on("error", opts.onError);
}

/** Ping WS cada 25 s; si no hay pong en 10 s se termina la conexión (PROTOCOLO §1). */
export function startHeartbeat(
	socket: WebSocket,
	opts: { pingMs?: number; pongMs?: number; onPong?: () => void } = {},
): () => void {
	const pingMs = opts.pingMs ?? PING_INTERVAL_MS;
	const pongMs = opts.pongMs ?? PONG_TIMEOUT_MS;
	let pongTimer: NodeJS.Timeout | undefined;
	const onPong = () => {
		if (pongTimer) clearTimeout(pongTimer);
		pongTimer = undefined;
		opts.onPong?.();
	};
	socket.on("pong", onPong);
	const timer = setInterval(() => {
		if (socket.readyState !== WebSocket.OPEN) return;
		try {
			socket.ping();
		} catch {
			return;
		}
		pongTimer ??= setTimeout(() => socket.terminate(), pongMs);
		pongTimer.unref();
	}, pingMs);
	timer.unref();
	const stop = () => {
		clearInterval(timer);
		if (pongTimer) clearTimeout(pongTimer);
	};
	socket.once("close", stop);
	return stop;
}
