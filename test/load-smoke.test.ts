import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, cleanup, newCode, startRelay, type TestRelay } from "./helpers.js";
import { runLoad } from "./load/generator.js";

let t: TestRelay;
beforeAll(async () => {
	t = await startRelay({ limits: { eventsPerAgent: 5000 } });
});
afterAll(async () => {
	await t.stop();
	cleanup(t);
});

describe("carga (humo en CI; la prueba completa es `npm run test:load`)", () => {
	it("30 agentes × 20 ev/s × 2 apps durante 4 s: sin pérdidas de eventos finales y latencia acotada", async () => {
		const res = await runLoad({
			baseUrl: t.http,
			agents: 30,
			apps: 2,
			rate: 20,
			durationSec: 4,
			pair: async () => {
				const m = await api(t, "POST", "/v1/pair/machine", null, { code: newCode(t, "machine"), hostname: "load" });
				const d = await api(t, "POST", "/v1/pair/device", null, { code: newCode(t, "device"), name: "load" });
				return {
					machineId: m.json.machineId,
					machineToken: m.json.machineToken,
					deviceId: d.json.deviceId,
					deviceToken: d.json.deviceToken,
				};
			},
		});
		expect(res.aggregateEventsPerSec).toBeGreaterThan(400);
		expect(res.lostFinals).toBe(0);
		expect(res.received).toBeGreaterThan(res.expectedReceived * 0.99);
		// objetivo del plan: p99 < 50 ms en 1 vCPU; aquí relay + generador comparten proceso y CPU, margen amplio
		expect(res.latencyMs.p99).toBeLessThan(500);
		// persistencia: los finales (10 %) están en la base
		const n = t.relay.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='message_end'").get() as { n: number };
		expect(n.n).toBeGreaterThan(0);
	}, 60_000);
});
