import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type EchoServer, startEcho } from "../spikes/s3-echo.js";

let s: EchoServer;
beforeAll(async () => {
	s = await startEcho({ port: 0, token: "tok" });
});
afterAll(() => s.close());

describe("spike S3: eco WS con auth Bearer", () => {
	it("con token correcto hace eco; con token incorrecto cierra con 4001", async () => {
		const good = new WebSocket(`ws://127.0.0.1:${s.port}/ws/echo`, { headers: { authorization: "Bearer tok" } });
		const msgs: string[] = [];
		good.on("message", (d) => msgs.push(d.toString()));
		await new Promise((r) => good.once("open", r));
		const msgPromise = new Promise<void>((resolve) => {
			good.on("message", () => {
				if (msgs.length >= 2) resolve();
			});
		});
		good.send("ping-de-prueba");
		await msgPromise;
		expect(msgs[0]).toContain("hello");
		expect(msgs[1]).toBe("ping-de-prueba");
		good.close();

		const bad = new WebSocket(`ws://127.0.0.1:${s.port}/ws/echo`, { headers: { authorization: "Bearer mal" } });
		const code = await new Promise<number>((r) => bad.on("close", r));
		expect(code).toBe(4001);
	});
});
