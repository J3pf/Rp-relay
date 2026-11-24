import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelope, PROTOCOL_VERSION } from "@j3pf/rp-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { backupsDir, parseConfig } from "../src/config.js";
import {
	type ApnsConfig,
	ApnsError,
	type ApnsHttp2Client,
	type ApnsHttp2Stream,
	createApnsSender,
} from "../src/push/apns.js";
import { PushDispatcher } from "../src/push/dispatcher.js";
import { FCM_UNREGISTERED, FcmError } from "../src/push/fcm.js";
import { Relay } from "../src/relay.js";
import { createLogger } from "../src/util/log.js";
import { LongPollRegistry } from "../src/ws/agentGateway.js";
import { AppSession } from "../src/ws/appGateway.js";
import { api, cleanup, pairDevice, sleep, startRelay, type TestRelay } from "./helpers.js";

class ScriptedStream extends EventEmitter implements ApnsHttp2Stream {
	closed = false;
	constructor(private behavior: (stream: ScriptedStream, body?: string) => void) {
		super();
	}
	end(body?: string): void {
		queueMicrotask(() => this.behavior(this, body));
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.emit("close");
	}
}

class ScriptedSession extends EventEmitter implements ApnsHttp2Client {
	closed = false;
	destroyed = false;
	destroyCalls = 0;
	closeCalls = 0;
	idleCallback: (() => void) | null = null;
	idleTimeoutMs: number | null = null;

	constructor(private onRequest: () => (stream: ScriptedStream, body?: string) => void) {
		super();
	}

	request(): ApnsHttp2Stream {
		return new ScriptedStream(this.onRequest());
	}

	setTimeout(msecs: number, callback: () => void): void {
		this.idleTimeoutMs = msecs;
		this.idleCallback = callback;
	}

	destroy(): void {
		this.destroyCalls += 1;
		this.destroyed = true;
		this.closed = true;
	}

	close(): void {
		this.closeCalls += 1;
		this.closed = true;
	}
}

const apnsMessage = {
	host: "api.push.apple.com" as const,
	token: "a".repeat(64),
	payload: { aps: { alert: "hello" } },
	headers: { topic: "com.example.app", collapseId: "p1", pushType: "alert", priority: 10 as const },
};

let apnsTmpDir: string;
let apnsKeyFile: string;
let apnsConfig: ApnsConfig;

beforeAll(() => {
	apnsTmpDir = mkdtempSync(join(tmpdir(), "rp-apns-hardening-"));
	apnsKeyFile = join(apnsTmpDir, "key.p8");
	const pair = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	writeFileSync(apnsKeyFile, pair.privateKey, { mode: 0o600 });
	apnsConfig = {
		keyId: "KEY123",
		teamId: "TEAM123",
		keyFile: apnsKeyFile,
		bundleId: "com.example.app",
		env: "production",
	};
});

afterAll(() => {
	rmSync(apnsTmpDir, { recursive: true, force: true });
});

const relaysToClean: TestRelay[] = [];
const dirsToClean: string[] = [];

