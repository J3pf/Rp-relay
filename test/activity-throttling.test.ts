import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, connectAgent, pairMachine, sleep, startRelay, type TestRelay } from "./helpers.js";

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
		const baselineTime = Date.now() - 100_000;

		const agent1 = await connectAgent(t, m, "sess-reconnect-preserve");
		const agentId = agent1.agentId;

		// Pin last_seen_at to baselineTime
		t.relay.ctx.repos.agents.touch(agentId, baselineTime);
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

		// Disconnect and verify offline state preserves last_seen_at
		agent1.client.close();
		await sleep(50);
		const offlineRow = t.relay.ctx.repos.agents.get(agentId)!;
		expect(offlineRow.online).toBe(0);
		expect(offlineRow.last_seen_at).toBe(baselineTime);

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
		const baselineTime = Date.now() - 100_000;

		const agent1 = await connectAgent(t, m, "sess-reconnect-epoch");
		const agentId = agent1.agentId;

		t.relay.ctx.repos.agents.touch(agentId, baselineTime);
		agent1.client.close();
		await sleep(50);

		// Reconnect with a new epoch (agent rebooted/new session)
		const nowReboot = Date.now();
		const agent2 = await connectAgent(t, m, "sess-reconnect-epoch", { epoch: `new-epoch-${Date.now()}` });
		const onlineRow = t.relay.ctx.repos.agents.get(agentId)!;
		expect(onlineRow.online).toBe(1);
		expect(onlineRow.last_seen_at).toBeGreaterThanOrEqual(nowReboot);

		agent2.client.close();
	});

	it("allows immediate activity event to touch DB after reconnect", async () => {
		const m = await pairMachine(t);
		const baselineTime = Date.now() - 100_000;

		const agent1 = await connectAgent(t, m, "sess-reconnect-activity");
		const agentId = agent1.agentId;
		t.relay.ctx.repos.agents.touch(agentId, baselineTime);
		agent1.client.close();
		await sleep(50);

		const agent2 = await connectAgent(t, m, "sess-reconnect-activity", { epoch: agent1.hello.epoch });
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

		// Immediate activity event (e.g. tool execution 100ms after reconnect)
		const nowActivity = Date.now();
		agent2.client.send("agent.event", {
			epoch: agent1.hello.epoch,
			seq: 1,
			e: { type: "tool_execution_start", tool: "read" },
		});
		await sleep(50);

		// DB must be touched with new activity time
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBeGreaterThanOrEqual(nowActivity);

		agent2.client.close();
	});

	it("preserves historical snapshot activity timestamp and permits subsequent activity touch", async () => {
		const m = await pairMachine(t);
		const historicalTime = Date.now() - 300_000; // 5 minutes ago

		const agent = await connectAgent(t, m, "sess-snapshot-history");
		const agentId = agent.agentId;

		// Snapshot with historical entries conforming to Entry schema
		agent.client.send("agent.snapshot", {
			epoch: agent.hello.epoch,
			seq: 1,
			entries: [
				{ eid: "e1", kind: "user", at: historicalTime, msg: { text: "hello" } },
				{ eid: "e2", kind: "assistant", at: historicalTime + 1000, msg: { message: "hi there" } },
			],
		});
		await sleep(50);

		// DB last_seen_at must reflect the snapshot's activity timestamp
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(historicalTime + 1000);

		// Now new activity arrives
		const nowActivity = Date.now();
		agent.client.send("agent.event", {
			epoch: agent.hello.epoch,
			seq: 2,
			e: { type: "agent_start" },
		});
		await sleep(50);

		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBeGreaterThanOrEqual(nowActivity);

		agent.client.close();
	});

	it("throttles touches during rapid activity events to at most once per 15s", async () => {
		const m = await pairMachine(t);
		const baselineTime = Date.now() - 30_000;
		const agent = await connectAgent(t, m, "sess-rapid-events");
		const agentId = agent.agentId;

		// Reconnect with same epoch so last_seen_at and conn.lastTouchAt are baselineTime (>15s ago)
		t.relay.ctx.repos.agents.touch(agentId, baselineTime);
		agent.client.close();
		await sleep(50);
		const agent2 = await connectAgent(t, m, "sess-rapid-events", { epoch: agent.hello.epoch });
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

		// First activity touches DB because baselineTime > 15s ago
		const t1 = Date.now();
		agent2.client.send("agent.event", {
			epoch: agent.hello.epoch,
			seq: 1,
			e: { type: "message_start" },
		});
		await sleep(50);
		const firstSeen = t.relay.ctx.repos.agents.get(agentId)!.last_seen_at;
		expect(firstSeen).toBeGreaterThanOrEqual(t1);

		// Rapid stream of message_delta frames within 200ms
		for (let i = 2; i <= 20; i++) {
			agent2.client.send("agent.event", {
				epoch: agent.hello.epoch,
				seq: i,
				e: { type: "message_delta", text: `chunk-${i}` },
			});
		}
		await sleep(50);

		// last_seen_at must NOT have been updated on every frame (remains firstSeen)
		const afterStream = t.relay.ctx.repos.agents.get(agentId)!.last_seen_at;
		expect(afterStream).toBe(firstSeen);

		agent2.client.close();
	});

	it("does not touch last_seen_at for non-activity events", async () => {
		const m = await pairMachine(t);
		const baselineTime = Date.now() - 50_000;
		const agent = await connectAgent(t, m, "sess-non-activity");
		const agentId = agent.agentId;

		t.relay.ctx.repos.agents.touch(agentId, baselineTime);
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

		// Non-activity events: agent.status, model_select, thinking_level_select, session_info_changed
		agent.client.send("agent.status", { status: "working" });
		await sleep(30);
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

		agent.client.send("agent.event", {
			epoch: agent.hello.epoch,
			seq: 1,
			e: { type: "model_select", model: { provider: "openai", id: "gpt-4o" } },
		});
		await sleep(30);
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

		agent.client.send("agent.event", {
			epoch: agent.hello.epoch,
			seq: 2,
			e: { type: "session_info_changed", name: "Renamed Session" },
		});
		await sleep(30);
		expect(t.relay.ctx.repos.agents.get(agentId)!.last_seen_at).toBe(baselineTime);

		agent.client.close();
	});
});
