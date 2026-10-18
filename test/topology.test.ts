import type { SubagentUpdateEvent, TodoTask } from "@j3pf/rp-protocol";
import { describe, expect, it } from "vitest";
import type { AgentRow } from "../src/db/repos/agents.js";
import type { CommRow } from "../src/db/repos/comms.js";
import type { MachineRow } from "../src/db/repos/machines.js";
import { buildMeshSnapshot } from "../src/domain/mesh/topology.js";

const now = 1_700_000_000_000;

function agent(id: string, overrides: Partial<AgentRow> = {}): AgentRow {
	return {
		id,
		machine_id: "machine-1",
		kind: "pi",
		instance: id,
		epoch: "epoch",
		session_id: `session-${id}`,
		session_name: null,
		session_file: null,
		launcher: null,
		herdr: null,
		gentle: null,
		gentle_mode: null,
		statuses: null,
		redacted: 0,
		spawn_id: null,
		cwd: `/repo/${id}`,
		git_branch: null,
		git_dirty: null,
		model: null,
		thinking: null,
		status: "working",
		status_detail: null,
		online: 1,
		pid: null,
		pi_version: null,
		plugin_version: null,
		features: null,
		transport: null,
		last_seq: 0,
		last_preview: `activity-${id}`,
		first_seen_at: now,
		last_seen_at: now,
		...overrides,
	};
}

function comm(from: string, to: string, overrides: Partial<CommRow> = {}): CommRow {
	return {
		agent_id: from,
		comm_id: `${from}-${to}-${overrides.message_id ?? "message"}`,
		machine_id: "machine-1",
		direction: "out",
		channel: "intercom",
		action: "send",
		peer_session_id: null,
		peer_name: null,
		peer_cwd: null,
		peer_ref: null,
		peer_agent_id: to,
		message_id: null,
		reply_to: null,
		expects_reply: 0,
		text: `from ${from} to ${to}`,
		truncated: 0,
		delivered: null,
		at: now - 1_000,
		created_at: now - 1_000,
		updated_at: now - 1_000,
		...overrides,
	};
}

function inbound(from: string, to: string, overrides: Partial<CommRow> = {}): CommRow {
	return comm(to, from, { direction: "in", peer_agent_id: from, ...overrides });
}

function machine(overrides: Partial<MachineRow> = {}): MachineRow {
	return {
		id: "machine-1",
		name: "Workstation",
		hostname: null,
		token_hash: Buffer.alloc(0),
		context: "work",
		color: "#123456",
		icon: null,
		quiet_hours: null,
		host_info: null,
		quotas: null,
		created_at: now,
		last_seen_at: now,
		revoked_at: null,
		...overrides,
	};
}

function snapshot(agents: AgentRow[], comms: CommRow[] = [], extra: Record<string, unknown> = {}) {
	return buildMeshSnapshot({
		agents,
		machines: [machine(), machine({ id: "machine-2", name: "Workstation 2" })],
		comms,
		now,
		...extra,
	});
}

function node(result: ReturnType<typeof snapshot>, agentId: string) {
	return result.nodes.find((item) => item.agentId === agentId)!;
}

