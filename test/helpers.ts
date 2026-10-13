import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Envelope, newMessageId, PROTOCOL_VERSION } from "@j3pf/rp-protocol";
import { WebSocket } from "ws";
import { type Config, parseConfig } from "../src/config.js";
import type { FcmMessage, FcmSender } from "../src/push/fcm.js";
import { Relay } from "../src/relay.js";
import { createLogger } from "../src/util/log.js";

export class FakeFcm implements FcmSender {
	sent: FcmMessage[] = [];
	fail: Error | null = null;
	async send(msg: FcmMessage): Promise<void> {
		if (this.fail) throw this.fail;
		this.sent.push(msg);
	}
}

export interface TestRelay {
	relay: Relay;
	dir: string;
	config: Config;
	fcm: FakeFcm;
	http: string;
	ws: string;
	stop(): Promise<void>;
	restart(): Promise<TestRelay>;
}

export async function startRelay(
	over: Record<string, any> = {},
	opts: { dir?: string; fcm?: FakeFcm | null } = {},
): Promise<TestRelay> {
	const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "rp-relay-test-"));
	const fcm = opts.fcm === undefined ? new FakeFcm() : opts.fcm;
	const config = parseConfig(
		{
			dataDir: dir,
			listen: { host: "127.0.0.1", port: 0 },
			publicUrl: "http://127.0.0.1",
			relayName: "Test",
			logLevel: "silent",
			backup: { enabled: false },
			...over,
			limits: {
				promptGraceSeconds: 0.3,
				userMessageTimeoutMs: 600,
				pairAttemptsPerMinute: 1000,
				...(over.limits ?? {}),
			},
		},
		{},
	);
	const relay = await Relay.create({ config, log: createLogger("silent"), fcmSender: fcm, noTimers: true });
	await relay.start();
	const t: TestRelay = {
		relay,
		dir,
		config,
		fcm: fcm ?? new FakeFcm(),
		http: relay.baseUrl,
		ws: relay.wsUrl,
		async stop() {
			await relay.stop();
		},
		async restart() {
			await relay.stop();
			return startRelay(over, { dir, fcm });
		},
	};
	return t;
}

export function cleanup(t: TestRelay): void {
	rmSync(t.dir, { recursive: true, force: true });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Client {
	msgs: Envelope[] = [];
	private consumed = new Set<number>();
	closed: { code: number; reason: string } | null = null;
	private waiters: (() => void)[] = [];

	private constructor(readonly socket: WebSocket) {
		socket.on("message", (data) => {
			this.msgs.push(JSON.parse(data.toString()));
			this.wake();
		});
		socket.on("close", (code, reason) => {
			this.closed = { code, reason: reason.toString() };
			this.wake();
		});
	}

	static connect(url: string, token: string | null): Promise<Client> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
			const c = new Client(ws);
			ws.once("open", () => resolve(c));
			ws.once("error", reject);
			ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
		});
	}

	private wake() {
		for (const w of this.waiters.splice(0)) w();
	}

	send(t: string, d?: unknown, extra: Partial<Envelope> = {}): string {
		const id = extra.id ?? newMessageId();
		this.socket.send(
			JSON.stringify({ v: PROTOCOL_VERSION, t, id, ts: Date.now(), ...extra, ...(d === undefined ? {} : { d }) }),
		);
		return id;
	}
	raw(text: string) {
		this.socket.send(text);
	}

	/** Espera (y consume) el primer mensaje no consumido que cumpla el predicado. */
	async next(match: string | ((e: Envelope) => boolean), ms = 3000): Promise<Envelope> {
		const pred = typeof match === "string" ? (e: Envelope) => e.t === match : match;
		const deadline = Date.now() + ms;
		for (;;) {
			const i = this.msgs.findIndex((m, idx) => !this.consumed.has(idx) && pred(m));
			if (i >= 0) {
				this.consumed.add(i);
				return this.msgs[i]!;
			}
			if (this.closed)
				throw new Error(
					`conexión cerrada (${this.closed.code}) esperando ${typeof match === "string" ? match : "predicado"}`,
				);
			const left = deadline - Date.now();
			if (left <= 0)
				throw new Error(
					`timeout esperando ${typeof match === "string" ? match : "predicado"}; recibidos: ${this.msgs.map((m) => m.t).join(",")}`,
				);
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, left);
				this.waiters.push(() => {
					clearTimeout(t);
					resolve();
				});
			});
		}
	}

	/** Comprueba que NO llega ningún mensaje que cumpla el predicado durante `ms`. */
	async never(match: string | ((e: Envelope) => boolean), ms = 250): Promise<void> {
		const pred = typeof match === "string" ? (e: Envelope) => e.t === match : match;
		await sleep(ms);
		const hit = this.msgs.find((m, idx) => !this.consumed.has(idx) && pred(m));
		if (hit) throw new Error(`no se esperaba ${hit.t}: ${JSON.stringify(hit)}`);
	}

	count(t: string): number {
		return this.msgs.filter((m) => m.t === t).length;
	}

	async waitClosed(ms = 3000): Promise<{ code: number; reason: string }> {
		const deadline = Date.now() + ms;
		while (!this.closed) {
			if (Date.now() > deadline) throw new Error("la conexión no se cerró");
			await sleep(10);
		}
		return this.closed;
	}
	close() {
		this.socket.close();
	}
	terminate() {
		this.socket.terminate();
	}
}

