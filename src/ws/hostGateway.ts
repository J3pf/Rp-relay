import { CloseCode, type Envelope, ErrorCode, errorEnvelope, type MachineQuota } from "@j3pf/rp-protocol";
import type { WebSocket } from "ws";
import type { Ctx } from "../context.js";
import type { MachineRow } from "../db/repos/index.js";
import { bindWsGateway, type HostConn, startHeartbeat, validateGatewayEnvelope, WsConn } from "./conn.js";

class WsHostConn extends WsConn implements HostConn {
	ready = false;
	constructor(
		socket: WebSocket,
		readonly machineId: string,
		hardBufferedBytes?: number,
	) {
		super(socket, hardBufferedBytes);
	}
}

/** Gateway WS `/ws/host` (rp-host, PROTOCOLO §9). */
export function handleHostSocket(c: () => Ctx, socket: WebSocket, machine: MachineRow): void {
	const conn = new WsHostConn(socket, machine.id, c().config.limits.hardBufferedBytes);
	const { log, hosts } = c();
	startHeartbeat(socket);

	const handle = (env: Envelope) => {
		if (
			validateGatewayEnvelope({
				conn,
				env,
				channel: "hostUp",
				helloType: "host.hello",
				ready: conn.ready,
				log,
				logContext: { machineId: machine.id },
				logMessage: "host → relay",
			}) !== "ok"
		) {
			return;
		}
		if (env.t === "host.hello") {
			const h = env.d as { machineId: string; hostname: string; roots: string[]; quotas?: MachineQuota[] };
			if (c().repos.machines.get(machine.id)?.revoked_at) {
				conn.send(errorEnvelope(ErrorCode.Unauthorized, "PC revocada", env.id));
				conn.close(CloseCode.Unauthorized, "machine revoked");
				return;
			}
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