describe("buildMeshSnapshot", () => {
	it("deduplicates out/in message IDs once and preserves the outgoing action", () => {
		const a = agent("a");
		const b = agent("b");
		const out = comm("a", "b", { action: "handover", message_id: "m-1", text: "handoff", at: now - 500 });
		const received = inbound("a", "b", {
			action: "send",
			message_id: "m-1",
			text: "handoff",
			at: now - 500,
		});

		const result = snapshot([a, b], [received, out]);
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0]).toMatchObject({
			count: 1,
			aToB: 1,
			bToA: 0,
			lastAction: "handover",
			lastPreview: "handoff",
		});
	});

	it("filters comms to the last 24 hours and scopes nodes to machineFilter", () => {
		const a = agent("a");
		const b = agent("b");
		const c = agent("c", { machine_id: "machine-2" });
		const old = comm("a", "b", { at: now - 24 * 60 * 60 * 1000 - 1 });
		const recent = comm("a", "b", { at: now - 1 });
		expect(snapshot([a, b], [old]).edges).toEqual([]);
		expect(snapshot([a, b], [recent]).edges).toHaveLength(1);

		const result = buildMeshSnapshot({
			agents: [a, b, c],
			machines: [machine()],
			comms: [recent, comm("a", "c", { at: now - 2 })],
			now,
			machineFilter: "machine-1",
		});
		expect(result.machineId).toBe("machine-1");
		expect(result.nodes.map((item) => item.agentId)).toEqual(["a", "b"]);
		expect(result.edges).toHaveLength(1);
	});

	it("does not count replies as initiations when selecting an orchestrator", () => {
		const a = agent("a", { first_seen_at: now - 30 });
		const b = agent("b", { first_seen_at: now - 20 });
		const c = agent("c", { first_seen_at: now - 10 });
		const result = snapshot(
			[a, b, c],
			[comm("a", "b", { action: "send" }), comm("b", "c", { action: "reply", reply_to: "parent-message" })],
		);
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0]?.orchestratorAgentId).toBe("a");
		expect(node(result, "a").role).toBe("orchestrator");
	});

	it("selects orchestrators by distinct peers, then initiation count, then oldest and agent ID", () => {
		const a = agent("a", { first_seen_at: now - 20 });
		const b = agent("b", { first_seen_at: now - 15 });
		const c = agent("c", { first_seen_at: now - 10 });
		const d = agent("d", { first_seen_at: now - 5 });
		const e = agent("e", { first_seen_at: now });
		const distinctPeerWinner = snapshot(
			[a, b, c, d, e],
			[
				comm("a", "b"),
				comm("a", "b", { message_id: "a-b-2" }),
				comm("a", "b", { message_id: "a-b-3" }),
				comm("c", "d"),
				comm("c", "e"),
				comm("b", "c", { action: "reply" }),
			],
		);
		expect(distinctPeerWinner.groups[0]?.orchestratorAgentId).toBe("c");

		const totalInitiationsWinner = snapshot(
			[a, b, c],
			[
				comm("a", "b", { message_id: "a-b-1" }),
				comm("a", "b", { message_id: "a-b-2" }),
				comm("c", "b"),
				comm("b", "c", { action: "reply" }),
			],
		);
		expect(totalInitiationsWinner.groups[0]?.orchestratorAgentId).toBe("a");

		const oldestWinner = snapshot([a, b, c], [comm("a", "b"), comm("c", "b")]);
		expect(oldestWinner.groups[0]?.orchestratorAgentId).toBe("a");

		const lexicalWinner = snapshot(
			[agent("z", { first_seen_at: 10 }), agent("x", { first_seen_at: 10 }), agent("y")],
			[comm("x", "y"), comm("z", "y")],
		);
		expect(lexicalWinner.groups[0]?.orchestratorAgentId).toBe("x");
	});

	it("derives a multi-level, cycle-free parent hierarchy", () => {
		const a = agent("a", { first_seen_at: 1 });
		const b = agent("b");
		const c = agent("c");
		const result = snapshot(
			[a, b, c],
			[
				comm("a", "b"),
				comm("a", "c"),
				comm("c", "b", { message_id: "c-b-1" }),
				comm("c", "b", { message_id: "c-b-2" }),
				comm("b", "c", { message_id: "b-c-1" }),
				comm("b", "c", { message_id: "b-c-2" }),
			],
		);
		expect(result.groups[0]?.orchestratorAgentId).toBe("a");
		expect(node(result, "b")).toMatchObject({ role: "subordinate", parentAgentId: "c" });
		expect(node(result, "c")).toMatchObject({ role: "subordinate", parentAgentId: "a" });
		for (const entry of result.nodes) {
			const seen = new Set([entry.agentId]);
			let parent = entry.parentAgentId;
			while (parent) {
				expect(seen.has(parent)).toBe(false);
				seen.add(parent);
				parent = node(result, parent).parentAgentId;
			}
		}
	});

	it("groups independent connected components and labels them from the common cwd", () => {
		const agents = [
			agent("a", { cwd: "/workspace/one/a", session_name: "Alpha", first_seen_at: 1 }),
			agent("b", { cwd: "/workspace/one/b" }),
			agent("c", { cwd: "/workspace/two/c", first_seen_at: 1 }),
			agent("d", { cwd: "/workspace/two/d" }),
			agent("solo"),
		];
		const result = snapshot(agents, [comm("a", "b"), comm("c", "d")]);
		expect(result.groups).toHaveLength(2);
		expect(result.groups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "Alpha", memberAgentIds: ["a", "b"], confidence: "comms" }),
				expect.objectContaining({ label: "two", memberAgentIds: ["c", "d"], confidence: "comms" }),
			]),
		);
		expect(node(result, "solo")).toMatchObject({ role: "solo", parentAgentId: null, groupId: null });
	});

	it("assigns human display names to nodes and disambiguates duplicates on the same machine", () => {
		const a1 = agent("a1", {
			machine_id: "machine-1",
			session_name: "01a14fbb-44e3-765f-99e1-970655bf47bf",
			cwd: "/workspace/Rp-app",
			first_seen_at: 100,
		});
		const a2 = agent("a2", {
			machine_id: "machine-1",
			session_name: "subagent-chat-01a14fbb-44e3-765f",
			cwd: "/workspace/Rp-app",
			first_seen_at: 200,
		});
		const a3 = agent("a3", {
			machine_id: "machine-2",
			session_name: null,
			cwd: "/workspace/Rp-app",
			first_seen_at: 150,
		});

		const result = snapshot([a1, a2, a3]);
		expect(node(result, "a1").name).toBe("Rp-app");
		expect(node(result, "a2").name).toBe("Rp-app (2)");
		expect(node(result, "a3").name).toBe("Rp-app");

		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		for (const n of result.nodes) {
			expect(uuidRegex.test(n.name)).toBe(false);
		}
	});

	it("never assigns a UUID or auto-name as a group label and falls back cleanly", () => {
		const orchestrator = agent("orch", {
			session_name: "01a14fbb-44e3-765f-99e1-970655bf47bf",
			cwd: "/workspace/project/backend",
		});
		const subordinate = agent("sub", {
			session_name: "subagent-chat-01a14fbb-44e3-765f",
			cwd: "/workspace/project/frontend",
		});
		const result = snapshot([orchestrator, subordinate], [comm("orch", "sub")]);
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0]?.label).toBe("project");

		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		for (const g of result.groups) {
			expect(uuidRegex.test(g.label)).toBe(false);
			expect(g.label.startsWith("subagent-chat-")).toBe(false);
		}
		for (const n of result.nodes) {
			expect(uuidRegex.test(n.name)).toBe(false);
			expect(n.name.startsWith("subagent-chat-")).toBe(false);
		}
	});

	it("falls back to same-machine cwd ancestor groups when agents have no comms", () => {
		const root = agent("root", { cwd: "/repo", session_name: "Project", first_seen_at: 1 });
		const middle = agent("middle", { cwd: "/repo/packages" });
		const leaf = agent("leaf", { cwd: "/repo/packages/core" });
		const otherMachine = agent("other", { machine_id: "machine-2", cwd: "/repo/packages/other" });
		const unrelated = agent("unrelated", { cwd: "/elsewhere" });
		const result = snapshot([root, middle, leaf, otherMachine, unrelated]);
		expect(result.groups).toContainEqual(
			expect.objectContaining({
				groupId: "root",
				label: "Project",
				orchestratorAgentId: "root",
				memberAgentIds: ["leaf", "middle", "root"],
				confidence: "cwd",
			}),
		);
		expect(node(result, "root")).toMatchObject({ role: "orchestrator", parentAgentId: null, groupId: "root" });
		expect(node(result, "middle")).toMatchObject({ role: "subordinate", parentAgentId: "root" });
		expect(node(result, "leaf")).toMatchObject({ role: "subordinate", parentAgentId: "middle" });
		expect(node(result, "other")).toMatchObject({ role: "solo", groupId: null });
		expect(node(result, "unrelated")).toMatchObject({ role: "solo", groupId: null });
	});

	it("marks agents with no comm or cwd relationship as solo", () => {
		const result = snapshot([agent("a"), agent("b", { machine_id: "machine-2", cwd: "/repo/a" })]);
		expect(result.groups).toEqual([]);
		expect(result.nodes.map((entry) => [entry.role, entry.groupId, entry.parentAgentId])).toEqual([
			["solo", null, null],
			["solo", null, null],
		]);
	});

	it("marks asks pending until a reply on the same edge refers to their message ID", () => {
		const a = agent("a");
		const b = agent("b");
		const pending = snapshot([a, b], [comm("a", "b", { action: "ask", message_id: "ask-1" })]);
		expect(pending.edges[0]?.pendingAsk).toBe(true);

		const answered = snapshot(
			[a, b],
			[
				comm("a", "b", { action: "ask", message_id: "ask-1" }),
				comm("b", "a", { action: "reply", message_id: "reply-1", reply_to: "ask-1" }),
			],
		);
		expect(answered.edges[0]?.pendingAsk).toBe(false);
	});

	it("marks edges active at exactly 20 seconds and inactive beyond it", () => {
		const agents = [agent("a"), agent("b")];
		const boundary = snapshot(agents, [comm("a", "b", { at: now - 20_000 })]);
		const expired = snapshot(agents, [comm("a", "b", { at: now - 20_001 })]);
		expect(boundary.edges[0]?.active).toBe(true);
		expect(expired.edges[0]?.active).toBe(false);
	});

	it("never exposes message previews or activity from a redacted sender", () => {
		const redacted = agent("a", { redacted: 1, last_preview: "private activity" });
		const result = snapshot([redacted, agent("b")], [comm("a", "b", { text: "private message" })]);
		expect(result.edges[0]?.lastPreview).toBeNull();
		expect(node(result, "a").activity).toBeNull();
	});

	it("formats the latest todos and latest subagent state per task, running first and capped at ten", () => {
		const tasks: TodoTask[] = [
			{ id: "d", title: "Done", status: "done" },
			{ id: "i1", title: "First active", status: "in_progress" },
			{ id: "i2", title: "Second active", status: "in_progress" },
			{ id: "b", title: "Blocked", status: "blocked" },
			{ id: "p", title: "Pending", status: "pending" },
			{ id: "x", title: "Dropped", status: "dropped" },
		];
		const event = (taskId: string, status: SubagentUpdateEvent["status"], agentName = taskId): SubagentUpdateEvent => ({
			type: "subagent_update",
			taskId,
			agent: agentName,
			status,
		});
		const subagents = [
			event("task-0", "done", "old state"),
			event("task-0", "running", "latest state"),
			...Array.from({ length: 11 }, (_, index) => event(`task-${index + 1}`, index < 4 ? "running" : "done")),
		];
		const result = buildMeshSnapshot({
			agents: [agent("a")],
			machines: [machine()],
			comms: [],
			now,
			latestTodosByAgent: { a: tasks },
			latestSubagentsByAgent: { a: subagents },
		});
		expect(node(result, "a").todos).toEqual({
			total: 6,
			done: 1,
			inProgress: 2,
			blocked: 1,
			pending: 1,
			current: "First active",
		});
		expect(node(result, "a").subagents).toHaveLength(10);
		expect(node(result, "a").subagents.find((item) => item.taskId === "task-0")).toMatchObject({
			taskId: "task-0",
			agent: "latest state",
			status: "running",
		});
		expect(node(result, "a").subagents.every((item) => !("type" in item))).toBe(true);
		expect(
			node(result, "a")
				.subagents.slice(0, 5)
				.every((item) => item.status === "running"),
		).toBe(true);
	});

	it("excludes agents belonging to revoked or missing machines and ignores malformed todo/subagent entries", () => {
		const validAgent = agent("a", { machine_id: "machine-1" });
		const revokedAgent = agent("revoked-agent", { machine_id: "machine-revoked" });
		const missingMachineAgent = agent("missing-machine-agent", { machine_id: "machine-missing" });
		const result = buildMeshSnapshot({
			agents: [validAgent, revokedAgent, missingMachineAgent],
			machines: [machine({ id: "machine-1" }), machine({ id: "machine-revoked", revoked_at: now - 100 })],
			comms: [comm("a", "revoked-agent"), comm("a", "missing-machine-agent")],
			now,
			latestTodosByAgent: {
				a: [null as unknown as TodoTask, { id: "t-1", title: "Valid task", status: "in_progress" }],
			},
			latestSubagentsByAgent: {
				a: [
					{ type: "subagent_update", taskId: "" as string, agent: "bad", status: "running" },
					{ type: "subagent_update", taskId: undefined as unknown as string, agent: "bad", status: "running" },
					{ type: "subagent_update", taskId: "ok-task", agent: "worker", status: "done" },
				],
			},
		});
		expect(result.nodes.map((item) => item.agentId)).toEqual(["a"]);
		expect(result.edges).toEqual([]);
		expect(node(result, "a").todos).toEqual({
			total: 1,
			done: 0,
			inProgress: 1,
			blocked: 0,
			pending: 0,
			current: "Valid task",
		});
		expect(node(result, "a").subagents).toEqual([{ taskId: "ok-task", agent: "worker", status: "done" }]);
	});
});
