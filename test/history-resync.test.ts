import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
	sleep,
	startRelay,
	type TestRelay,
} from "./helpers.js";

describe("history resync across reconnect snapshots", () => {
	let t: TestRelay;
	beforeEach(async () => {
		t = await startRelay();
	});
	afterEach(async () => {
		await t.stop();
		cleanup(t);
	});

	it("returns full snapshot entries when snapMeta.seq > sinceSeq on the same epoch", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-snap-gap");
		agent.client.send("agent.snapshot", {
			epoch: agent.hello.epoch,
			seq: 0,
			entries: [{ eid: "e1", kind: "user", at: 1, msg: { role: "user", content: "hola" } }],
		});
		agent.event({ type: "agent_start" }); // seq 1
		agent.event({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Ronda 2 en verde" }] },
		}); // seq 2
		agent.event({ type: "agent_settled", aborted: false }); // seq 3
		await sleep(60);

		// Simulate reconnect where plugin dropped queued events 4..10 and sent a newer snapshot at seq 10
		agent.client.send("agent.snapshot", {
			epoch: agent.hello.epoch,
			seq: 10,
			entries: [
				{ eid: "e1", kind: "user", at: 1, msg: { role: "user", content: "hola" } },
				{
					eid: "e2",
					kind: "assistant",
					at: 2,
					msg: { role: "assistant", content: [{ type: "text", text: "Cerró la Oleada 1 completa" }] },
				},
			],
		});
		await sleep(60);

		const { client: app } = await connectApp(t, dev);
		app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: 3, epoch: agent.hello.epoch });
		const hist = (await app.next("agent.history")).d as {
			entries: Array<{ eid: string }>;
			events: Array<{ seq: number }>;
			liveFromSeq: number;
		};

		expect(hist.entries.map((e) => e.eid)).toEqual(["e1", "e2"]);
		expect(hist.events).toEqual([]);
		expect(hist.liveFromSeq).toBe(10);

		agent.client.close();
		app.close();
	});

	it("pushes agent.history to active subscribers when a newer snapshot arrives", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-snap-push");
		agent.client.send("agent.snapshot", {
			epoch: agent.hello.epoch,
			seq: 0,
			entries: [{ eid: "e1", kind: "user", at: 1, msg: { role: "user", content: "hola" } }],
		});
		await sleep(60);

		const { client: app } = await connectApp(t, dev);
		app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: null, epoch: null });
		const initial = (await app.next("agent.history")).d as { entries: Array<{ eid: string }> };
		expect(initial.entries.map((e) => e.eid)).toEqual(["e1"]);

		// Agent sends a fresh snapshot covering missed messages while app still has the chat open
		agent.client.send("agent.snapshot", {
			epoch: agent.hello.epoch,
			seq: 10,
			entries: [
				{ eid: "e1", kind: "user", at: 1, msg: { role: "user", content: "hola" } },
				{
					eid: "e2",
					kind: "assistant",
					at: 2,
					msg: { role: "assistant", content: [{ type: "text", text: "Veredicto completo" }] },
				},
			],
		});

		const pushed = (await app.next("agent.history")).d as {
			entries: Array<{ eid: string }>;
			liveFromSeq: number;
		};
		expect(pushed.entries.map((e) => e.eid)).toEqual(["e1", "e2"]);
		expect(pushed.liveFromSeq).toBe(10);

		agent.client.close();
		app.close();
	});

	it("keeps incremental resume when sinceSeq already covers snapMeta.seq", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-snap-ok");
		agent.client.send("agent.snapshot", {
			epoch: agent.hello.epoch,
			seq: 5,
			entries: [{ eid: "e1", kind: "user", at: 1, msg: { role: "user", content: "hola" } }],
		});
		await sleep(40);
		agent.client.send("agent.event", {
			epoch: agent.hello.epoch,
			seq: 6,
			e: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "msg 6" }] } },
		});
		agent.client.send("agent.event", {
			epoch: agent.hello.epoch,
			seq: 7,
			e: { type: "agent_settled", aborted: false },
		});
		await sleep(60);

		const { client: app } = await connectApp(t, dev);
		app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: 5, epoch: agent.hello.epoch });
		const hist = (await app.next("agent.history")).d as {
			entries: Array<{ eid: string }>;
			events: Array<{ seq: number }>;
			liveFromSeq: number;
		};

		expect(hist.entries).toEqual([]);
		expect(hist.events.map((e) => e.seq)).toEqual([6, 7]);
		expect(hist.liveFromSeq).toBe(7);

		agent.client.close();
		app.close();
	});
});
