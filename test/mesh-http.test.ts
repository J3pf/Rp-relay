import { AgentCommsRes, MeshConversationRes, MeshSnapshot } from "@j3pf/rp-protocol";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentClient,
	api,
	cleanup,
	connectAgent,
	pairDevice,
	pairMachine,
	startRelay,
	type TestRelay,
} from "./helpers.js";

let t: TestRelay;
beforeEach(async () => {
	t = await startRelay();
});
afterEach(async () => {
	await t.stop();
	cleanup(t);
});

async function setupAgents(options: { redactedA?: boolean } = {}) {
	const device = await pairDevice(t);
	const machineA = await pairMachine(t, "mesh-http-a");
	const machineB = await pairMachine(t, "mesh-http-b");
	const agentA = await connectAgent(t, machineA, "mesh-http-session-a", {
		redacted: options.redactedA ?? false,
		session: { id: "mesh-http-session-a", file: null, name: "Alpha" },
	});
	const agentB = await connectAgent(t, machineB, "mesh-http-session-b", {
		session: { id: "mesh-http-session-b", file: null, name: "Beta" },
	});
	return { device, machineA, machineB, agentA, agentB };
}

function recordComm(
	emitter: AgentClient,
	peer: AgentClient,
	options: {
		commId: string;
		direction?: "out" | "in";
		action?: "send" | "ask" | "reply" | "handover";
		messageId?: string | null;
		at: number;
		text?: string;
	},
): void {
	emitter.event({
		type: "comm",
		commId: options.commId,
		direction: options.direction ?? "out",
		channel: "intercom",
		action: options.action ?? "send",
		peer: {
			sessionId: peer.hello.session.id,
			name: peer.hello.session.name,
			cwd: peer.hello.cwd,
			ref: null,
		},
		messageId: options.messageId ?? null,
		replyTo: null,
		expectsReply: false,
		text: options.text ?? options.commId,
		truncated: false,
		delivered: true,
		at: options.at,
	});
}

async function waitForComms(agentId: string, count: number): Promise<void> {
	await expect.poll(() => t.relay.ctx.repos.comms.listByAgent(agentId, 100).length).toBeGreaterThanOrEqual(count);
}

async function expectedGroupId(token: string, fromAgentId: string, toAgentId: string): Promise<string | null> {
	const snapshot = await api(t, "GET", "/v1/mesh", token);
	const from = snapshot.json.nodes.find((node: { agentId: string }) => node.agentId === fromAgentId);
	const to = snapshot.json.nodes.find((node: { agentId: string }) => node.agentId === toAgentId);
	return from?.groupId ?? to?.groupId ?? null;
}

