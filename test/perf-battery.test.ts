import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloseCode, envelope, parseFrame, validateMessage } from "@j3pf/rp-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { BlobStore } from "../src/blobs/store.js";
import { parseConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { Repos } from "../src/db/repos/index.js";
import { type AppConn, startHeartbeat, validateGatewayEnvelope, WsConn } from "../src/ws/conn.js";
import { Hub } from "../src/ws/hub.js";
import {
	api,
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
	promptBody,
	sleep,
	startRelay,
	type TestRelay,
} from "./helpers.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(rootDir, "packages", "protocol", "fixtures");

const relaysToClean: TestRelay[] = [];
const dirsToClean: string[] = [];

async function start(over: Record<string, any> = {}): Promise<TestRelay> {
	const t = await startRelay(over);
	relaysToClean.push(t);
	return t;
}

afterEach(async () => {
	for (const t of relaysToClean.splice(0)) {
		await t.stop().catch(() => {});
		cleanup(t);
	}
	for (const dir of dirsToClean.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("protocol app.state & fixtures", () => {
	it("validates appUp app.state valid and invalid fixtures", () => {
		const validRaw = readFileSync(join(fixturesDir, "appUp__app.state__screen_off.valid.json"), "utf8");
		const validParsed = parseFrame(validRaw);
		expect(validParsed.ok).toBe(true);
		if (validParsed.ok) {
			const res = validateMessage("appUp", validParsed.env);
			expect(res.ok, res.ok ? "" : res.message).toBe(true);
		}

		const invalidRaw = readFileSync(join(fixturesDir, "appUp__app.state__missing_screen_on.invalid.json"), "utf8");
		const invalidParsed = parseFrame(invalidRaw);
		expect(invalidParsed.ok).toBe(true);
		if (invalidParsed.ok) {
			const res = validateMessage("appUp", invalidParsed.env);
			expect(res.ok).toBe(false);
		}
	});
});

describe("Publisher direct coalescing, screenOn suppression & wake sync", () => {
	it("coalesces cosmetic updates on direct (screenOn=true), suppresses them on screenOn=false, and syncs on wake", async () => {
		const t = await start();
		t.relay.ctx.publisher.setDirectCosmeticMs(150);

		const devOn = await pairDevice(t, "Phone-On");
		const devOff = await pairDevice(t, "Phone-Off");
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "coalesce-1");

		const { client: fg } = await connectApp(t, devOn, "foreground");
		const { client: directOn } = await connectApp(t, devOn, "direct");
		const { client: directOff } = await connectApp(t, devOff, "direct");

		// Mark directOff as screen off
		directOff.send("app.state", { screenOn: false });
		await sleep(40);

		// Critical state transition: idle -> working MUST arrive immediately on BOTH direct sockets
		agent.client.send("agent.status", { status: "working", detail: "step 0" });
		const fgWork = await fg.next((e) => e.t === "agents.update" && (e.d as any).upsert?.[0]?.status === "working");
		const onWork = await directOn.next(
			(e) => e.t === "agents.update" && (e.d as any).upsert?.[0]?.status === "working",
		);
		const offWork = await directOff.next(
			(e) => e.t === "agents.update" && (e.d as any).upsert?.[0]?.status === "working",
		);
		expect((fgWork.d as any).upsert[0].activeTask).toBe("step 0");
		expect((onWork.d as any).upsert[0].activeTask).toBe("step 0");
		expect((offWork.d as any).upsert[0].activeTask).toBe("step 0");

		const onCountBeforeBurst = directOn.count("agents.update");
		const offCountBeforeBurst = directOff.count("agents.update");

		// Burst of 5 cosmetic progress updates while staying "working"
		for (let i = 1; i <= 5; i++) {
			agent.client.send("agent.status", { status: "working", detail: `tool call ${i}` });
		}

		// Foreground gets the latest update immediately
		await fg.next((e) => e.t === "agents.update" && (e.d as any).upsert?.[0]?.activeTask === "tool call 5");

		// Before coalescing window expires, directOn should not have received burst frames yet
		await sleep(50);
		expect(directOn.count("agents.update")).toBe(onCountBeforeBurst);
		expect(directOff.count("agents.update")).toBe(offCountBeforeBurst);

		// After coalescing window, directOn gets ONE batched update with latest activeTask
		const coalesced = await directOn.next(
			(e) => e.t === "agents.update" && (e.d as any).upsert?.[0]?.activeTask === "tool call 5",
			1000,
		);
		expect((coalesced.d as any).upsert).toHaveLength(1);
		expect(directOn.count("agents.update")).toBe(onCountBeforeBurst + 1);

		// directOff (screenOn=false) NEVER receives cosmetic updates
		await directOff.never("agents.update", 150);
		expect(directOff.count("agents.update")).toBe(offCountBeforeBurst);

		// Transition directOff false -> true: immediately receives fresh agents.update with latest activeTask
		directOff.send("app.state", { screenOn: true });
		const wakeSync = await directOff.next(
			(e) => e.t === "agents.update" && (e.d as any).upsert?.some((a: any) => a.agentId === agent.agentId),
			1000,
		);
		const syncedAgent = (wakeSync.d as any).upsert.find((a: any) => a.agentId === agent.agentId);
		expect(syncedAgent).toMatchObject({
			agentId: agent.agentId,
			status: "working",
			activeTask: "tool call 5",
		});

		agent.client.close();
		fg.close();
		directOn.close();
		directOff.close();
	});

	it("passes machine row into summaries.agent (avoiding duplicate machines.get) and skips direct work when no direct sockets exist", async () => {
		const t = await start();
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "no-direct-1");
		const { client: fg } = await connectApp(t, dev, "foreground");

		const machineGetSpy = vi.spyOn(t.relay.ctx.repos.machines, "get");
		const hasAppsSpy = vi.spyOn(t.relay.ctx.hub, "hasApps");
		machineGetSpy.mockClear();
		hasAppsSpy.mockClear();

		t.relay.ctx.publisher.agent(agent.agentId);
		expect(machineGetSpy).toHaveBeenCalledTimes(1);
		expect(hasAppsSpy).toHaveBeenCalledWith({ mode: "direct" });

		agent.client.close();
		fg.close();
	});

	it("batches cosmetic updates across multiple dirty agents into a single direct agents.update frame and stop() cancels pending timers", async () => {
		const t = await start();
		t.relay.ctx.publisher.setDirectCosmeticMs(120);

		const dev = await pairDevice(t, "MultiAgentPhone");
		const m = await pairMachine(t);
		const a1 = await connectAgent(t, m, "batch-1");
		const a2 = await connectAgent(t, m, "batch-2");
		const { client: direct } = await connectApp(t, dev, "direct");

		// Transition both agents to working (immediate critical frames)
		a1.client.send("agent.status", { status: "working", detail: "init-1" });
		a2.client.send("agent.status", { status: "working", detail: "init-2" });
		await direct.next(
			(e) =>
				e.t === "agents.update" &&
				(e.d as any).upsert?.some((a: any) => a.agentId === a1.agentId && a.status === "working"),
		);
		await direct.next(
			(e) =>
				e.t === "agents.update" &&
				(e.d as any).upsert?.some((a: any) => a.agentId === a2.agentId && a.status === "working"),
		);

		const countBefore = direct.count("agents.update");
		// Update cosmetic activeTask on both agents inside the same coalescing window
		a1.client.send("agent.status", { status: "working", detail: "step-a1" });
		a2.client.send("agent.status", { status: "working", detail: "step-a2" });

		const batched = await direct.next(
			(e) =>
				e.t === "agents.update" &&
				(e.d as any).upsert?.length === 2 &&
				(e.d as any).upsert.some((a: any) => a.agentId === a1.agentId && a.activeTask === "step-a1") &&
				(e.d as any).upsert.some((a: any) => a.agentId === a2.agentId && a.activeTask === "step-a2"),
			1000,
		);
		expect((batched.d as any).upsert).toHaveLength(2);
		expect(direct.count("agents.update")).toBe(countBefore + 1);

		// Enqueue another cosmetic update and immediately call publisher.stop() -> timer cancelled, nothing sent
		a1.client.send("agent.status", { status: "working", detail: "cancelled-step" });
		await sleep(20);
		t.relay.ctx.publisher.stop();
		await direct.never("agents.update", 200);

		a1.client.close();
		a2.client.close();
		direct.close();
	});
});

describe("PromptService foreground-only broadcast & targeted PushDispatcher cancel", () => {
	it("broadcasts prompt.opened and prompt.resolved only to foreground sockets, never direct sockets", async () => {
		const t = await start();
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "prompt-scope");
		const { client: fg } = await connectApp(t, dev, "foreground");
		const { client: direct } = await connectApp(t, dev, "direct");

		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);

		await fg.next("prompt.opened");
		await direct.next((e) => e.t === "push.notify" && (e.d as any).k === "prompt");
		await direct.never("prompt.opened", 150);

		agent.client.send("prompt.resolved", { promptId: p.promptId, by: "local" });
		await fg.next("prompt.resolved");
		await direct.next((e) => e.t === "push.notify" && (e.d as any).k === "cancel");
		await direct.never("prompt.resolved", 150);

		agent.client.close();
		fg.close();
		direct.close();
	});

	it("sends cancel push only to devices that received promptOpened (skipping muted devices)", async () => {
		const t = await start();
		const devActive = await pairDevice(t, "ActivePhone");
		const devMuted = await pairDevice(t, "MutedPhone");

		await api(t, "PUT", "/v1/devices/me/push", devActive.deviceToken, { fcmToken: "fcm-active", direct: true });
		await api(t, "PUT", "/v1/devices/me/push", devMuted.deviceToken, { fcmToken: "fcm-muted", direct: true });

		const m = await pairMachine(t, "workbox");
		// Mute this machine on devMuted
		const prefRes = await api(t, "PUT", "/v1/devices/me/prefs", devMuted.deviceToken, {
			machines: { [m.machineId]: { mute: true } },
		});
		expect(prefRes.status).toBe(200);

		const agent = await connectAgent(t, m, "targeted-cancel");
		const { client: directActive } = await connectApp(t, devActive, "direct");
		const { client: directMuted } = await connectApp(t, devMuted, "direct");

		const p = promptBody(agent.agentId, { danger: "low" });
		agent.client.send("prompt.open", p);

		await directActive.next((e) => e.t === "push.notify" && (e.d as any).k === "prompt");
		await directMuted.never((e) => e.t === "push.notify" && (e.d as any).k === "prompt", 150);

		// Resolve prompt locally: only devActive should get cancel (FCM + direct), never devMuted
		agent.client.send("prompt.resolved", { promptId: p.promptId, by: "local" });
		await directActive.next((e) => e.t === "push.notify" && (e.d as any).k === "cancel");
		await directMuted.never((e) => e.t === "push.notify" && (e.d as any).k === "cancel", 200);

		const fcmCancels = t.fcm.sent.filter((msg) => msg.data.k === "cancel");
		expect(fcmCancels.map((msg) => msg.token)).toEqual(["fcm-active"]);

		agent.client.close();
		directActive.close();
		directMuted.close();
	});

	it("pre-fits push body once across multi-device fan-out and preserves distinct pushIds + restart cancel fallback", async () => {
		const t = await start({
			apns: {
				keyId: "k1",
				teamId: "t1",
				keyFile: "/unused.p8",
				bundleId: "com.example.rp",
				env: "production",
			},
		});
		const dev1 = await pairDevice(t, "Phone-1");
		const dev2 = await pairDevice(t, "Phone-2");
		await api(t, "PUT", "/v1/devices/me/push", dev1.deviceToken, {
			fcmToken: "fcm-1",
			apnsToken: "a".repeat(64),
			direct: true,
		});
		await api(t, "PUT", "/v1/devices/me/push", dev2.deviceToken, {
			fcmToken: "fcm-2",
			apnsToken: "b".repeat(64),
			direct: true,
		});

		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "multi-prefit");
		const { client: d1 } = await connectApp(t, dev1, "direct");
		const { client: d2 } = await connectApp(t, dev2, "direct");

		const p = promptBody(agent.agentId, { message: "x".repeat(5000) });
		agent.client.send("prompt.open", p);
		const n1 = await d1.next((e) => e.t === "push.notify" && (e.d as any).k === "prompt");
		const n2 = await d2.next((e) => e.t === "push.notify" && (e.d as any).k === "prompt");
		await sleep(100);

		expect((n1.d as any).pushId).not.toBe((n2.d as any).pushId);
		expect(Buffer.byteLength(JSON.stringify((n1.d as any).body))).toBeLessThanOrEqual(3000);
		expect(Buffer.byteLength(JSON.stringify((n2.d as any).body))).toBeLessThanOrEqual(3000);
		expect(t.apns!.sent.filter((x) => x.payload.k === "prompt")).toHaveLength(2);
		for (const apnsMsg of t.apns!.sent.filter((x) => x.payload.k === "prompt")) {
			expect(Buffer.byteLength(JSON.stringify(apnsMsg.payload))).toBeLessThanOrEqual(4096);
		}

		// Simulate cancel for a promptId not tracked in memory (e.g., after relay restart)
		t.relay.ctx.dispatcher.promptCancelled("UNTRACKED_PROMPT_ID", dev1.deviceId);
		const c2 = await d2.next(
			(e) =>
				e.t === "push.notify" && (e.d as any).k === "cancel" && (e.d as any).body.promptId === "UNTRACKED_PROMPT_ID",
		);
		expect(c2).toBeTruthy();
		await d1.never(
			(e) =>
				e.t === "push.notify" && (e.d as any).k === "cancel" && (e.d as any).body.promptId === "UNTRACKED_PROMPT_ID",
			120,
		);

		agent.client.close();
		d1.close();
		d2.close();
	});
});

