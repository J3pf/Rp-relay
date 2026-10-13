/**
 * Spike S3 (R0): Fastify + ws con eco y autenticación Bearer, para probar el WebSocket detrás de Caddy
 * (y detrás del proxy corporativo) antes de depender de él.
 *
 *   npx tsx spikes/s3-echo.ts --port 8788 --token secreto
 *   # directo:   wscat -c ws://127.0.0.1:8788/ws/echo -H "Authorization: Bearer secreto"
 *   # con Caddy: ver docs/spikes/S3-ws-eco.md
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import Fastify from "fastify";
import { WebSocketServer } from "ws";

export interface EchoServer {
	port: number;
	close(): Promise<void>;
}

export async function startEcho(opts: { port: number; token: string; host?: string }): Promise<EchoServer> {
	const app = Fastify();
	app.get("/healthz", async () => ({ ok: true }));
	await app.ready();
	const server = createServer((req, res) => {
		app.routing(req, res);
	});
	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://x");
		const ok = req.headers.authorization === `Bearer ${opts.token}`;
		if (url.pathname !== "/ws/echo") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			// mismo criterio que el relay: se completa el upgrade y se cierra con 4001 para que el cliente vea el código
			if (!ok) return void ws.close(4001, "unauthorized");
			ws.send(JSON.stringify({ t: "hello", via: req.headers["x-forwarded-for"] ?? "directo" }));
			ws.on("message", (data) => ws.send(data.toString()));
			ws.on("ping", () => {});
		});
	});
	await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return {
		port,
		async close() {
			for (const c of wss.clients) c.terminate();
			wss.close();
			await new Promise<void>((r) => server.close(() => r()));
			await app.close();
		},
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { values } = parseArgs({
		options: { port: { type: "string", default: "8788" }, token: { type: "string", default: "secreto" } },
	});
	const s = await startEcho({ port: Number(values.port), token: values.token as string });
	console.log(`eco WS en ws://127.0.0.1:${s.port}/ws/echo (Authorization: Bearer ${values.token})`);
}
