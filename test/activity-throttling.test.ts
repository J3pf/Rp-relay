import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, connectAgent, pairMachine, startRelay, type TestRelay } from "./helpers.js";

let t: TestRelay;
beforeAll(async () => {
	t = await startRelay();
});
afterAll(async () => {
	await t.stop();
	cleanup(t);
});

describe("Agent presence, last_seen_at preservation, and touch throttling", () => {
	it("preserves last_seen_at across reconnects when epoch is unchanged", async () => {
		const m = await pairMachine(t);
		const baselineTime = 1_700_000_000_000;

		const agent1 = await connectAgent(t, m, "sess-reconnect-preserve");
		const agentId = agent1.agentId;

		// Pin last_seen_at to baselineTime
		t.relay.ctx.repos.agents.touch(agentId, baselineTime);
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

		// Disconnect and wait for offline state
		agent1.client.close();
		await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.online).toBe(0));
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

		// Reconnect with same epoch (transient connection drop)
		const agent2 = await connectAgent(t, m, "sess-reconnect-preserve", { epoch: agent1.hello.epoch });
		const onlineRow = t.relay.ctx.repos.agents.get(agentId)!;
		expect(onlineRow.online).toBe(1);
		// last_seen_at must be preserved, not bumped to current reconnect time
		expect(onlineRow.last_seen_at).toBe(baselineTime);

		agent2.client.close();
	});

	it("updates last_seen_at on reconnect when epoch changed (new session/reboot)", async () => {
		const m = await pairMachine(t);
		const baselineTime = 1_700_000_000_000;

		const agent1 = await connectAgent(t, m, "sess-reconnect-epoch");
		const agentId = agent1.agentId;

		t.relay.ctx.repos.agents.touch(agentId, baselineTime);
		agent1.client.close();
		await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.online).toBe(0));

		// Reconnect with a new epoch (agent rebooted/new session)
		const rebootTime = 1_700_000_500_000;
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(rebootTime);
		try {
			const agent2 = await connectAgent(t, m, "sess-reconnect-epoch", { epoch: `new-epoch-${rebootTime}` });
			const onlineRow = t.relay.ctx.repos.agents.get(agentId)!;
			expect(onlineRow.online).toBe(1);
			expect(onlineRow.last_seen_at).toBe(rebootTime);
			agent2.client.close();
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("allows immediate activity event to touch DB after reconnect", async () => {
		const m = await pairMachine(t);
		const oldActivityTime = 1_700_000_000_000; // 1 hour ago
		const reconnectTime = 1_700_003_600_000;
		const immediateActivityTime = 1_700_003_601_000; // 1 second after reconnect (within 15s of reconnect!)

		let currentTime = oldActivityTime;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

		try {
			const agent1 = await connectAgent(t, m, "sess-reconnect-activity");
			const agentId = agent1.agentId;
			t.relay.ctx.repos.agents.touch(agentId, oldActivityTime);
			agent1.client.close();
			await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.online).toBe(0));

			// Advance clock to reconnect time
			currentTime = reconnectTime;
			const agent2 = await connectAgent(t, m, "sess-reconnect-activity", { epoch: agent1.hello.epoch });
			expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(oldActivityTime);

			// Immediate activity 1 second after reconnect:
			// Under cb5a904, conn.lastTouchAt is anchored to oldActivityTime, NOT reconnectTime.
			// Therefore, now (reconnectTime + 1000) - conn.lastTouchAt (oldActivityTime) > 15_000 ms!
			currentTime = immediateActivityTime;
			agent2.client.send("agent.event", {
				epoch: agent1.hello.epoch,
				seq: 1,
				e: { type: "tool_execution_start", tool: "read" },
			});

			await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.last_seen_at).toBe(immediateActivityTime));
			agent2.client.close();
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("preserves historical snapshot activity timestamp and permits subsequent activity touch", async () => {
		const m = await pairMachine(t);
		const historicalTime = 1_700_000_000_000;
		const snapshotConnectTime = 1_700_001_000_000;
		const newActivityTime = 1_700_001_001_000; // 1 second after snapshot

		let currentTime = snapshotConnectTime;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

		try {
			const agent = await connectAgent(t, m, "sess-snapshot-history");
			const agentId = agent.agentId;

			// Snapshot with historical entries
			agent.client.send("agent.snapshot", {
				epoch: agent.hello.epoch,
				seq: 1,
				entries: [
					{ eid: "e1", kind: "user", at: historicalTime, msg: { text: "hello" } },
					{ eid: "e2", kind: "assistant", at: historicalTime + 1000, msg: { message: "hi there" } },
				],
			});

			// DB last_seen_at must reflect the snapshot's activity timestamp
			await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.last_seen_at).toBe(historicalTime + 1000));

			// New activity arrives 1 second after snapshot ingestion
			currentTime = newActivityTime;
			agent.client.send("agent.event", {
				epoch: agent.hello.epoch,
				seq: 2,
				e: { type: "agent_start" },
			});

			await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.last_seen_at).toBe(newActivityTime));
			agent.client.close();
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("throttles touches during rapid activity events to at most once per 15s using clock advancement", async () => {
		const m = await pairMachine(t);
		const t0 = 1_700_000_000_000;
		let currentTime = t0;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

		try {
			const agent = await connectAgent(t, m, "sess-rapid-events");
			const agentId = agent.agentId;

			// First activity at t0 + 20_000 (20s after connect)
			currentTime = t0 + 20_000;
			agent.client.send("agent.event", {
				epoch: agent.hello.epoch,
				seq: 1,
				e: { type: "message_start" },
			});
			await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.last_seen_at).toBe(t0 + 20_000));

			// Rapid stream of message_delta frames at t0 + 25_000 (5s later, strictly within 15s window)
			currentTime = t0 + 25_000;
			for (let i = 2; i <= 10; i++) {
				agent.client.send("agent.event", {
					epoch: agent.hello.epoch,
					seq: i,
					e: { type: "message_delta", text: `chunk-${i}` },
				});
			}

			// Wait for all 10 deltas to be processed by tracking conn.lastSeq
			await vi.waitFor(() => expect(t.relay.ctx.hub.agents.get(agentId)?.lastSeq).toBe(10));

			// last_seen_at MUST still be t0 + 20_000 (throttled, NOT bumped to t0 + 25_000)
			expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(t0 + 20_000);

			// Now advance clock past 15s window: t0 + 36_000 (16s after first touch at t0 + 20_000)
			currentTime = t0 + 36_000;
			agent.client.send("agent.event", {
				epoch: agent.hello.epoch,
				seq: 11,
				e: { type: "message_end" },
			});

			// Now touch must occur and update last_seen_at to t0 + 36_000
			await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.last_seen_at).toBe(t0 + 36_000));
			agent.client.close();
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("does not touch last_seen_at for non-activity events", async () => {
		const m = await pairMachine(t);
		const baselineTime = 1_700_000_000_000;
		let currentTime = baselineTime;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

		try {
			const agent = await connectAgent(t, m, "sess-non-activity");
			const agentId = agent.agentId;

			t.relay.ctx.repos.agents.touch(agentId, baselineTime);
			expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

			// Advance clock by 100 seconds
			currentTime = baselineTime + 100_000;

			// Non-activity event: agent.status
			agent.client.send("agent.status", { status: "working" });
			await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.status).toBe("working"));
			expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

			// Non-activity event: model_select
			agent.client.send("agent.event", {
				epoch: agent.hello.epoch,
				seq: 1,
				e: { type: "model_select", model: { provider: "openai", id: "gpt-4o" } },
			});
			await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.model).toBe("openai/gpt-4o"));
			expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

			// Non-activity event: session_info_changed
			agent.client.send("agent.event", {
				epoch: agent.hello.epoch,
				seq: 2,
				e: { type: "session_info_changed", name: "Renamed Session" },
			});
			await vi.waitFor(() => expect(t.relay.ctx.repos.agents.get(agentId)?.session_name).toBe("Renamed Session"));
			expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

			agent.client.close();
		} finally {
			nowSpy.mockRestore();
		}
	});
});
