import {
	CloseCode,
	type Envelope,
	ErrorCode,
	errorEnvelope,
	type MachineQuota,
	MIN_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	validateMessage,
} from "@j3pf/rp-protocol";
import type { WebSocket } from "ws";
import type { Ctx } from "../context.js";
import type { MachineRow } from "../db/repos/index.js";
import { bindWsGateway, type HostConn, startHeartbeat, WsConn } from "./conn.js";

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
			const h = env.d as { machineId: string; hostname: string; roots: string[]; quotas?: MachineQuota[] };
			if (h.machineId !== machine.id) {
				conn.send(errorEnvelope(ErrorCode.Unauthorized, "machineId no coincide con el token", env.id));
				conn.close(CloseCode.Unauthorized, "machine mismatch");
				return;
			}
			conn.ready = true;
			hosts.onHostHello(conn, h);
			return;
		}
		if (env.t === "host.quotas") {
			hosts.onHostQuotas(conn, env.d as { quotas: MachineQuota[] });
			return;
		}
		hosts.onHostReply(conn, env);
	};

	bindWsGateway({
		socket,
		conn,
		helloTimeoutMs: c().config.limits.helloTimeoutMs,
		isReady: () => conn.ready,
		onEnvelope: (env) => {
			try {
				handle(env);
			} catch (e) {
				log.error({ err: (e as Error).message, t: env.t }, "error procesando mensaje del host");
				conn.send(errorEnvelope(ErrorCode.Internal, "error interno", env.id));
			}
		},
		onClose: () => {
			hosts.onHostClose(conn);
		},
		onError: (e) => log.debug({ err: e.message }, "error de socket de host"),
	});
}