describe("WsConn.sendSerialized & Hub.broadcastApps pre-serialization", () => {
	it("WsConn.sendSerialized sends raw payload and enforces slow-consumer hardBufferedBytes", () => {
		class FakeSocket extends EventEmitter {
			readyState: number = WebSocket.OPEN;
			bufferedAmount = 0;
			sent: string[] = [];
			closeCalls: Array<{ code: number; reason?: string }> = [];
			send(raw: string) {
				this.sent.push(raw);
			}
			close(code: number, reason?: string) {
				this.closeCalls.push({ code, reason });
				this.readyState = WebSocket.CLOSED;
			}
			terminate() {
				this.readyState = WebSocket.CLOSED;
			}
		}

		const sock = new FakeSocket();
		const conn = new WsConn(sock as unknown as WebSocket, 1024);
		const raw = JSON.stringify(envelope("ack", {}));
		expect(conn.sendSerialized(raw)).toBe(true);
		expect(sock.sent).toEqual([raw]);

		sock.bufferedAmount = 2048;
		expect(conn.sendSerialized(raw)).toBe(false);
		expect(conn.closed).toBe(true);
		expect(sock.closeCalls).toEqual([{ code: CloseCode.TryAgainLater, reason: "slow consumer" }]);
	});

	it("Hub.broadcastApps pre-serializes once across multiple apps and Hub.hasApps filters by mode & screenOn", () => {
		const hub = new Hub({ maxBufferedBytes: 1024, hardBufferedBytes: 4096 });
		const makeApp = (id: string, mode: "foreground" | "direct", screenOn: boolean) => {
			const serialized: string[] = [];
			const conn: AppConn = {
				id,
				deviceId: `dev-${id}`,
				mode,
				subs: new Set(),
				ready: true,
				screenOn,
				bufferedAmount: 0,
				send: vi.fn(() => true),
				sendSerialized: vi.fn((raw: string) => {
					serialized.push(raw);
					return true;
				}),
				close: vi.fn(),
			};
			return { conn, serialized };
		};

		const a1 = makeApp("1", "foreground", true);
		const a2 = makeApp("2", "foreground", true);
		const d1 = makeApp("3", "direct", false);
		hub.addApp(a1.conn);
		hub.addApp(a2.conn);
		hub.addApp(d1.conn);

		expect(hub.hasApps({ mode: "direct" })).toBe(true);
		expect(hub.hasApps({ mode: "direct", screenOn: true })).toBe(false);
		expect(hub.hasApps({ mode: "direct", screenOn: false })).toBe(true);

		const stringifySpy = vi.spyOn(JSON, "stringify");
		const env = envelope("agents.update", { upsert: [], remove: ["a1"] });
		const sent = hub.broadcastApps(env, { mode: "foreground" });
		expect(sent).toBe(2);
		expect(stringifySpy).toHaveBeenCalledTimes(1);
		expect(a1.serialized).toHaveLength(1);
		expect(a2.serialized).toHaveLength(1);
		expect(a1.serialized[0]).toBe(a2.serialized[0]);
		expect(a1.conn.send).not.toHaveBeenCalled();
		expect(d1.serialized).toHaveLength(0);
		stringifySpy.mockRestore();
	});
});

