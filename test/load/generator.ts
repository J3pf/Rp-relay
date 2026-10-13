import { type Envelope, newMessageId, PROTOCOL_VERSION } from "@j3pf/rp-protocol";
import { WebSocket } from "ws";

export interface LoadOptions {
	/** URL base del relay (http://host:puerto) */
	baseUrl: string;
	/** emparejar: devuelve token de PC y de dispositivo */
	pair(): Promise<{ machineId: string; machineToken: string; deviceId: string; deviceToken: string }>;
	agents: number;
	apps: number;
	/** eventos por segundo y por agente */
	rate: number;
	durationSec: number;
	log?: (m: string) => void;
}

export interface LoadResult {
	agents: number;
	apps: number;
	sent: number;
	received: number;
	expectedReceived: number;
	lostFinals: number;
	latencyMs: { p50: number; p95: number; p99: number; max: number };
	aggregateEventsPerSec: number;
	rssMb?: number;
}

const wsUrl = (u: string) => u.replace(/^http/, "ws");

function open(url: string, token: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/**
 * Carga sintética (RESILIENCIA §4): N agentes emiten eventos con marca de tiempo (80 % deltas, 10 % updates de herramienta,
 * 10 % `message_end` persistidos); M apps suscritas a todos miden la latencia de reenvío y verifican que no se pierden
 * eventos finales.
 */
export async function runLoad(o: LoadOptions): Promise<LoadResult> {
	const log = o.log ?? (() => {});
	const ids = await o.pair();
	const agentSockets: { ws: WebSocket; agentId: string; epoch: string; seq: number; finalsSent: number }[] = [];
	for (let i = 0; i < o.agents; i++) {
		const ws = await open(`${wsUrl(o.baseUrl)}/ws/agent`, ids.machineToken);
		const agentId = `${ids.machineId}:load-${i}`;
		const epoch = newMessageId();
		const send = (t: string, d: unknown) =>
			ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t, id: newMessageId(), ts: Date.now(), d }));
		const welcomed = new Promise<void>((resolve) => ws.once("message", () => resolve()));
		send("agent.hello", {
			agentId,
			kind: "pi",
			instance: newMessageId(),
			epoch,
			pi: { version: "1.2.0", mode: "tui" },
			plugin: { version: "load", features: [] },
			session: { id: `load-${i}`, name: `carga ${i}` },
			host: { hostname: "load" },
			status: "working",
			openPrompts: [],
		});
		await welcomed;
		send("agent.snapshot", { epoch, seq: 0, entries: [] });
		agentSockets.push({ ws, agentId, epoch, seq: 0, finalsSent: 0 });
	}

	const lat: number[] = [];
	let received = 0;
	const finalsSeen = new Map<string, Set<number>>();
	const appSockets: WebSocket[] = [];
	for (let a = 0; a < o.apps; a++) {
		const ws = await open(`${wsUrl(o.baseUrl)}/ws/app`, ids.deviceToken);
		ws.on("message", (raw) => {
			const env = JSON.parse(raw.toString()) as Envelope;
			if (env.t !== "agent.event") return;
			const d = env.d as { agentId: string; seq: number; e: { type: string; at?: number } };
			received++;
			if (d.e.at) lat.push(Date.now() - d.e.at);
			if (d.e.type === "message_end") {
				const key = `${a}:${d.agentId}`;
				const seen = finalsSeen.get(key) ?? new Set<number>();
				seen.add(d.seq);
				finalsSeen.set(key, seen);
			}
		});
		ws.send(
			JSON.stringify({
				v: PROTOCOL_VERSION,
				t: "app.hello",
				id: newMessageId(),
				d: { deviceId: ids.deviceId, app: { version: "load" } },
			}),
		);
		await new Promise<void>((resolve) => ws.once("message", () => resolve()));
		for (const ag of agentSockets)
			ws.send(
				JSON.stringify({
					v: PROTOCOL_VERSION,
					t: "agent.subscribe",
					id: newMessageId(),
					d: { agentId: ag.agentId, sinceSeq: null, epoch: null },
				}),
			);
		appSockets.push(ws);
	}
	await new Promise((r) => setTimeout(r, 500)); // deja pasar los agent.history

	log(`generando ${o.agents} agentes × ${o.rate} ev/s durante ${o.durationSec} s con ${o.apps} apps…`);
	const tickMs = 50;
	const perTick = (o.rate * tickMs) / 1000;
	let sent = 0;
	let carry = 0;
	const started = Date.now();
	const startReceived = received;
	await new Promise<void>((resolve) => {
		const timer = setInterval(() => {
			const now = Date.now();
			if (now - started >= o.durationSec * 1000) {
				clearInterval(timer);
				resolve();
				return;
			}
			carry += perTick;
			const n = Math.floor(carry);
			carry -= n;
			for (const ag of agentSockets) {
				for (let k = 0; k < n; k++) {
					ag.seq++;
					const r = ag.seq % 10;
					const e =
						r === 0
							? {
									type: "message_end",
									at: now,
									message: { role: "assistant", content: [{ type: "text", text: "x".repeat(60) }] },
								}
							: r === 1
								? { type: "tool_execution_update", at: now, partialResult: "y".repeat(40) }
								: { type: "message_delta", at: now, contentIndex: 0, kind: "text", delta: "z".repeat(20) };
					if (r === 0) ag.finalsSent++;
					ag.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t: "agent.event", d: { epoch: ag.epoch, seq: ag.seq, e } }));
					sent++;
				}
			}
		}, tickMs);
	});
	await new Promise((r) => setTimeout(r, 1000)); // drenaje

	let lostFinals = 0;
	for (let a = 0; a < o.apps; a++)
		for (const ag of agentSockets) lostFinals += ag.finalsSent - (finalsSeen.get(`${a}:${ag.agentId}`)?.size ?? 0);
	lat.sort((x, y) => x - y);
	const elapsed = (Date.now() - started) / 1000;
	for (const ws of [...appSockets, ...agentSockets.map((a) => a.ws)]) ws.close();
	return {
		agents: o.agents,
		apps: o.apps,
		sent,
		received: received - startReceived,
		expectedReceived: sent * o.apps,
		lostFinals,
		latencyMs: {
			p50: percentile(lat, 50),
			p95: percentile(lat, 95),
			p99: percentile(lat, 99),
			max: lat[lat.length - 1] ?? 0,
		},
		aggregateEventsPerSec: Math.round(sent / elapsed),
	};
}
