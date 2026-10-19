import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { CloseCode, MAX_FRAME_BYTES } from "@j3pf/rp-protocol";
import { WebSocketServer } from "ws";
import type { Ctx } from "../context.js";
import { handleAgentSocket } from "./agentGateway.js";
import { handleAppSocket } from "./appGateway.js";
import { handleHostSocket } from "./hostGateway.js";

type UpgradeServer = Pick<Server, "on" | "off">;

/**
 * Monta los tres endpoints WebSocket sobre el servidor HTTP de Fastify (`ws` en modo `noServer`).
 * Con token inválido se completa el upgrade y se cierra con `4001`, para que el cliente reciba el código
 * (PROTOCOLO §1: "no reconectar").
 */
export function attachWebSockets(server: UpgradeServer, c: () => Ctx): { close(): void } {
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_FRAME_BYTES,
		perMessageDeflate: { threshold: 1024 },
	});

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const ctx = c();
		const reject = (status: string) => {
			socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
			socket.destroy();
		};
		switch (url.pathname) {
			case "/ws/agent": {
				const auth = ctx.auth.machine(req.headers);
				wss.handleUpgrade(req, socket, head, (ws) => {
					if (!auth.ok) return void ws.close(CloseCode.Unauthorized, `unauthorized: ${auth.reason}`);
					handleAgentSocket(c, ws, auth.row);
				});
				return;
			}
			case "/ws/host": {
				const auth = ctx.auth.machine(req.headers);
				wss.handleUpgrade(req, socket, head, (ws) => {
					if (!auth.ok) return void ws.close(CloseCode.Unauthorized, `unauthorized: ${auth.reason}`);
					handleHostSocket(c, ws, auth.row);
				});
				return;
			}
			case "/ws/app": {
				const auth = ctx.auth.device(req.headers);
				const mode = url.searchParams.get("mode") === "direct" ? "direct" : "foreground";
				wss.handleUpgrade(req, socket, head, (ws) => {
					if (!auth.ok) return void ws.close(CloseCode.Unauthorized, `unauthorized: ${auth.reason}`);
					handleAppSocket(c, ws, auth.row, mode);
				});
				return;
			}
			default:
				reject("404 Not Found");
		}
	};

	server.on("upgrade", onUpgrade);
	return {
		close() {
			server.off("upgrade", onUpgrade);
			for (const client of wss.clients) client.terminate();
			wss.close();
		},
	};
}
