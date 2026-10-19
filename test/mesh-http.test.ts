import { AgentCommsRes, MeshConversationRes, MeshSnapshot } from "@j3pf/rp-protocol";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentClient,
	api,
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
	promptBody,
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

	it("never returns raw UUIDs or auto names in node names, group labels, fromName, or toName", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "mesh-uuid-pc");
		const uuidA = "01a14fbb-44e3-765f-99e1-970655bf47bf";
		const uuidB = "01a14fbb-2812-7332-aae5-d003f17b8fe7";
		const agentA = await connectAgent(t, machine, uuidA, {
			session: { id: uuidA, file: null, name: uuidA },
			cwd: "/workspace/backend",
		});
		const agentB = await connectAgent(t, machine, uuidB, {
			session: { id: uuidB, file: null, name: "subagent-chat-01a14fbb-44e3" },
			cwd: "/workspace/frontend",
		});
		recordComm(agentA, agentB, { commId: "uuid-comm-1", at: Date.now() });
		await waitForComms(agentA.agentId, 1);

		const snapRes = await api(t, "GET", "/v1/mesh", device.deviceToken);
		expect(snapRes.status).toBe(200);

		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		for (const n of snapRes.json.nodes) {
			expect(uuidRegex.test(n.name)).toBe(false);
			expect(n.name.startsWith("subagent-chat-")).toBe(false);
		}
		for (const group of snapRes.json.groups) {
			expect(uuidRegex.test(group.label)).toBe(false);
			expect(group.label.startsWith("subagent-chat-")).toBe(false);
		}

		const commsRes = await api(
			t,
			"GET",
			`/v1/mesh/agents/${encodeURIComponent(agentA.agentId)}/comms`,
			device.deviceToken,
		);
		expect(commsRes.status).toBe(200);
		for (const item of commsRes.json.items) {
			expect(uuidRegex.test(item.fromName)).toBe(false);
			expect(uuidRegex.test(item.toName)).toBe(false);
			expect(item.fromName.startsWith("subagent-chat-")).toBe(false);
			expect(item.toName.startsWith("subagent-chat-")).toBe(false);
		}

		const convRes = await api(
			t,
			"GET",
			`/v1/mesh/conversation?a=${encodeURIComponent(agentA.agentId)}&b=${encodeURIComponent(agentB.agentId)}`,
			device.deviceToken,
		);
		expect(convRes.status).toBe(200);
		for (const item of convRes.json.items) {
			expect(uuidRegex.test(item.fromName)).toBe(false);
			expect(uuidRegex.test(item.toName)).toBe(false);
			expect(item.fromName.startsWith("subagent-chat-")).toBe(false);
			expect(item.toName.startsWith("subagent-chat-")).toBe(false);
		}

		agentA.client.close();
		agentB.client.close();
		await Promise.all([agentA.client.waitClosed(), agentB.client.waitClosed()]);
	});

	it("emits fromName/toName matching disambiguated node names for duplicate agents via WS mesh.comm and HTTP /v1/mesh/conversation", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "mesh-dup-pc");
		const { client: app } = await connectApp(t, device);
		app.send("mesh.subscribe", { machineId: null });
		await app.next("mesh.snapshot");

		// Two agents with the exact same cwd on the same machine
		const agent1 = await connectAgent(t, machine, "agent-dup-1", {
			session: { id: "agent-dup-1", file: null, name: null },
			cwd: "/workspace/Rp-app",
		});
		const agent2 = await connectAgent(t, machine, "agent-dup-2", {
			session: { id: "agent-dup-2", file: null, name: null },
			cwd: "/workspace/Rp-app",
		});

		// Check snapshot node names
		const snap = await api(t, "GET", "/v1/mesh", device.deviceToken);
		const node1 = snap.json.nodes.find((n: { agentId: string }) => n.agentId === agent1.agentId);
		const node2 = snap.json.nodes.find((n: { agentId: string }) => n.agentId === agent2.agentId);
		expect(node1.name).toBe("Rp-app");
		expect(node2.name).toBe("Rp-app (2)");

		// agent1 sends comm to agent2
		recordComm(agent1, agent2, { commId: "dup-comm-1", at: Date.now() });

		// WS mesh.comm
		const wsComm = await app.next("mesh.comm");
		const commData = (wsComm.d as any).comm;
		expect(commData.fromName).toBe(node1.name);
		expect(commData.toName).toBe(node2.name);

		await waitForComms(agent1.agentId, 1);

		// HTTP /v1/mesh/conversation
		const convRes = await api(
			t,
			"GET",
			`/v1/mesh/conversation?a=${encodeURIComponent(agent1.agentId)}&b=${encodeURIComponent(agent2.agentId)}`,
			device.deviceToken,
		);
		expect(convRes.status).toBe(200);
		expect(convRes.json.items).toHaveLength(1);
		expect(convRes.json.items[0].fromName).toBe(node1.name);
		expect(convRes.json.items[0].toName).toBe(node2.name);

		agent1.client.close();
		agent2.client.close();
		app.close();
		await Promise.all([agent1.client.waitClosed(), agent2.client.waitClosed(), app.waitClosed()]);
	});

	it("updates prompt agentLabels and comm names dynamically when a new duplicate agent appears", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "mesh-dyn-pc");

		// 1. Agent 1 connects
		const agent1 = await connectAgent(t, machine, "dyn-agent-1", {
			session: { id: "dyn-agent-1", file: null, name: null },
			cwd: "/workspace/dup-app",
		});

		// Open prompt for Agent 1
		const p1 = promptBody(agent1.agentId);
		agent1.client.send("prompt.open", p1);
		await expect.poll(() => t.relay.ctx.repos.prompts.get(p1.promptId)?.state).toBe("open");

		// Verify initial prompt label before Agent 2 exists
		const promptsBefore = await api(t, "GET", "/v1/prompts?state=open", device.deviceToken);
		expect(promptsBefore.status).toBe(200);
		const promptItem1Before = promptsBefore.json.prompts.find((p: { promptId: string }) => p.promptId === p1.promptId);
		expect(promptItem1Before.agentLabel).toBe("dup-app");

		// 2. Agent 2 connects on the same machine with the same cwd
		const agent2 = await connectAgent(t, machine, "dyn-agent-2", {
			session: { id: "dyn-agent-2", file: null, name: null },
			cwd: "/workspace/dup-app",
		});

		// Open prompt for Agent 2
		const p2 = promptBody(agent2.agentId);
		agent2.client.send("prompt.open", p2);
		await expect.poll(() => t.relay.ctx.repos.prompts.get(p2.promptId)?.state).toBe("open");

		// 3. Verify open prompts list returns disambiguated labels without stale cache
		const promptsAfter = await api(t, "GET", "/v1/prompts?state=open", device.deviceToken);
		expect(promptsAfter.status).toBe(200);
		const promptItem1After = promptsAfter.json.prompts.find((p: { promptId: string }) => p.promptId === p1.promptId);
		const promptItem2After = promptsAfter.json.prompts.find((p: { promptId: string }) => p.promptId === p2.promptId);
		expect(promptItem1After.agentLabel).toBe("dup-app");
		expect(promptItem2After.agentLabel).toBe("dup-app (2)");

		// 4. Verify snapshot node names match
		const snap = await api(t, "GET", "/v1/mesh", device.deviceToken);
		const node1 = snap.json.nodes.find((n: { agentId: string }) => n.agentId === agent1.agentId);
		const node2 = snap.json.nodes.find((n: { agentId: string }) => n.agentId === agent2.agentId);
		expect(node1.name).toBe("dup-app");
		expect(node2.name).toBe("dup-app (2)");

		agent1.client.close();
		agent2.client.close();
		await Promise.all([agent1.client.waitClosed(), agent2.client.waitClosed()]);
	});
});