describe("HTTP mesh routes", () => {
	it("requires a device token on each endpoint", async () => {
		const paths = ["/v1/mesh", "/v1/mesh/conversation?a=agent-a&b=agent-b", "/v1/mesh/agents/agent-a/comms"];
		for (const path of paths) {
			const response = await api(t, "GET", path);
			expect(response.status, path).toBe(401);
		}
	});

	it("returns a mesh snapshot and filters it by machineId", async () => {
		const { device, machineA, agentA, agentB } = await setupAgents();
		const all = await api(t, "GET", "/v1/mesh", device.deviceToken);
		expect(all.status).toBe(200);
		expect(Value.Check(MeshSnapshot, all.json)).toBe(true);
		expect(all.json).toMatchObject({
			machineId: null,
			generatedAt: expect.any(Number),
			groups: expect.any(Array),
			edges: expect.any(Array),
			nodes: expect.arrayContaining([
				expect.objectContaining({ agentId: agentA.agentId, machineId: machineA.machineId }),
				expect.objectContaining({ agentId: agentB.agentId }),
			]),
		});

		const filtered = await api(
			t,
			"GET",
			`/v1/mesh?machineId=${encodeURIComponent(machineA.machineId)}`,
			device.deviceToken,
		);
		expect(filtered.status).toBe(200);
		expect(filtered.json.machineId).toBe(machineA.machineId);
		expect(filtered.json.nodes.map((node: { agentId: string }) => node.agentId)).toEqual([agentA.agentId]);
	});

	it("refreshes edge activity on HTTP snapshots without WS subscribers", async () => {
		const { device, agentA, agentB } = await setupAgents();
		const at = Date.now();
		recordComm(agentA, agentB, { commId: "active-edge", messageId: "active-edge-message", at });
		await waitForComms(agentA.agentId, 1);

		const first = await api(t, "GET", "/v1/mesh", device.deviceToken);
		expect(first.status).toBe(200);
		expect(first.json.edges).toHaveLength(1);
		expect(first.json.edges[0].active).toBe(true);

		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(at + 20_001);
		try {
			const later = await api(t, "GET", "/v1/mesh", device.deviceToken);
			expect(later.status).toBe(200);
			expect(later.json.edges[0].active).toBe(false);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("rejects non-numeric conversation before cursors", async () => {
		const { device, agentA, agentB } = await setupAgents();
		const response = await api(
			t,
			"GET",
			`/v1/mesh/conversation?a=${encodeURIComponent(agentA.agentId)}&b=${encodeURIComponent(agentB.agentId)}&before=abc`,
			device.deviceToken,
		);
		expect(response.status).toBe(400);
		expect(response.json.error).toMatchObject({
			code: "bad_request",
			message: "before debe ser un timestamp numérico válido",
		});
	});

	it("returns descending conversation messages, deduplicates out/in rows, keeps OUT action, and redacts sender text", async () => {
		const { device, agentA, agentB } = await setupAgents({ redactedA: true });
		const baseAt = Date.now() - 5_000;
		recordComm(agentA, agentB, {
			commId: "out-duplicate",
			action: "handover",
			messageId: "shared-message",
			at: baseAt + 3_000,
			text: "private handover",
		});
		recordComm(agentB, agentA, {
			commId: "in-duplicate",
			direction: "in",
			action: "send",
			messageId: "shared-message",
			at: baseAt + 3_000,
			text: "private handover",
		});
		recordComm(agentA, agentB, { commId: "older-message", messageId: "older", at: baseAt + 2_000 });
		await waitForComms(agentA.agentId, 3);

		const response = await api(
			t,
			"GET",
			`/v1/mesh/conversation?a=${encodeURIComponent(agentA.agentId)}&b=${encodeURIComponent(agentB.agentId)}`,
			device.deviceToken,
		);
		expect(response.status).toBe(200);
		expect(Value.Check(MeshConversationRes, response.json)).toBe(true);
		expect(response.json).toMatchObject({ nextBefore: null });
		expect(response.json.items).toHaveLength(2);
		expect(response.json.items.map((item: { at: number }) => item.at)).toEqual([baseAt + 3_000, baseAt + 2_000]);
		expect(response.json.items[0]).toMatchObject({
			commKey: "out-duplicate",
			fromAgentId: agentA.agentId,
			toAgentId: agentB.agentId,
			fromName: "Alpha",
			toName: "Beta",
			action: "handover",
			text: null,
			truncated: false,
			at: baseAt + 3_000,
			groupId: await expectedGroupId(device.deviceToken, agentA.agentId, agentB.agentId),
		});
		expect(response.json.items[1].text).toBeNull();
	});

	it("pages conversations using the before cursor and sets nextBefore only when more rows exist", async () => {
		const { device, agentA, agentB } = await setupAgents();
		const times = [1_000, 2_000, 3_000, 4_000].map((offset) => Date.now() - 5_000 + offset);
		for (const at of times) {
			recordComm(agentA, agentB, { commId: `page-${at}`, messageId: `page-message-${at}`, at });
		}
		await waitForComms(agentA.agentId, 4);
		const conversation = `/v1/mesh/conversation?a=${encodeURIComponent(agentA.agentId)}&b=${encodeURIComponent(agentB.agentId)}`;

		const first = await api(t, "GET", `${conversation}&limit=2`, device.deviceToken);
		expect(first.status).toBe(200);
		expect(first.json.items.map((item: { at: number }) => item.at)).toEqual(times.slice(2).reverse());
		expect(first.json.nextBefore).toBe(times[2]);

		const last = await api(t, "GET", `${conversation}&limit=2&before=${first.json.nextBefore}`, device.deviceToken);
		expect(last.status).toBe(200);
		expect(last.json.items.map((item: { at: number }) => item.at)).toEqual(times.slice(0, 2).reverse());
		expect(last.json.nextBefore).toBeNull();
	});

	it("returns agent comms in AgentCommsRes shape and respects limit", async () => {
		const { device, machineB, agentA, agentB } = await setupAgents();
		const agentC = await connectAgent(t, machineB, "mesh-http-session-c", {
			session: { id: "mesh-http-session-c", file: null, name: "Gamma" },
		});
		const times = [1_000, 2_000, 3_000].map((offset) => Date.now() - 5_000 + offset);
		for (const at of times) {
			recordComm(agentA, agentB, { commId: `agent-${at}`, messageId: `agent-message-${at}`, at });
		}
		recordComm(agentB, agentC, { commId: "unrelated-agent-comms", at: Date.now() });
		await waitForComms(agentA.agentId, 3);
		await waitForComms(agentB.agentId, 4);

		const response = await api(
			t,
			"GET",
			`/v1/mesh/agents/${encodeURIComponent(agentA.agentId)}/comms?limit=2`,
			device.deviceToken,
		);
		expect(response.status).toBe(200);
		expect(Value.Check(AgentCommsRes, response.json)).toBe(true);
		expect(Object.keys(response.json).sort()).toEqual(["items"]);
		expect(response.json.items).toHaveLength(2);
		expect(response.json.items.map((item: { at: number }) => item.at)).toEqual(times.slice(1).reverse());
		expect(response.json.items.map((item: { commKey: string }) => item.commKey)).not.toContain("unrelated-agent-comms");
		for (const item of response.json.items) {
			expect(item).toMatchObject({
				fromAgentId: agentA.agentId,
				toAgentId: agentB.agentId,
				fromName: "Alpha",
				toName: "Beta",
				action: "send",
				text: expect.any(String),
				truncated: false,
				groupId: await expectedGroupId(device.deviceToken, agentA.agentId, agentB.agentId),
			});
			expect(item.at).toEqual(expect.any(Number));
			expect(item.commKey).toEqual(expect.any(String));
		}
	});

	it("paginates paired out/in rows accurately and merges peer_agent_id from paired in row when out row was unresolved", async () => {
		const { device, machineA, agentA, agentB } = await setupAgents();
		const baseAt = Date.now() - 10_000;

		// Message 1: out row initially has peer_agent_id = null, paired in row resolves peer_agent_id = agentA.agentId
		t.relay.ctx.repos.comms.upsert({
			agent_id: agentA.agentId,
			comm_id: "out-unresolved-1",
			machine_id: machineA.machineId,
			direction: "out",
			channel: "intercom",
			action: "handover",
			peer_session_id: null,
			peer_name: "UnknownYet",
			peer_cwd: null,
			peer_ref: null,
			peer_agent_id: null,
			message_id: "paired-msg-1",
			reply_to: null,
			expects_reply: false,
			text: "handover payload",
			truncated: false,
			delivered: true,
			at: baseAt + 1_000,
		});
		recordComm(agentB, agentA, {
			commId: "in-resolved-1",
			direction: "in",
			action: "send",
			messageId: "paired-msg-1",
			at: baseAt + 1_005,
			text: "handover payload",
		});

		// Message 2: paired out + in
		recordComm(agentA, agentB, {
			commId: "out-2",
			action: "ask",
			messageId: "paired-msg-2",
			at: baseAt + 2_000,
			text: "question",
		});
		recordComm(agentB, agentA, {
			commId: "in-2",
			direction: "in",
			action: "ask",
			messageId: "paired-msg-2",
			at: baseAt + 2_005,
			text: "question",
		});
		await waitForComms(agentB.agentId, 3);

		// Exactly 2 logical messages (4 raw rows): limit=2 should return both items and nextBefore: null
		const conv = await api(
			t,
			"GET",
			`/v1/mesh/conversation?a=${encodeURIComponent(agentA.agentId)}&b=${encodeURIComponent(agentB.agentId)}&limit=2`,
			device.deviceToken,
		);
		expect(conv.status).toBe(200);
		expect(conv.json.items).toHaveLength(2);
		expect(conv.json.nextBefore).toBeNull();
		expect(conv.json.items[1]).toMatchObject({
			commKey: "out-unresolved-1",
			fromAgentId: agentA.agentId,
			toAgentId: agentB.agentId,
			action: "handover",
			at: baseAt + 1_000,
		});

		// Agent comms with limit=2 also returns 2 deduplicated items with resolved toAgentId
		const agentComms = await api(
			t,
			"GET",
			`/v1/mesh/agents/${encodeURIComponent(agentA.agentId)}/comms?limit=2`,
			device.deviceToken,
		);
		expect(agentComms.status).toBe(200);
		expect(agentComms.json.items).toHaveLength(2);
		expect(agentComms.json.items[1]).toMatchObject({
			commKey: "out-unresolved-1",
			fromAgentId: agentA.agentId,
			toAgentId: agentB.agentId,
			action: "handover",
		});
	});

	it("retains todo/subagent state across >5000 streaming deltas and invalidates cache on machine revoke", async () => {
		const { device, machineB, agentA, agentB } = await setupAgents();
		agentA.event({
			type: "todo_update",
			tasks: [{ id: "1", title: "Still active after deltas", status: "in_progress" }],
		});
		agentA.event({
			type: "subagent_update",
			taskId: "sub-1",
			agent: "helper",
			status: "running",
		});
		// Advance last_seq far beyond 5,000
		agentA.client.send("agent.event", {
			epoch: agentA.hello.epoch,
			seq: 10_000,
			e: { type: "agent_settled" },
		});
		await expect.poll(() => t.relay.ctx.repos.agents.get(agentA.agentId)?.last_seq).toBe(10_000);

		const snap1 = await api(t, "GET", "/v1/mesh", device.deviceToken);
		const nodeA = snap1.json.nodes.find((n: { agentId: string }) => n.agentId === agentA.agentId);
		expect(nodeA.todos).toMatchObject({ current: "Still active after deltas", inProgress: 1 });
		expect(nodeA.subagents).toEqual([expect.objectContaining({ taskId: "sub-1", status: "running" })]);

		// Revoking machineB immediately removes agentB from /v1/mesh
		t.relay.ctx.entities.revokeMachine(machineB.machineId);
		const snap2 = await api(t, "GET", "/v1/mesh", device.deviceToken);
		expect(snap2.json.nodes.map((n: { agentId: string }) => n.agentId)).toEqual([agentA.agentId]);
		expect(snap2.json.nodes.map((n: { agentId: string }) => n.agentId)).not.toContain(agentB.agentId);
	});
});