export async function api(
	t: TestRelay,
	method: string,
	path: string,
	token?: string | null,
	body?: unknown,
	headers: Record<string, string> = {},
) {
	const res = await fetch(`${t.http}${path}`, {
		method,
		headers: {
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(body !== undefined ? { "content-type": "application/json" } : {}),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// no JSON
	}
	return { status: res.status, json, text, headers: res.headers };
}

export interface Paired {
	deviceId: string;
	deviceToken: string;
	pushKey: Buffer;
}

export function newCode(t: TestRelay, kind: "device" | "machine", meta?: { name?: string; context?: string }): string {
	return t.relay.ctx.pairing.createCode(kind, "test", meta).code;
}

export async function pairDevice(t: TestRelay, name = "Pixel"): Promise<Paired> {
	const r = await api(t, "POST", "/v1/pair/device", null, { code: newCode(t, "device"), name });
	if (r.status !== 200) throw new Error(`pair device falló: ${r.status} ${r.text}`);
	return { deviceId: r.json.deviceId, deviceToken: r.json.deviceToken, pushKey: Buffer.from(r.json.pushKey, "base64") };
}

export async function pairMachine(t: TestRelay, hostname = "devbox", meta?: { name?: string; context?: string }) {
	const r = await api(t, "POST", "/v1/pair/machine", null, { code: newCode(t, "machine", meta), hostname });
	if (r.status !== 200) throw new Error(`pair machine falló: ${r.status} ${r.text}`);
	return { machineId: r.json.machineId as string, machineToken: r.json.machineToken as string };
}

export function helloBody(machineId: string, sessionId = "sess-1", over: Record<string, any> = {}) {
	return {
		agentId: `${machineId}:${sessionId}`,
		kind: "pi",
		instance: newMessageId(),
		epoch: newMessageId(),
		pi: { version: "1.2.0", mode: "tui" },
		plugin: { version: "0.1.0", features: ["gate"] },
		session: { id: sessionId, file: `/tmp/${sessionId}.jsonl`, name: "refactor auth" },
		host: { hostname: "devbox", pid: 1, os: "linux" },
		launcher: "pi",
		herdr: null,
		gentle: null,
		transport: "ws",
		redacted: false,
		cwd: "/home/u/api",
		spawnId: null,
		git: { branch: "main", dirty: false },
		model: { provider: "anthropic", id: "claude" },
		thinking: "medium",
		status: "idle",
		openPrompts: [],
		...over,
	};
}

export interface AgentClient {
	client: Client;
	machineId: string;
	agentId: string;
	hello: ReturnType<typeof helloBody>;
	welcome: Envelope;
	seq: number;
	event(e: Record<string, unknown>): void;
}

export async function connectAgent(
	t: TestRelay,
	m: { machineId: string; machineToken: string },
	sessionId = "sess-1",
	over: Record<string, any> = {},
): Promise<AgentClient> {
	const client = await Client.connect(`${t.ws}/ws/agent`, m.machineToken);
	const hello = helloBody(m.machineId, sessionId, over);
	client.send("agent.hello", hello);
	const welcome = await client.next("agent.welcome");
	client.send("agent.snapshot", { epoch: hello.epoch, seq: 0, entries: [], truncated: false });
	const a: AgentClient = {
		client,
		machineId: m.machineId,
		agentId: hello.agentId,
		hello,
		welcome,
		seq: 0,
		event(e) {
			a.seq += 1;
			client.send("agent.event", { epoch: hello.epoch, seq: a.seq, e });
		},
	};
	return a;
}

export async function connectApp(t: TestRelay, dev: Paired, mode: "foreground" | "direct" = "foreground") {
	const client = await Client.connect(`${t.ws}/ws/app?mode=${mode}`, dev.deviceToken);
	client.send("app.hello", { deviceId: dev.deviceId, app: { version: "0.1.0" }, subscriptions: "all" });
	const welcome = await client.next("app.welcome");
	return { client, welcome };
}

export const promptBody = (agentId: string, over: Record<string, any> = {}) => ({
	promptId: newMessageId(),
	agentId,
	kind: "confirm",
	category: "permission",
	title: "⚠ Comando peligroso",
	message: "rm -rf build/",
	options: [
		{ id: "0", label: "Permitir" },
		{ id: "1", label: "Denegar" },
	],
	allowFreeText: false,
	danger: "high",
	expiresAt: null,
	...over,
});
