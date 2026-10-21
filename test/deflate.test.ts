import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { cleanup, pairDevice, pairMachine, sleep, startRelay, type TestRelay } from "./helpers.js";

let t: TestRelay;
beforeAll(async () => {
	t = await startRelay();
});
afterAll(async () => {
	await t.stop();
	cleanup(t);
});

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

		const receivedFrames: { rsv1: boolean; length: number }[] = [];
		ws._socket.on("data", (chunk: Buffer) => {
			if (chunk.length === 0) return;
			const rsv1 = !!(chunk[0]! & 0x40);
			receivedFrames.push({ rsv1, length: chunk.length });
		});

		// 1. Send small message (< 1KB), server replies with app.welcome (< 1KB)
		ws.send(
			JSON.stringify({
				v: 1,
				t: "app.hello",
				id: "deflate-small-1",
				ts: Date.now(),
				d: { app: { version: "0.5.5", build: 1 }, deviceId: dev.deviceId },
			}),
		);

		await sleep(150);
		expect(receivedFrames.length).toBeGreaterThan(0);
		// App welcome frame is small (< 1KB) -> must be uncompressed (rsv1 === false)
		expect(receivedFrames[0]!.rsv1).toBe(false);

		// 2. Pair a machine and an agent that produces a large mesh snapshot (>= 1KB)
		const m = await pairMachine(t);
		const agentWs = new WebSocket(`${t.ws}/ws/agent`, {
			headers: { authorization: `Bearer ${m.machineToken}` },
		});
		await new Promise<void>((resolve, reject) => {
			agentWs.once("open", () => resolve());
			agentWs.once("error", reject);
		});

		// Hello for agent with lots of text / features to exceed 1KB in mesh snapshot
		agentWs.send(
			JSON.stringify({
				v: 1,
				t: "agent.hello",
				id: "deflate-agent-hello",
				ts: Date.now(),
				d: {
					agentId: `${m.machineId}:sess-large-deflate`,
					kind: "pi",
					instance: "inst-1",
					epoch: "ep-1",
					pi: { version: "1.2.0", mode: "tui" },
					plugin: { version: "0.5.5", features: ["gate", "comms", "topology"] },
					session: { id: "sess-large-deflate", file: "/tmp/sess.jsonl", name: "Large Session " + "X".repeat(1200) },
					host: { hostname: "devbox", pid: 1, os: "linux" },
					launcher: "pi",
					herdr: null,
					gentle: null,
					transport: "ws",
					redacted: false,
					cwd: "/home/user/large-project",
					spawnId: null,
					git: { branch: "main", dirty: false },
					model: { provider: "anthropic", id: "claude-3-7-sonnet" },
					thinking: "medium",
					status: "idle",
					openPrompts: [],
				},
			}),
		);
		await sleep(150);

		// Subscribe to mesh on app socket -> server sends mesh.snapshot which is > 1KB
		receivedFrames.length = 0;
		ws.send(
			JSON.stringify({
				v: 1,
				t: "mesh.subscribe",
				id: "deflate-mesh-sub",
				ts: Date.now(),
				d: {},
			}),
		);

		await sleep(200);
		// Find frame for mesh snapshot (should be compressed)
		const compressedFrame = receivedFrames.find((f) => f.rsv1);
		expect(compressedFrame).toBeDefined();
		expect(compressedFrame!.rsv1).toBe(true);

		ws.close();
		agentWs.close();
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

		let closedCode = 0;
		ws.on("close", (code) => {
			closedCode = code;
		});

		// 2MB of repetitive data compresses to ~2KB, exceeding the 1MB MAX_FRAME_BYTES when decompressed
		const bomb = Buffer.alloc(2 * 1024 * 1024, "a");
		ws.send(bomb, { compress: true });

		await sleep(250);
		// Server closes connection with 1009 (WS_ERR_UNSUPPORTED_MESSAGE_LENGTH / Message too big)
		expect(closedCode).toBe(1009);
	});
});
