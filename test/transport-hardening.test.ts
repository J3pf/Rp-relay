import { EventEmitter } from "node:events";
import net from "node:net";
import { CloseCode } from "@j3pf/rp-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { parseConfig } from "../src/config.js";
import { buildHttp } from "../src/http/server.js";
import { createLogger } from "../src/util/log.js";
import { LongPollRegistry } from "../src/ws/agentGateway.js";
import { WsConn } from "../src/ws/conn.js";
import { LongPollConn } from "../src/ws/longpoll.js";
import {
	api,
	cleanup,
	connectAgent,
	connectApp,
	helloBody,
	pairDevice,
	pairMachine,
	sleep,
	startRelay,
	type TestRelay,
} from "./helpers.js";

const toClean: TestRelay[] = [];
const start = async (...args: Parameters<typeof startRelay>) => {
	const t = await startRelay(...args);
	toClean.push(t);
	return t;
};

afterEach(async () => {
	for (const t of toClean.splice(0)) {
		await t.stop().catch(() => {});
		cleanup(t);
	}
});

function attemptWsUpgrade(
	url: string,
	headers: Record<string, string>,
): Promise<{ type: "open"; ws: WebSocket } | { type: "closed"; code: number } | { type: "http"; status: number }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, { headers });
		let settled = false;
		const finish = (
			res: { type: "open"; ws: WebSocket } | { type: "closed"; code: number } | { type: "http"; status: number },
		) => {
			if (settled) return;
			settled = true;
			resolve(res);
		};
		ws.once("open", () => {
			// Wait briefly in case the server immediately closes with 4001 after upgrade
			const timer = setTimeout(() => finish({ type: "open", ws }), 40);
			ws.once("close", (code) => {
				clearTimeout(timer);
				finish({ type: "closed", code });
			});
		});
		ws.once("unexpected-response", (_req, res) => {
			res.resume();
			finish({ type: "http", status: res.statusCode ?? 0 });
		});
		ws.once("close", (code) => finish({ type: "closed", code }));
		ws.once("error", (err) => {
			if (!settled) reject(err);
		});
	});
}

function sendRawUpgrade(port: number, requestTarget: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: "127.0.0.1", port }, () => {
			socket.write(
				`GET ${requestTarget} HTTP/1.1\r\n` +
					"Host: localhost\r\n" +
					"Upgrade: websocket\r\n" +
					"Connection: Upgrade\r\n" +
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
					"Sec-WebSocket-Version: 13\r\n\r\n",
			);
		});
		let data = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			data += chunk;
		});
		socket.on("end", () => resolve(data));
		socket.on("close", () => resolve(data));
		socket.on("error", (err) => {
			if (data) resolve(data);
			else reject(err);
		});
	});
}