describe("Activity-aware heartbeat & config", () => {
	it("parseConfig sets directPingMs=300000 and directPongTimeoutMs=20000 by default and honors RP_DIRECT_PING_MS", () => {
		const defaults = parseConfig({}, {});
		expect(defaults.limits.directPingMs).toBe(300_000);
		expect(defaults.limits.directPongTimeoutMs).toBe(20_000);

		const overridden = parseConfig({}, { RP_DIRECT_PING_MS: "180000" });
		expect(overridden.limits.directPingMs).toBe(180_000);
	});

	it("skips socket.ping() while inbound messages keep arriving within pingMs, then pings & terminates when idle", async () => {
		const wss = new WebSocketServer({ port: 0 });
		await new Promise((r) => wss.on("listening", r));
		const port = (wss.address() as any).port;

		let pings = 0;
		const closed = new Promise<void>((resolve) => {
			wss.on("connection", (serverSocket) => {
				const origPing = serverSocket.ping.bind(serverSocket);
				serverSocket.ping = ((...args: any[]) => {
					pings++;
					return (origPing as any)(...args);
				}) as typeof serverSocket.ping;
				startHeartbeat(serverSocket, { pingMs: 90, pongMs: 80 });
				serverSocket.on("close", () => resolve());
			});
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false });
		await new Promise((r) => client.on("open", r));

		// Send messages every 35ms for ~180ms (> 2x pingMs) -> server must send 0 pings
		for (let i = 0; i < 5; i++) {
			await sleep(35);
			client.send(`keepalive-${i}`);
		}
		expect(pings).toBe(0);

		// Stop sending messages -> server should ping once idle >= 90ms and terminate after pongMs
		await closed;
		expect(pings).toBeGreaterThanOrEqual(1);
		wss.close();
	});
});

