import {
	CloseCode,
	type Envelope,
	ErrorCode,
	errorEnvelope,
	MIN_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	parseFrame,
	validateMessage,
} from "@j3pf/rp-protocol";
import type { WebSocket } from "ws";
import type { Ctx } from "../context.js";
import type { MachineRow } from "../db/repos/index.js";
import { type HostConn, startHeartbeat, WsConn } from "./conn.js";

class WsHostConn extends WsConn implements HostConn {
	ready = false;
	constructor(
		socket: WebSocket,
		readonly machineId: string,
	) {
		super(socket);
	}
}

/** Gateway WS `/ws/host` (rp-host, PROTOCOLO §9). */
export function handleHostSocket(c: () => Ctx, socket: WebSocket, machine: MachineRow): void {
	const conn = new WsHostConn(socket, machine.id);
	const { log, hosts } = c();
	startHeartbeat(socket);
	const helloTimer = setTimeout(() => {
		if (!conn.ready) conn.close(CloseCode.InvalidFrame, "hello timeout");
	}, c().config.limits.helloTimeoutMs);
	helloTimer.unref();

	const handle = (env: Envelope) => {
		if (env.v < MIN_PROTOCOL_VERSION || env.v > PROTOCOL_VERSION) {
			conn.send(errorEnvelope(ErrorCode.BadRequest, "versión de protocolo no soportada", env.id));
			conn.close(CloseCode.IncompatibleVersion, "incompatible protocol version");
			return;
		}
		if (!conn.ready && env.t !== "host.hello") {
			conn.send(errorEnvelope(ErrorCode.BadRequest, "el primer mensaje debe ser host.hello", env.id));
			conn.close(CloseCode.InvalidFrame, "hello required");
			return;
		}
		const v = validateMessage("hostUp", env);
		if (!v.ok) {
			conn.send(errorEnvelope(ErrorCode.BadRequest, v.message, env.id));
			if (env.t === "host.hello") conn.close(CloseCode.InvalidFrame, "invalid hello");
			return;
		}
		if (env.t === "host.hello") {
			const h = env.d as { machineId: string; hostname: string; roots: string[] };
			if (h.machineId !== machine.id) {
				conn.send(errorEnvelope(ErrorCode.Unauthorized, "machineId no coincide con el token", env.id));
				conn.close(CloseCode.Unauthorized, "machine mismatch");
				return;
			}
			conn.ready = true;
			hosts.onHostHello(conn, h);
			return;
		}
		hosts.onHostReply(conn, env);
	};

	socket.on("message", (data, isBinary) => {
		if (isBinary) return void conn.close(CloseCode.InvalidFrame, "binary frame");
		const parsed = parseFrame(data as Buffer);
		if (!parsed.ok) {
			conn.send(errorEnvelope(ErrorCode.BadRequest, parsed.message));
			return void conn.close(CloseCode.InvalidFrame, parsed.reason);
		}
		try {
			handle(parsed.env);
		} catch (e) {
			log.error({ err: (e as Error).message }, "error procesando mensaje del host");
		}
	});
	socket.on("close", () => {
		clearTimeout(helloTimer);
		hosts.onHostClose(conn);
	});
	socket.on("error", (e) => log.debug({ err: e.message }, "error de socket de host"));
}