afterEach(async () => {
	for (const r of relaysToClean.splice(0)) {
		await r.stop().catch(() => {});
		cleanup(r);
	}
	for (const dir of dirsToClean.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("APNs HTTP/2 stream & session hardening (C-02)", () => {
	it("rejects promptly with apns/stream-closed on premature stream close without end or error", async () => {
		const sessions: ScriptedSession[] = [];
		const sender = createApnsSender(apnsConfig, {
			timeoutMs: 5_000,
			clientFactory: () => {
				const s = new ScriptedSession(() => (stream) => {
					stream.emit("close");
				});
				sessions.push(s);
				return s;
			},
		});

		const started = Date.now();
		await expect(sender.send(apnsMessage)).rejects.toMatchObject({
			name: "ApnsError",
			code: "apns/stream-closed",
		});
		expect(Date.now() - started).toBeLessThan(1_000);
		sender.close?.();
	});

	it("evicts and destroys a timed-out HTTP/2 session so the next send opens a fresh session", async () => {
		const sessions: ScriptedSession[] = [];
		let attempt = 0;
		const sender = createApnsSender(apnsConfig, {
			timeoutMs: 40,
			clientFactory: () => {
				const s = new ScriptedSession(() => {
					attempt += 1;
					if (attempt === 1) {
						// Never responds — simulates blackholed TCP session
						return () => {};
					}
					return (stream) => {
						stream.emit("response", { ":status": 200 });
						stream.emit("end");
						stream.emit("close");
					};
				});
				sessions.push(s);
				return s;
			},
		});

		await expect(sender.send(apnsMessage)).rejects.toMatchObject({
			name: "ApnsError",
			code: "apns/timeout",
		});
		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.destroyCalls).toBe(1);

		await expect(sender.send(apnsMessage)).resolves.toBeUndefined();
		expect(sessions).toHaveLength(2);
		sender.close?.();
	});

	it("evicts and destroys session on goaway and idle timeout", async () => {
		const sessions: ScriptedSession[] = [];
		const okBehavior = () => (stream: ScriptedStream) => {
			stream.emit("response", { ":status": 200 });
			stream.emit("end");
			stream.emit("close");
		};
		const sender = createApnsSender(apnsConfig, {
			idleTimeoutMs: 60_000,
			clientFactory: () => {
				const s = new ScriptedSession(okBehavior);
				sessions.push(s);
				return s;
			},
		});

		await sender.send(apnsMessage);
		expect(sessions).toHaveLength(1);
		sessions[0]!.emit("goaway");
		expect(sessions[0]!.destroyCalls).toBe(1);

		await sender.send(apnsMessage);
		expect(sessions).toHaveLength(2);
		expect(sessions[1]!.idleCallback).toBeTypeOf("function");
		sessions[1]!.idleCallback!();
		expect(sessions[1]!.destroyCalls).toBe(1);

		await sender.send(apnsMessage);
		expect(sessions).toHaveLength(3);
		sender.close?.();
	});
});

describe("PushDispatcher retry & warning logs (S-03, W-08)", () => {
	it("retries once on transient apns/stream-closed and succeeds on the second attempt", async () => {
		const t = await startRelay({ apns: apnsConfig }, { apns: null });
		relaysToClean.push(t);
		const dev = await pairDevice(t);
		await api(t, "PUT", "/v1/devices/me/push", dev.deviceToken, {
			apnsToken: "a".repeat(64),
			apnsEnvironment: "production",
			direct: false,
		});

		let attempts = 0;
		const apnsSender = createApnsSender(apnsConfig, {
			timeoutMs: 2_000,
			clientFactory: () =>
				new ScriptedSession(() => {
					attempts += 1;
					if (attempts === 1) {
						return (stream) => stream.emit("close");
					}
					return (stream) => {
						stream.emit("response", { ":status": 200 });
						stream.emit("end");
						stream.emit("close");
					};
				}),
		});
		const dispatcher = new PushDispatcher(() => t.relay.ctx, t.relay.log, null, apnsSender, { retryDelayMs: 10 });
		const results = await dispatcher.test(dev.deviceId);
		expect(results).toEqual([{ deviceId: dev.deviceId, direct: "off", fcm: "off", apns: "sent" }]);
		expect(attempts).toBe(2);
		dispatcher.close();
	});

	it("retries once on retryable 5xx/429/FCM errors, does not retry permanent 4xx, and logs status + err", async () => {
		const t = await startRelay({ apns: apnsConfig }, { apns: null, fcm: null });
		relaysToClean.push(t);
		const dev = await pairDevice(t);
		await api(t, "PUT", "/v1/devices/me/push", dev.deviceToken, {
			fcmToken: "fcm-tok",
			apnsToken: "b".repeat(64),
			apnsEnvironment: "production",
			direct: false,
		});

		const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
		const spyLog = {
			...t.relay.log,
			info: vi.fn(),
			warn: vi.fn((obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg })),
			error: vi.fn(),
		} as unknown as typeof t.relay.log;

		// 1. Transient FCM + APNs 503 recover on retry
		let fcmCalls = 0;
		let apnsCalls = 0;
		const dispatcher = new PushDispatcher(
			() => t.relay.ctx,
			spyLog,
			{
				async send() {
					fcmCalls += 1;
					if (fcmCalls === 1) throw new FcmError("messaging/server-unavailable", "temporarily down");
				},
			},
			{
				async send() {
					apnsCalls += 1;
					if (apnsCalls === 1) throw new ApnsError("ServiceUnavailable", 503, "apple 503");
				},
			},
			{ retryDelayMs: 5 },
		);
		const okRes = await dispatcher.test(dev.deviceId);
		expect(okRes).toEqual([{ deviceId: dev.deviceId, direct: "off", fcm: "sent", apns: "sent" }]);
		expect(fcmCalls).toBe(2);
		expect(apnsCalls).toBe(2);

		// 2. Permanent APNs 400 BadDeviceToken & FCM Unregistered are NOT retried
		let permFcmCalls = 0;
		let permApnsCalls = 0;
		const permDispatcher = new PushDispatcher(
			() => t.relay.ctx,
			spyLog,
			{
				async send() {
					permFcmCalls += 1;
					throw new FcmError(FCM_UNREGISTERED, "token gone");
				},
			},
			{
				async send() {
					permApnsCalls += 1;
					throw new ApnsError("BadDeviceToken", 400, "bad token");
				},
			},
			{ retryDelayMs: 5 },
		);
		const permRes = await permDispatcher.test(dev.deviceId);
		expect(permRes[0]).toMatchObject({ fcm: "failed", apns: "failed" });
		expect(permFcmCalls).toBe(1);
		expect(permApnsCalls).toBe(1);

		// Re-register tokens and verify warning log includes status + err
		await api(t, "PUT", "/v1/devices/me/push", dev.deviceToken, {
			fcmToken: "fcm-tok-2",
			apnsToken: "c".repeat(64),
			apnsEnvironment: "production",
			direct: false,
		});
		const warnDispatcher = new PushDispatcher(
			() => t.relay.ctx,
			spyLog,
			{
				async send() {
					throw Object.assign(new FcmError("messaging/internal-error", "fcm boom"), { status: 500 });
				},
			},
			{
				async send() {
					throw new ApnsError("TooManyRequests", 429, "rate limited");
				},
			},
			{ retryDelayMs: 5 },
		);
		await warnDispatcher.test(dev.deviceId);
		expect(warns.some((w) => w.msg === "fallo al enviar FCM" && w.obj.status === 500 && w.obj.err === "fcm boom")).toBe(
			true,
		);
		expect(
			warns.some((w) => w.msg === "fallo al enviar APNs" && w.obj.status === 429 && w.obj.err === "rate limited"),
		).toBe(true);
	});
});

describe("Periodic safety, shutdown, startup rollback & healthcheck (C-01, W-05, W-08, S-02)", () => {
	it("Relay.every() catches synchronous throws without crashing or locking running = true", async () => {
		const t = await startRelay();
		relaysToClean.push(t);
		const warnSpy = vi.spyOn(t.relay.log, "warn");
		let ticks = 0;

		(t.relay as unknown as { every(ms: number, fn: () => void | Promise<void>): void }).every(20, () => {
			ticks += 1;
			if (ticks === 1) throw new Error("sync periodic boom");
		});

		await sleep(90);
		expect(ticks).toBeGreaterThanOrEqual(2);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({ err: "sync periodic boom" }),
			"tarea periódica fallida",
		);
	});

	it("LongPollRegistry.sweep() catches errors without crashing the process", async () => {
		const t = await startRelay();
		relaysToClean.push(t);
		const warnSpy = vi.spyOn(t.relay.log, "warn");
		const registry = new LongPollRegistry(() => t.relay.ctx, 1);
		const fakeEntry = {
			conn: {
				closed: true,
				lastActivity: 0,
				lastPollAt: 0,
				close: vi.fn(),
			},
			session: {
				onClose: vi.fn(() => {
					throw new Error("sqlite busy during sweep");
				}),
			},
		};
		(registry as unknown as { sessions: Map<string, unknown> }).sessions.set("m1:a1", fakeEntry);

		expect(() => (registry as unknown as { sweep(): void }).sweep()).not.toThrow();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({ err: "sqlite busy during sweep" }),
			expect.any(String),
		);
		registry.dispose();
	});

	it("GET /healthz returns 200 ok:true when DB is healthy and 503 ok:false when DB is closed", async () => {
		const t = await startRelay();
		relaysToClean.push(t);

		const healthy = await api(t, "GET", "/healthz");
		expect(healthy.status).toBe(200);
		expect(healthy.json).toMatchObject({ ok: true, version: expect.any(String), uptime: expect.any(Number) });

		t.relay.db.close();
		const unhealthy = await api(t, "GET", "/healthz");
		expect(unhealthy.status).toBe(503);
		expect(unhealthy.json).toMatchObject({ ok: false, version: expect.any(String), uptime: expect.any(Number) });
	});

	it("Relay.stop() completes downstream cleanup even when an early step throws", async () => {
		const t = await startRelay();
		relaysToClean.push(t);

		vi.spyOn(t.relay.ctx.hub, "closeAll").mockImplementation(() => {
			throw new Error("hub close boom");
		});
		const agentsDispose = vi.spyOn(t.relay.ctx.agents, "dispose");
		const messagesDispose = vi.spyOn(t.relay.ctx.messages, "dispose");
		const meshDispose = vi.spyOn(t.relay.ctx.mesh, "dispose");
		const hostsDispose = vi.spyOn(t.relay.ctx.hosts, "dispose");
		const dispatcherClose = vi.spyOn(t.relay.ctx.dispatcher, "close");

		await expect(t.relay.stop()).resolves.toBeUndefined();
		expect(agentsDispose).toHaveBeenCalledTimes(1);
		expect(messagesDispose).toHaveBeenCalledTimes(1);
		expect(meshDispose).toHaveBeenCalledTimes(1);
		expect(hostsDispose).toHaveBeenCalledTimes(1);
		expect(dispatcherClose).toHaveBeenCalledTimes(1);
		expect(t.relay.db.open).toBe(false);
	});

	it("Relay.start() cleans up partial resources when app.listen fails", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
		const occupiedPort = (blocker.address() as { port: number }).port;

		const dir = mkdtempSync(join(tmpdir(), "rp-start-fail-"));
		dirsToClean.push(dir);
		const config = parseConfig(
			{
				dataDir: dir,
				listen: { host: "127.0.0.1", port: occupiedPort },
				publicUrl: `http://127.0.0.1:${occupiedPort}`,
				logLevel: "silent",
				backup: { enabled: false },
			},
			{},
		);
		const relay = await Relay.create({ config, log: createLogger("silent"), fcmSender: null, apnsSender: null });
		try {
			await expect(relay.start()).rejects.toThrow();
			const internal = relay as unknown as {
				timers: unknown[];
				longPoll?: unknown;
				app?: unknown;
				ws?: unknown;
			};
			expect(internal.timers).toHaveLength(0);
			expect(internal.longPoll).toBeUndefined();
			expect(internal.app).toBeUndefined();
			expect(internal.ws).toBeUndefined();
		} finally {
			await relay.stop();
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("Relay.backup() runs backupNow before pruneBackups so failed backup never deletes old backups", async () => {
		const t = await startRelay({ backup: { enabled: false, keepDays: 0.001 } });
		relaysToClean.push(t);
		const bdir = backupsDir(t.config);
		mkdirSync(bdir, { recursive: true });
		const oldBackup = join(bdir, "rp-2020-01-01T00-00-00-000Z.db");
		writeFileSync(oldBackup, "existing-backup");
		const oldDate = new Date(Date.now() - 86_400_000 * 30);
		utimesSync(oldBackup, oldDate, oldDate);

		t.relay.db.close();
		expect(() => t.relay.backup()).toThrow();
		expect(existsSync(oldBackup)).toBe(true);
	});

	it("Relay.create() sets 0600 permissions on SQLite DB and WAL/SHM sidecars when present", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-perms-"));
		dirsToClean.push(dir);
		const config = parseConfig(
			{
				dataDir: dir,
				listen: { host: "127.0.0.1", port: 0 },
				publicUrl: "http://127.0.0.1",
				logLevel: "silent",
				backup: { enabled: false },
			},
			{},
		);
		const relay = await Relay.create({ config, log: createLogger("silent"), fcmSender: null, apnsSender: null });
		try {
			const dbFile = join(dir, "relay.db");
			expect(statSync(dbFile).mode & 0o777).toBe(0o600);
			expect(existsSync(`${dbFile}-wal`)).toBe(true);
			expect(existsSync(`${dbFile}-shm`)).toBe(true);
			expect(statSync(`${dbFile}-wal`).mode & 0o777).toBe(0o600);
			expect(statSync(`${dbFile}-shm`).mode & 0o777).toBe(0o600);
		} finally {
			await relay.stop();
		}
	});

	it("AppSession logs non-RelayError internal failures from async user.message and agent.close", async () => {
		const t = await startRelay();
		relaysToClean.push(t);
		const dev = await pairDevice(t);
		const deviceRow = t.relay.ctx.repos.devices.get(dev.deviceId)!;
		const warnSpy = vi.spyOn(t.relay.ctx.log, "warn");
		const sent: unknown[] = [];
		const fakeConn = {
			id: "c1",
			deviceId: dev.deviceId,
			mode: "foreground" as const,
			subs: new Set<string>(),
			ready: true,
			closed: false,
			bufferedAmount: 0,
			send: (m: unknown) => {
				sent.push(m);
				return true;
			},
			close: vi.fn(),
		};
		const session = new AppSession(() => t.relay.ctx, fakeConn, deviceRow);
		session.handle(
			envelope("app.hello", { deviceId: dev.deviceId, app: { version: "0.1.0" }, subscriptions: "all" }, { id: "h1" }),
		);

		vi.spyOn(t.relay.ctx.messages, "send").mockRejectedValueOnce(new Error("unexpected msg failure"));
		session.handle({
			v: PROTOCOL_VERSION,
			t: "user.message",
			id: "m1",
			ts: Date.now(),
			d: { agentId: "m:a", clientMsgId: "cm1", text: "hi" },
		});

		vi.spyOn(t.relay.ctx.agents, "close").mockRejectedValueOnce(new Error("unexpected close failure"));
		session.handle({
			v: PROTOCOL_VERSION,
			t: "agent.close",
			id: "cl1",
			ts: Date.now(),
			d: { agentId: "m:a" },
		});

		await sleep(30);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({ err: "unexpected msg failure", t: "user.message", deviceId: dev.deviceId }),
			expect.any(String),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({ err: "unexpected close failure", t: "agent.close", deviceId: dev.deviceId }),
			expect.any(String),
		);
	});

	it("Dockerfile restricts /var/lib/rp-relay to 700 and parameterizes HEALTHCHECK port & TLS", () => {
		const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
		expect(dockerfile).toContain("chmod 700 /var/lib/rp-relay");
		expect(dockerfile).toContain("RP_LISTEN_PORT");
		expect(dockerfile).toMatch(/RP_TLS_CERT|RP_ACME_DOMAIN/);
		expect(dockerfile).toContain("NODE_TLS_REJECT_UNAUTHORIZED");
	});
});
