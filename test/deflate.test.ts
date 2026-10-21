import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { cleanup, connectAgent, pairDevice, pairMachine, startRelay, type TestRelay } from "./helpers.js";

let t: TestRelay;
beforeAll(async () => {
	t = await startRelay();
});
afterAll(async () => {
	await t.stop();
	cleanup(t);
});

function createFrameCollector(ws: WebSocket) {
	const frames: { rsv1: boolean; length: number }[] = [];
	const listeners: ((frame: { rsv1: boolean; length: number }) => void)[] = [];
	const rawStream = (ws as unknown as { _socket: import("node:stream").Duplex })._socket;
	rawStream.on("data", (chunk: Buffer) => {
		if (chunk.length === 0) return;
		const rsv1 = !!(chunk[0]! & 0x40);
		const f = { rsv1, length: chunk.length };
		frames.push(f);
		for (const fn of listeners.splice(0)) fn(f);
	});
	return {
		frames,
		waitForFrame(
			predicate: (f: { rsv1: boolean; length: number }) => boolean,
			timeoutMs = 5000,
		): Promise<{ rsv1: boolean; length: number }> {
			const existing = frames.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timed out waiting for matching frame")), timeoutMs);
				listeners.push((f) => {
					if (predicate(f)) {
						clearTimeout(timer);
						resolve(f);
					}
				});
			});
		},
	};
}

describe("WebSocket perMessageDeflate compression", () => {
	it("negotiates with OkHttp client parameters (client_no_context_takeover)", async () => {
		const dev = await pairDevice(t);
		let negotiatedExtensions = "";

		const ws = new WebSocket(`${t.ws}/ws/app`, {
			headers: { authorization: `Bearer ${dev.deviceToken}` },
			perMessageDeflate: {
				clientNoContextTakeover: true,
				serverNoContextTakeover: true,
			},
		});

		ws.on("upgrade", (res) => {
			negotiatedExtensions = (res.headers["sec-websocket-extensions"] as string) ?? "";
		});

		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});

		expect(negotiatedExtensions).toContain("permessage-deflate");
		expect(negotiatedExtensions).toContain("server_no_context_takeover");
		expect(negotiatedExtensions).toContain("client_no_context_takeover");

		ws.close();
	});

	it("keeps frames < 1KB uncompressed and compresses frames >= 1KB", async () => {
		const dev = await pairDevice(t);
		const ws = new WebSocket(`${t.ws}/ws/app`, {
			headers: { authorization: `Bearer ${dev.deviceToken}` },
			perMessageDeflate: {
				clientNoContextTakeover: true,
				serverNoContextTakeover: true,
			},
		});

		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});

		const collector = createFrameCollector(ws);

		// 1. Send small message (< 1KB), server replies with app.welcome (< 1KB)
		const welcomePromise = collector.waitForFrame(() => true);
		ws.send(
			JSON.stringify({
				v: 1,
				t: "app.hello",
				id: "deflate-small-1",
				ts: Date.now(),
				d: { app: { version: "0.5.5", build: 1 }, deviceId: dev.deviceId },
			}),
		);

		const welcomeFrame = await welcomePromise;
		// App welcome frame is small (< 1KB) -> must be uncompressed (rsv1 === false)
		expect(welcomeFrame.rsv1).toBe(false);

		// 2. Pair a machine and an agent that produces a large mesh snapshot (>= 1KB)
		const m = await pairMachine(t);
		const largeAgent = await connectAgent(t, m, "sess-large-deflate", {
			session: { id: "sess-large-deflate", file: "/tmp/sess.jsonl", name: `Large Session ${"X".repeat(1200)}` },
		});

		// Subscribe to mesh on app socket -> server sends mesh.snapshot which is > 1KB
		const meshFramePromise = collector.waitForFrame((f) => f.rsv1);
		ws.send(
			JSON.stringify({
				v: 1,
				t: "mesh.subscribe",
				id: "deflate-mesh-sub",
				ts: Date.now(),
				d: {},
			}),
		);

		const compressedFrame = await meshFramePromise;
		expect(compressedFrame.rsv1).toBe(true);

		ws.close();
		largeAgent.client.close();
	});

	it("protects against compression bombs exceeding maxPayload on decompressed size", async () => {
		const dev = await pairDevice(t);
		const ws = new WebSocket(`${t.ws}/ws/app`, {
			headers: { authorization: `Bearer ${dev.deviceToken}` },
			perMessageDeflate: true,
		});

		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});

		const closePromise = new Promise<number>((resolve) => {
			ws.once("close", (code) => resolve(code));
		});
		ws.on("error", () => {
			// Ignore client-side connection reset during server 1009 abort
		});

		// 2MB of repetitive data compresses to ~2KB, exceeding the 1MB MAX_FRAME_BYTES when decompressed
		const bomb = Buffer.alloc(2 * 1024 * 1024, "a");
		ws.send(bomb, { compress: true });

		const closedCode = await closePromise;
		// Server closes connection with 1009 (WS_ERR_UNSUPPORTED_MESSAGE_LENGTH / Message too big)
		expect(closedCode).toBe(1009);
	});
});