describe("Secondary hot-path optimizations (PERF-09 / PERF-10)", () => {
	it("BlobStore.gc() skips stat() on known valid blobs while still removing old orphans and .part files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-blob-gc-perf-"));
		dirsToClean.push(dir);
		const db = openDb(join(dir, "relay.db"));
		migrate(db);
		const repos = new Repos(db);
		const blobsDir = join(dir, "blobs");
		const store = new BlobStore(blobsDir, repos, { blobMaxBytes: 1024, blobTtlDays: 7 });

		const now = Date.now();
		const knownIds = ["01ARZ3NDEKTSV4RRFFQ69G5FA1", "01ARZ3NDEKTSV4RRFFQ69G5FA2", "01ARZ3NDEKTSV4RRFFQ69G5FA3"];
		for (const id of knownIds) {
			writeFileSync(join(blobsDir, id), "valid");
			repos.blobs.insert({
				id,
				sha256: "0".repeat(64),
				name: "file.txt",
				mime: "text/plain",
				size: 5,
				uploaded_by: "dev1",
				created_at: now,
				expires_at: now + 86_400_000,
			});
		}

		const orphanPath = join(blobsDir, "ORPHAN_FILE");
		const partPath = join(blobsDir, "01ARZ3NDEKTSV4RRFFQ69G5FA9.part");
		writeFileSync(orphanPath, "orphan");
		writeFileSync(partPath, "part");
		const oldTime = new Date(now - 2 * 3_600_000);
		utimesSync(orphanPath, oldTime, oldTime);
		utimesSync(partPath, oldTime, oldTime);

		const statSpy = vi.fn((p: string) => stat(p));
		const removed = await store.gc(now, statSpy);
		expect(removed).toBe(2);
		// stat() was called ONLY for the orphan + .part file, NEVER for the 3 known valid blobs
		expect(statSpy).toHaveBeenCalledTimes(2);
		db.close();
	});

	it("validateGatewayEnvelope uses frameBytes in debug logging instead of JSON.stringify(env.d)", () => {
		const debugSpy = vi.fn();
		const fakeLog = {
			isLevelEnabled: (lvl: string) => lvl === "debug",
			debug: debugSpy,
			trace: vi.fn(),
		} as any;
		const stringifySpy = vi.spyOn(JSON, "stringify");
		const res = validateGatewayEnvelope({
			conn: { send: () => true, close: () => {}, bufferedAmount: 0, closed: false },
			env: envelope("app.state", { screenOn: false }),
			channel: "appUp",
			helloType: "app.hello",
			ready: true,
			log: fakeLog,
			logContext: { deviceId: "d1" },
			logMessage: "app → relay",
			frameBytes: 42,
		});
		expect(res).toBe("ok");
		expect(stringifySpy).not.toHaveBeenCalled();
		expect(debugSpy).toHaveBeenCalledWith({ deviceId: "d1", t: "app.state", bytes: 42 }, "app → relay");
		stringifySpy.mockRestore();
	});

	it("deploy/rp-relay.service sets WatchdogSec=60", () => {
		const unit = readFileSync(join(rootDir, "deploy", "rp-relay.service"), "utf8");
		expect(unit).toContain("WatchdogSec=60");
	});

	it("GET /healthz succeeds with cached SQLite statement", async () => {
		const t = await start();
		const r1 = await api(t, "GET", "/healthz");
		const r2 = await api(t, "GET", "/healthz");
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(r1.json.ok).toBe(true);
	});

	it("direct cosmetic flush never overwrites newer state after screenOn false -> true flap", async () => {
		const t = await start();
		t.relay.ctx.publisher.setDirectCosmeticMs(250);
		const machine = await pairMachine(t);
		const device = await pairDevice(t);
		const agent = await connectAgent(t, machine, "flap-agent");
		const { client: direct } = await connectApp(t, device, "direct");

		// Transition to working (critical -> immediate)
		agent.client.send("agent.status", { status: "working", detail: "step-1" });
		await direct.next((m) => m.t === "agents.update" && (m.d as any).upsert?.[0]?.activeTask === "step-1");

		// Queue cosmetic update while screenOn=true
		agent.client.send("agent.status", { status: "working", detail: "step-2-stale" });
		await new Promise((r) => setTimeout(r, 40));

		// Screen turns off and newer cosmetic update arrives
		direct.send("app.state", { screenOn: false });
		await new Promise((r) => setTimeout(r, 30));
		agent.client.send("agent.status", { status: "working", detail: "step-3-fresh" });
		await new Promise((r) => setTimeout(r, 30));

		// Screen wakes back up before the original 250ms coalescing timer would have fired
		direct.send("app.state", { screenOn: true });
		const wakeUpdate = await direct.next(
			(m) => m.t === "agents.update" && (m.d as any).upsert?.[0]?.activeTask === "step-3-fresh",
		);
		expect((wakeUpdate.d as any).upsert[0].activeTask).toBe("step-3-fresh");

		// Wait past the original 250ms timer: must NEVER receive stale "step-2-stale"
		await direct.never((m) => m.t === "agents.update" && (m.d as any).upsert?.[0]?.activeTask === "step-2-stale", 350);
		direct.close();
		agent.client.close();
	});

	it("AgentService throttles agents.setSeq on rapid tool_execution bursts and flushes on disconnect", async () => {
		const t = await start();
		const machine = await pairMachine(t);
		const agent = await connectAgent(t, machine, "seq-burst");
		const setSeqSpy = vi.spyOn(t.relay.ctx.repos.agents, "setSeq");
		setSeqSpy.mockClear();

		for (let seq = 1; seq <= 6; seq++) {
			agent.client.send("agent.event", {
				epoch: "ep-1",
				seq,
				e: { type: "tool_execution_start", toolCallId: `tc-${seq}`, toolName: "bash", args: { cmd: "ls" } },
			});
		}
		// Wait until all 6 events are inserted in events table
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && t.relay.ctx.repos.events.count(agent.agentId) < 6) {
			await new Promise((r) => setTimeout(r, 15));
		}
		expect(t.relay.ctx.repos.events.count(agent.agentId)).toBe(6);
		// Throttled: only the first event in the 1s window should have written agents.setSeq
		expect(setSeqSpy.mock.calls.length).toBeLessThanOrEqual(2);

		// Disconnecting flushes the final seq (6) durably
		agent.client.close();
		await agent.client.waitClosed();
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.last_seq).toBe(6);
		setSeqSpy.mockRestore();
	});
});
