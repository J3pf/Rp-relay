import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRetention } from "../src/retention.js";
import { DAY } from "../src/util/time.js";
import {
	type AgentClient,
	cleanup,
	connectAgent,
	pairMachine,
	promptBody,
	startRelay,
	type TestRelay,
} from "./helpers.js";

let relay: TestRelay;

beforeEach(async () => {
	relay = await startRelay();
});

afterEach(async () => {
	await relay.stop();
	cleanup(relay);
});

const OLD = Date.now() - 90 * DAY;

/** Seeds one event, one comm and one closed prompt for the agent, all older than every retention window. */
function seedOldHistory(agent: AgentClient, machineId: string, tag: string): void {
	const { repos } = relay.relay.ctx;
	repos.events.insert(agent.agentId, agent.hello.epoch as string, 1, OLD, "message_end", {
		type: "message_end",
		message: { role: "assistant", content: `${tag} old answer` },
	});
	repos.comms.upsert({
		agent_id: agent.agentId,
		comm_id: `${tag}-comm`,
		machine_id: machineId,
		direction: "out",
		channel: "intercom",
		action: "send",
		peer_session_id: null,
		peer_name: null,
		peer_cwd: null,
		peer_ref: null,
		peer_agent_id: null,
		message_id: null,
		reply_to: null,
		expects_reply: false,
		text: `${tag} old comm`,
		truncated: false,
		delivered: null,
		at: OLD,
	});
	const promptId = `${tag}-prompt`;
	repos.prompts.insert(agent.agentId, promptBody(agent.agentId, { promptId }) as never, OLD);
	repos.prompts.close(promptId, "resolved", "local", null, OLD);
}

describe("periodic retention vs archived history", () => {
	it("never prunes events, comms or closed prompts of an archived agent", async () => {
		const machine = await pairMachine(relay);
		const archived = await connectAgent(relay, machine, "retention-archived");
		const active = await connectAgent(relay, machine, "retention-active");
		seedOldHistory(archived, machine.machineId, "archived");
		seedOldHistory(active, machine.machineId, "active");

		archived.client.close();
		await archived.client.waitClosed();
		expect(relay.relay.ctx.agents.archive(archived.agentId)).toBe(true);
		active.client.close();
		await active.client.waitClosed();

		const { repos } = relay.relay.ctx;
		const archivedEvents = repos.events.count(archived.agentId);
		const activeEvents = repos.events.count(active.agentId);
		expect(archivedEvents).toBe(1);
		expect(activeEvents).toBe(1);

		// 45 days later: every window (events 7d, comms 7d, prompts 30d) has expired, agents 7d offline.
		const stats = await runRetention(relay.relay.ctx, Date.now() + 45 * DAY);
		expect(stats.events).toBeGreaterThan(0);

		// The archived agent keeps everything until an explicit purge.
		expect(repos.events.count(archived.agentId)).toBe(archivedEvents);
		expect(repos.comms.get(archived.agentId, "archived-comm")).toBeDefined();
		expect(repos.prompts.get("archived-prompt")).toBeDefined();
		expect(repos.agents.get(archived.agentId)?.archived_at).toEqual(expect.any(Number));

		// A non-archived agent's old rows are pruned by the same pass (the control case).
		expect(repos.events.count(active.agentId)).toBe(0);
		expect(repos.comms.get(active.agentId, "active-comm")).toBeUndefined();
		expect(repos.prompts.get("active-prompt")).toBeUndefined();
	});
});