describe("transport & WS upgrade hardening (S1)", () => {
	it("B-01: malformed WS upgrade URL returns 400 Bad Request without crashing the process", async () => {
		const t = await start();
		const port = Number(new URL(t.http).port);

		const res1 = await sendRawUpgrade(port, "//:/");
		expect(res1).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);

		const res2 = await sendRawUpgrade(port, "http://[::1");
		expect(res2).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);

		// Relay remains healthy and serves subsequent requests normally
		const health = await api(t, "GET", "/healthz");
		expect(health.status).toBe(200);
	});

	it("W-01 / S-01: parseConfig parses RP_TRUST_PROXY variants and sets new default limits", () => {
		const defaults = parseConfig({}, {});
		expect(defaults.limits.maxWsPerDevice).toBe(32);
		expect(defaults.limits.maxWsTotal).toBe(1024);
		expect(defaults.limits.blobTotalMaxBytes).toBe(1_073_741_824);

		expect(parseConfig({}, { RP_TRUST_PROXY: "true" }).trustProxy).toBe(true);
		expect(parseConfig({}, { RP_TRUST_PROXY: "false" }).trustProxy).toBe(false);
		expect(parseConfig({}, { RP_TRUST_PROXY: "0" }).trustProxy).toBe(false);
		expect(parseConfig({}, { RP_TRUST_PROXY: "1" }).trustProxy).toBe(1);
		expect(parseConfig({}, { RP_TRUST_PROXY: "2" }).trustProxy).toBe(2);
		expect(parseConfig({}, { RP_TRUST_PROXY: "10.0.0.0/8, 127.0.0.1" }).trustProxy).toBe("10.0.0.0/8, 127.0.0.1");
	});

	it("W-01: leftmost spoofed X-Forwarded-For cannot bypass WS failed-upgrade rate limit behind 1 proxy hop", async () => {
		const t = await start({ trustProxy: 1 });
		const realClientIp = "198.51.100.77";

		for (let i = 0; i < 30; i++) {
			const res = await attemptWsUpgrade(`${t.ws}/ws/app`, {
				authorization: "Bearer rpd_invalid",
				"x-forwarded-for": `203.0.113.${(i % 200) + 1}, ${realClientIp}`,
			});
			expect(res).toEqual({ type: "closed", code: CloseCode.Unauthorized });
		}

		// 31st attempt from the same real client IP with yet another spoofed leftmost IP must be rate-limited
		const blocked = await attemptWsUpgrade(`${t.ws}/ws/app`, {
			authorization: "Bearer rpd_invalid",
			"x-forwarded-for": `192.0.2.99, ${realClientIp}`,
		});
		expect(blocked).toEqual({ type: "http", status: 429 });

		// A genuinely different client IP behind the same proxy still gets its own bucket
		const other = await attemptWsUpgrade(`${t.ws}/ws/app`, {
			authorization: "Bearer rpd_invalid",
			"x-forwarded-for": "192.0.2.99, 198.51.100.88",
		});
		expect(other).toEqual({ type: "closed", code: CloseCode.Unauthorized });

		// HTTP rate limiter with trustProxy=1 also ignores leftmost spoofed XFF
		const longPoll = new LongPollRegistry(() => t.relay.ctx);
		const app = await buildHttp({
			config: t.config,
			log: createLogger("silent"),
			c: () => t.relay.ctx,
			longPoll,
		});
		try {
			const h1 = await app.inject({
				method: "GET",
				url: "/v1/agents",
				remoteAddress: "172.18.0.2",
				headers: { "x-forwarded-for": "203.0.113.1, 198.51.100.50" },
			});
			const h2 = await app.inject({
				method: "GET",
				url: "/v1/agents",
				remoteAddress: "172.18.0.2",
				headers: { "x-forwarded-for": "203.0.113.2, 198.51.100.50" },
			});
			expect(Number(h2.headers["x-ratelimit-remaining"])).toBe(Number(h1.headers["x-ratelimit-remaining"]) - 1);
		} finally {
			longPoll.dispose();
			await app.close();
		}
	});

	it("R2-06: lowercase 'bearer rpd_...' and 'bearer rpm_...' headers bucket by device/machine token in HTTP rate limit", async () => {
		const { tokenKind } = await import("../src/auth/tokens.js");
		expect(tokenKind("rpd_abc")).toBe("device");
		expect(tokenKind("rpm_xyz")).toBe("machine");
		expect(tokenKind("other_123")).toBeUndefined();
		expect(tokenKind(undefined)).toBeUndefined();

		const t = await start();
		const dev = await pairDevice(t, "Phone");
		const machine = await pairMachine(t, "Workstation");
		const longPoll = new LongPollRegistry(() => t.relay.ctx);
		const app = await buildHttp({
			config: t.config,
			log: createLogger("silent"),
			c: () => t.relay.ctx,
			longPoll,
		});
		try {
			// Standard capitalized Bearer consumes 1 from dev:<id> bucket
			const r1 = await app.inject({
				method: "GET",
				url: "/v1/agents",
				remoteAddress: "198.51.100.10",
				headers: { authorization: `Bearer ${dev.deviceToken}` },
			});
			expect(r1.statusCode).toBe(200);
			const rem1 = Number(r1.headers["x-ratelimit-remaining"]);

			// Lowercase bearer from a DIFFERENT remote IP must share the same dev:<id> bucket
			const r2 = await app.inject({
				method: "GET",
				url: "/v1/agents",
				remoteAddress: "198.51.100.11",
				headers: { authorization: `bearer ${dev.deviceToken}` },
			});
			expect(r2.statusCode).toBe(200);
			const rem2 = Number(r2.headers["x-ratelimit-remaining"]);
			expect(rem2).toBe(rem1 - 1);

			// Lowercase bearer for machine token buckets by mac:<id> across different IPs
			const m1 = await app.inject({
				method: "POST",
				url: "/v1/agent/send",
				remoteAddress: "198.51.100.12",
				headers: { authorization: `Bearer ${machine.machineToken}`, "content-type": "application/json" },
				payload: [],
			});
			expect(m1.statusCode).toBe(200);
			const mRem1 = Number(m1.headers["x-ratelimit-remaining"]);

			const m2 = await app.inject({
				method: "POST",
				url: "/v1/agent/send",
				remoteAddress: "198.51.100.13",
				headers: { authorization: `bearer ${machine.machineToken}`, "content-type": "application/json" },
				payload: [],
			});
			expect(m2.statusCode).toBe(200);
			const mRem2 = Number(m2.headers["x-ratelimit-remaining"]);
			expect(mRem2).toBe(mRem1 - 1);
		} finally {
			longPoll.dispose();
			await app.close();
		}
	});

	it("W-06: WsConn.send() on hardBufferedBytes breach closes with 1013 and terminates stalled socket", async () => {
		class StalledSocket extends EventEmitter {
			readyState: number = WebSocket.OPEN;
			bufferedAmount = 10_000;
			closeCalls: Array<{ code: number; reason?: string }> = [];
			terminated = false;
			send = vi.fn();
			close(code: number, reason?: string) {
				this.closeCalls.push({ code, reason });
				this.readyState = WebSocket.CLOSING;
			}
			terminate() {
				this.terminated = true;
				this.readyState = WebSocket.CLOSED;
				this.emit("close", 1006);
			}
		}

		const sock = new StalledSocket();
		const conn = new WsConn(sock as unknown as WebSocket, 4096);
		const ok = conn.send({ v: 1, t: "agent.event", d: {} });
		expect(ok).toBe(false);
		expect(conn.closed).toBe(true);
		expect(sock.closeCalls).toEqual([{ code: CloseCode.TryAgainLater, reason: "slow consumer" }]);

		// Wait up to 650ms for the bounded terminate fallback (<= 500ms)
		await sleep(650);
		expect(sock.terminated).toBe(true);

		// If the socket closes promptly after close(1013), terminate() is not invoked
		const closingSock = new StalledSocket();
		closingSock.close = (code: number, reason?: string) => {
			closingSock.closeCalls.push({ code, reason });
			closingSock.readyState = WebSocket.CLOSED;
			closingSock.emit("close", code);
		};
		const conn2 = new WsConn(closingSock as unknown as WebSocket, 4096);
		expect(conn2.send({ v: 1, t: "agent.event", d: {} })).toBe(false);
		await sleep(550);
		expect(closingSock.terminated).toBe(false);
	});

	it("W-09 / R2-13: POST /v1/agent/poll mid-poll client disconnect aborts the waiter promptly and LongPollConn.closed is boolean", async () => {
		const lpConn = new LongPollConn("m1");
		expect(lpConn.closed).toBe(false);
		lpConn.close(CloseCode.Replaced, "replaced");
		expect(lpConn.closed).toBe(true);
		expect(typeof lpConn.closed).toBe("boolean");

		const t = await start();
		const m = await pairMachine(t);
		const hello = helloBody(m.machineId, "lp-disc", { transport: "longpoll" });
		await api(t, "POST", "/v1/agent/send", m.machineToken, [{ v: 1, t: "agent.hello", ts: Date.now(), d: hello }]);
		// Drain initial welcome
		const w = await api(t, "POST", "/v1/agent/poll", m.machineToken, {
			agentId: hello.agentId,
			instance: hello.instance,
			timeout: 500,
		});
		expect(w.status).toBe(200);

		const entry = (t.relay as any).longPoll.get(hello.agentId) as { conn: LongPollConn };
		expect(entry).toBeTruthy();

		// Spy on entry.conn.poll to observe when the server-side waiter finishes
		let pollResolvedAt: number | null = null;
		const origPoll = entry.conn.poll.bind(entry.conn);
		entry.conn.poll = async (...args) => {
			const res = await origPoll(...args);
			pollResolvedAt = Date.now();
			return res;
		};

		// Open a 20s POST /v1/agent/poll and abort it from the client after 80ms
		const ac = new AbortController();
		const reqPromise = fetch(`${t.http}/v1/agent/poll`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${m.machineToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ agentId: hello.agentId, instance: hello.instance, timeout: 20_000 }),
			signal: ac.signal,
		}).catch(() => null);

		await sleep(80);
		const abortedAt = Date.now();
		ac.abort();
		await reqPromise;

		// Wait briefly for server-side reply.raw close event to propagate and settle poll()
		for (let i = 0; i < 30 && pollResolvedAt === null; i++) {
			await sleep(20);
		}
		expect(pollResolvedAt).not.toBeNull();
		expect(pollResolvedAt! - abortedAt).toBeLessThan(1000);
	});

	it("S-01: per-device maxWsPerDevice and global maxWsTotal caps reject excess WS upgrades", async () => {
		const t = await start({ limits: { maxWsPerDevice: 2, maxWsTotal: 3 } });
		const dev1 = await pairDevice(t, "Device1");
		const dev2 = await pairDevice(t, "Device2");
		const m = await pairMachine(t, "HostPC");

		const a1 = await connectApp(t, dev1);
		const a2 = await connectApp(t, dev1, "direct");

		// 3rd WS for dev1 exceeds maxWsPerDevice=2 -> 429
		const dev1Third = await attemptWsUpgrade(`${t.ws}/ws/app`, {
			authorization: `Bearer ${dev1.deviceToken}`,
		});
		expect(dev1Third).toEqual({ type: "http", status: 429 });

		// dev2 still fits within maxWsTotal=3 (currently 2 active)
		const b1 = await connectApp(t, dev2);

		// Now 3 active WS connections == maxWsTotal=3 -> next upgrade (agent or app) rejected with 503
		const agentOverTotal = await attemptWsUpgrade(`${t.ws}/ws/agent`, {
			authorization: `Bearer ${m.machineToken}`,
		});
		expect(agentOverTotal).toEqual({ type: "http", status: 503 });

		// Closing one of dev1's sockets frees both a device slot and a global slot
		a2.client.close();
		await a2.client.waitClosed();
		await sleep(30);

		const agentOk = await connectAgent(t, m, "cap-ok");
		expect(agentOk.agentId).toBeTruthy();

		// Free another slot and confirm dev1 can reconnect
		agentOk.client.close();
		await agentOk.client.waitClosed();
		await sleep(30);

		const a3 = await connectApp(t, dev1);
		expect(a3.client).toBeTruthy();

		a1.client.close();
		b1.client.close();
		a3.client.close();
	});
});
