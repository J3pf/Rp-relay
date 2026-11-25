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
	/** Subscribe apps to mesh snapshots/updates and emit periodic inter-agent `comm` events. */
	mesh?: boolean;
	/** Attach an extra paused app WebSocket to exercise slow-consumer backpressure/eviction. */
	slowConsumer?: boolean;
	/** Periodically invoke a live backup callback during the load window. */
	backup?: {
		trigger: () => Promise<boolean>;
		intervalMs?: number;
	};
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
	meshUpdatesReceived?: number;
	meshCommsReceived?: number;
	slowConsumerEvicted?: boolean;
	backupsCompleted?: number;
	backupErrors?: number;
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
	let meshUpdatesReceived = 0;
	let meshCommsReceived = 0;
	const finalsSeen = new Map<string, Set<number>>();
	const appSockets: WebSocket[] = [];
	for (let a = 0; a < o.apps; a++) {
		const ws = await open(`${wsUrl(o.baseUrl)}/ws/app`, ids.deviceToken);
		ws.on("message", (raw) => {
			const env = JSON.parse(raw.toString()) as Envelope;
			if (env.t === "mesh.update") {
				meshUpdatesReceived++;
				return;
			}
			if (env.t === "mesh.comm") {
				meshCommsReceived++;
				return;
			}
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
		if (o.mesh) {
			ws.send(
				JSON.stringify({
					v: PROTOCOL_VERSION,
					t: "mesh.subscribe",
					id: newMessageId(),
					d: { machineId: null },
				}),
			);
		}
		appSockets.push(ws);
	}

	let slowWs: WebSocket | undefined;
	let slowConsumerEvicted = false;
	if (o.slowConsumer) {
		slowWs = await open(`${wsUrl(o.baseUrl)}/ws/app`, ids.deviceToken);
		slowWs.on("error", () => {});
		slowWs.once("close", () => {
			slowConsumerEvicted = true;
		});
		slowWs.send(
			JSON.stringify({
				v: PROTOCOL_VERSION,
				t: "app.hello",
				id: newMessageId(),
				d: { deviceId: ids.deviceId, app: { version: "load-slow" } },
			}),
		);
		await new Promise<void>((resolve) => slowWs!.once("message", () => resolve()));
		for (const ag of agentSockets) {
			slowWs.send(
				JSON.stringify({
					v: PROTOCOL_VERSION,
					t: "agent.subscribe",
					id: newMessageId(),
					d: { agentId: ag.agentId, sinceSeq: null, epoch: null },
				}),
			);
		}
		if (o.mesh) {
			slowWs.send(
				JSON.stringify({
					v: PROTOCOL_VERSION,
					t: "mesh.subscribe",
					id: newMessageId(),
					d: { machineId: null },
				}),
			);
		}
	}
	await new Promise((r) => setTimeout(r, 500)); // deja pasar los agent.history
	if (slowWs) {
		(slowWs as unknown as { _socket?: { pause?: () => void } })._socket?.pause?.();
	}

	let backupsCompleted = 0;
	let backupErrors = 0;
	let backupStopped = false;
	let inFlightBackup: Promise<void> | undefined;
	let backupTimer: NodeJS.Timeout | undefined;
	if (o.backup) {
		const triggerBackup = () => {
			if (backupStopped || inFlightBackup) return;
			inFlightBackup = o
				.backup!.trigger()
				.then((ok) => {
					if (ok) backupsCompleted++;
					else backupErrors++;
				})
				.catch(() => {
					backupErrors++;
				})
				.finally(() => {
					inFlightBackup = undefined;
				});
		};
		const intervalMs = Math.max(250, o.backup.intervalMs ?? 2_000);
		backupTimer = setInterval(triggerBackup, intervalMs);
		backupTimer.unref();
		triggerBackup();
	}

	const modes = [o.mesh && "mesh", o.backup && "backup", o.slowConsumer && "slow-consumer"].filter(Boolean);
	log(
		`generando ${o.agents} agentes × ${o.rate} ev/s durante ${o.durationSec} s con ${o.apps} apps${modes.length ? ` [${modes.join(", ")}]` : ""}…`,
	);
	const tickMs = 50;
	let sent = 0;
	let carry = 0;
	const started = Date.now();
	let lastTick = started;
	let sendEnded = started;
	const startReceived = received;
	await new Promise<void>((resolve) => {
		const timer = setInterval(() => {
			const now = Date.now();
			if (now - started >= o.durationSec * 1000) {
				clearInterval(timer);
				sendEnded = Date.now();
				resolve();
				return;
			}
			const deltaMs = Math.max(1, now - lastTick);
			lastTick = now;
			carry += (o.rate * deltaMs) / 1000;
			const n = Math.floor(carry);
			carry -= n;
			if (n <= 0) return;
			for (let idx = 0; idx < agentSockets.length; idx++) {
				const ag = agentSockets[idx]!;
				for (let k = 0; k < n; k++) {
					ag.seq++;
					const r = ag.seq % 10;
					let e: Record<string, unknown>;
					if (r === 0) {
						ag.finalsSent++;
						e = {
							type: "message_end",
							at: now,
							message: { role: "assistant", content: [{ type: "text", text: "x".repeat(60) }] },
						};
					} else if (o.mesh && agentSockets.length >= 2 && ag.seq % 20 === 5) {
						const peerIdx = (idx + 1) % agentSockets.length;
						e = {
							type: "comm",
							commId: newMessageId(),
							direction: "out",
							channel: "intercom",
							action: "send",
							peer: { sessionId: `load-${peerIdx}`, name: `carga ${peerIdx}`, cwd: null, ref: null },
							messageId: newMessageId(),
							replyTo: null,
							expectsReply: false,
							text: "load mesh comm",
							truncated: false,
							at: now,
						};
					} else if (r === 1) {
						e = { type: "tool_execution_update", at: now, partialResult: "y".repeat(40) };
					} else {
						e = { type: "message_delta", at: now, contentIndex: 0, kind: "text", delta: "z".repeat(20) };
					}
					ag.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t: "agent.event", d: { epoch: ag.epoch, seq: ag.seq, e } }));
					sent++;
				}
			}
		}, tickMs);
	});
	backupStopped = true;
	if (backupTimer) clearInterval(backupTimer);
	if (inFlightBackup) await inFlightBackup;
	const sendDurationSec = Math.max(0.001, (sendEnded - started) / 1000);
	await new Promise((r) => setTimeout(r, 1000)); // drenaje

	let lostFinals = 0;
	for (let a = 0; a < o.apps; a++)
		for (const ag of agentSockets) lostFinals += ag.finalsSent - (finalsSeen.get(`${a}:${ag.agentId}`)?.size ?? 0);
	lat.sort((x, y) => x - y);
	const evictedBeforeTeardown = slowConsumerEvicted;
	if (slowWs) slowWs.terminate();
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
		aggregateEventsPerSec: Math.round(sent / sendDurationSec),
		...(o.mesh ? { meshUpdatesReceived, meshCommsReceived } : {}),
		...(o.slowConsumer ? { slowConsumerEvicted: evictedBeforeTeardown } : {}),
		...(o.backup ? { backupsCompleted, backupErrors } : {}),
	};
}
