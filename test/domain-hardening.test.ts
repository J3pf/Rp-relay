import { MeshSnapshot } from "@j3pf/rp-protocol";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRow } from "../src/db/repos/agents.js";
import type { CommRow } from "../src/db/repos/comms.js";
import type { MachineRow } from "../src/db/repos/machines.js";
import { buildMeshSnapshot } from "../src/domain/mesh/topology.js";
import { runRetention } from "../src/retention.js";
import { DAY } from "../src/util/time.js";
import {
	api,
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
	sleep,
	startRelay,
	type TestRelay,
} from "./helpers.js";

const relays: TestRelay[] = [];

async function makeRelay(over: Record<string, unknown> = {}): Promise<TestRelay> {
	const r = await startRelay(over);
	relays.push(r);
	return r;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const r of relays.splice(0)) {
		await r.stop();
		cleanup(r);
	}
});

function makeAgentRow(id: string, overrides: Partial<AgentRow> = {}): AgentRow {
	const now = 1_700_000_000_000;
	return {
		id,
		machine_id: "machine-1",
		kind: "pi",
		instance: id,
		epoch: "epoch-1",
		session_id: `sess-${id}`,
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
		last_preview: `preview-${id}`,
		first_seen_at: now,
		last_seen_at: now,
		archived_at: null,
		...overrides,
	};
}

function makeMachineRow(overrides: Partial<MachineRow> = {}): MachineRow {
	const now = 1_700_000_000_000;
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

function makeCommRow(from: string, to: string, overrides: Partial<CommRow> = {}): CommRow {
	const now = 1_700_000_000_000;
	return {
		agent_id: from,
		comm_id: `${from}-${to}-${overrides.message_id ?? "msg"}`,
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
		text: `msg from ${from} to ${to}`,
		truncated: 0,
		delivered: 1,
		at: now - 1_000,
		created_at: now - 1_000,
		updated_at: now - 1_000,
		...overrides,
	};
}

describe("T4 domain hardening (S4)", () => {
	it("C-05: revokeMachine immediately rejects in-flight user.message with agent_offline and clears subscribers", async () => {
		const t = await makeRelay({ limits: { userMessageTimeoutMs: 5_000 } });
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "revoke-box");
		const agent = await connectAgent(t, machine, "revoke-sess");
		const { client: app } = await connectApp(t, device);

		app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: null, epoch: null });
		await app.next("agent.history");
		expect([...t.relay.ctx.hub.subscribers(agent.agentId)]).toHaveLength(1);

		const startedAt = Date.now();
		const sendPromise = t.relay.ctx.messages.send(device.deviceId, {
			agentId: agent.agentId,
			clientMsgId: "inflight-revoke-1",
			text: "hello before revoke",
		});

		// Ensure the message reached the agent before revoking
		await agent.client.next("user.message");

		expect(t.relay.ctx.entities.revokeMachine(machine.machineId)).toBe(true);

		await expect(sendPromise).rejects.toMatchObject({ code: "agent_offline" });
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect([...t.relay.ctx.hub.subscribers(agent.agentId)]).toHaveLength(0);
		for (const conn of t.relay.ctx.hub.apps) {
			expect(conn.subs.has(agent.agentId)).toBe(false);
		}

		app.close();
		await Promise.all([agent.client.waitClosed(), app.waitClosed()]);
	});

	it("C-05: runRetention forgets purged offline agents and MessageService caps done outer map size", async () => {
		const t = await makeRelay({ limits: { offlineAgentRetentionDays: 1 } });
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "retention-box");
		const agent = await connectAgent(t, machine, "retention-sess");
		const { client: app } = await connectApp(t, device);

		app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: null, epoch: null });
		await app.next("agent.history");
		t.relay.ctx.messages.onAck(agent.agentId, { clientMsgId: "ack-1", disposition: "sent" });
		expect((t.relay.ctx.messages as any).done.has(agent.agentId)).toBe(true);

		agent.client.close();
		await agent.client.waitClosed();
		const oldTime = Date.now() - 3 * DAY;
		t.relay.ctx.repos.agents.touch(agent.agentId, oldTime);

		const stats = await runRetention(t.relay.ctx, Date.now());
		expect(stats.agents).toBe(1);
		expect([...t.relay.ctx.hub.subscribers(agent.agentId)]).toHaveLength(0);
		expect((t.relay.ctx.messages as any).done.has(agent.agentId)).toBe(false);

		// Cap outer done map size at <= 2,000 agent IDs
		for (let i = 0; i < 2_050; i++) {
			t.relay.ctx.messages.onAck(`ephemeral-agent-${i}`, { clientMsgId: "m-1", disposition: "sent" });
		}
		const doneMap = (t.relay.ctx.messages as any).done as Map<string, Map<string, unknown>>;
		expect(doneMap.size).toBeLessThanOrEqual(2_000);
		expect(doneMap.has("ephemeral-agent-0")).toBe(false);
		expect(doneMap.has("ephemeral-agent-2049")).toBe(true);

		app.close();
		await app.waitClosed();
	});

	it("C-06: redacts comms at persist time, scrubs peer rows when purging a redacted agent, masks terminal_wait to foreground only, and redacts MeshNode todos/subagents", async () => {
		const t = await makeRelay();
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "redacted-box");
		const redactedAgent = await connectAgent(t, machine, "secret-agent", {
			redacted: true,
			session: { id: "secret-agent", file: null, name: "Secret" },
		});
		const publicAgent = await connectAgent(t, machine, "public-agent", {
			redacted: false,
			session: { id: "public-agent", file: null, name: "Public" },
		});
		const { client: fgApp } = await connectApp(t, device, "foreground");
		const { client: directApp } = await connectApp(t, device, "direct");

		// 1. terminal_wait masks title for redacted agent and only broadcasts to foreground sockets
		redactedAgent.event({ type: "terminal_wait", kind: "confirm", title: "Top secret prompt", active: true });
		const fgWait = await fgApp.next("terminal_wait");
		expect(fgWait.d).toMatchObject({ agentId: redactedAgent.agentId, title: null, active: true });
		await directApp.never("terminal_wait", 150);

		// 2. Comms emitted by public agent TO redacted receiver persist text: null
		const at = Date.now();
		publicAgent.event({
			type: "comm",
			commId: "pub-to-redacted",
			direction: "out",
			channel: "intercom",
			action: "send",
			peer: { sessionId: "secret-agent", name: "Secret", cwd: "/home/u/api", ref: null },
			messageId: "msg-to-redacted",
			replyTo: null,
			expectsReply: false,
			text: "Confidential payload to redacted receiver",
			truncated: false,
			delivered: true,
			at,
		});
		await expect.poll(() => t.relay.ctx.repos.comms.get(publicAgent.agentId, "pub-to-redacted")).toBeDefined();
		expect(t.relay.ctx.repos.comms.get(publicAgent.agentId, "pub-to-redacted")?.text).toBeNull();

		// 3. Simulate a legacy peer `in` row stored with plaintext referencing the redacted agent, then purge redacted agent
		t.relay.ctx.repos.comms.upsert({
			agent_id: publicAgent.agentId,
			comm_id: "legacy-in-from-redacted",
			machine_id: machine.machineId,
			direction: "in",
			channel: "intercom",
			action: "send",
			peer_session_id: "secret-agent",
			peer_name: "Secret",
			peer_cwd: "/home/u/api",
			peer_ref: null,
			peer_agent_id: redactedAgent.agentId,
			message_id: "legacy-msg-1",
			reply_to: null,
			expects_reply: false,
			text: "Legacy plaintext from redacted sender",
			truncated: false,
			delivered: true,
			at: at + 1,
		});

		redactedAgent.client.close();
		await redactedAgent.client.waitClosed();
		expect(t.relay.ctx.agents.archive(redactedAgent.agentId)).toBe(true);
		t.relay.ctx.agents.purge(redactedAgent.agentId);

		// After purge, the peer row must be scrubbed and HTTP API must return text: null
		expect(t.relay.ctx.repos.comms.get(publicAgent.agentId, "legacy-in-from-redacted")?.text).toBeNull();
		const commsRes = await api(
			t,
			"GET",
			`/v1/mesh/agents/${encodeURIComponent(publicAgent.agentId)}/comms`,
			device.deviceToken,
		);
		expect(commsRes.status).toBe(200);
		for (const item of commsRes.json.items) {
			expect(item.text).toBeNull();
		}

		// 4. MeshNode redaction for todos.current, subagents sensitive fields, and receiver-redacted edge preview
		const snap = buildMeshSnapshot({
			agents: [
				makeAgentRow("redacted-node", { redacted: 1, last_preview: "secret activity" }),
				makeAgentRow("public-node", { redacted: 0 }),
			],
			machines: [makeMachineRow()],
			comms: [makeCommRow("public-node", "redacted-node", { text: "secret inbound preview" })],
			now: 1_700_000_000_000,
			latestTodosByAgent: {
				"redacted-node": [
					{ id: "1", title: "Secret active task", status: "in_progress" },
					{ id: "2", title: "Secret done task", status: "done" },
				],
			},
			latestSubagentsByAgent: {
				"redacted-node": [
					{
						type: "subagent_update",
						taskId: "sub-secret",
						agent: "worker",
						label: "Secret label",
						status: "error",
						error: "Secret stack trace",
						result: { secret: "leaked" },
					},
				],
			},
		});
		expect(Value.Check(MeshSnapshot, snap)).toBe(true);
		const redactedNode = snap.nodes.find((n) => n.agentId === "redacted-node")!;
		expect(redactedNode.activity).toBeNull();
		expect(redactedNode.todos).toEqual({
			total: 2,
			done: 1,
			inProgress: 1,
			blocked: 0,
			pending: 0,
			current: null,
		});
		expect(redactedNode.subagents).toHaveLength(1);
		expect(redactedNode.subagents[0]).toMatchObject({ taskId: "sub-secret", agent: "worker", status: "error" });
		expect(redactedNode.subagents[0]?.label).toBeUndefined();
		expect(redactedNode.subagents[0]?.error).toBeUndefined();
		expect(redactedNode.subagents[0]?.result).toBeUndefined();
		expect(snap.edges[0]?.lastPreview).toBeNull();

		publicAgent.client.close();
		fgApp.close();
		directApp.close();
		await Promise.all([publicAgent.client.waitClosed(), fgApp.waitClosed(), directApp.waitClosed()]);
	});

	it("C-07: HistoryService.build returns most recent events (16..25) with truncated=true and liveFromSeq=25 on overflow", async () => {
		const t = await makeRelay({ limits: { eventsPerAgent: 10 } });
		const machine = await pairMachine(t, "history-box");
		const agent = await connectAgent(t, machine, "history-sess");

		// Store a snapshot at seq 0 with entries
		agent.client.send("agent.snapshot", {
			epoch: agent.hello.epoch,
			seq: 0,
			entries: [{ eid: "e-snap", kind: "user", at: 1, msg: { role: "user", content: "initial" } }],
			truncated: false,
		});
		for (let i = 1; i <= 25; i++) {
			agent.event({ type: "message_end", message: { role: "assistant", content: `msg-${i}` } });
		}
		await expect.poll(() => t.relay.ctx.repos.agents.get(agent.agentId)?.last_seq).toBe(25);

		const history = t.relay.ctx.history.build(agent.agentId, null, null);
		expect(history.events.map((e) => e.seq)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
		expect(history.truncated).toBe(true);
		expect(history.liveFromSeq).toBe(25);
		expect(history.entries).toEqual([]);

		// Resuming from seq 20 (<= 10 events) does not overflow
		const resumed = t.relay.ctx.history.build(agent.agentId, 20, agent.hello.epoch);
		expect(resumed.events.map((e) => e.seq)).toEqual([21, 22, 23, 24, 25]);
		expect(resumed.truncated).toBeUndefined();
		expect(resumed.liveFromSeq).toBe(25);

		agent.client.close();
		await agent.client.waitClosed();
	});

	it("W-10: single-subscriber warm-cache mesh.comm emits non-null groupId on first comm", async () => {
		const t = await makeRelay();
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "warm-cache-box");
		const sender = await connectAgent(t, machine, "warm-sender", {
			session: { id: "warm-sender", file: null, name: "WarmSender" },
		});
		const receiver = await connectAgent(t, machine, "warm-receiver", {
			session: { id: "warm-receiver", file: null, name: "WarmReceiver" },
		});

		// Single subscriber warms cache.get(null) while both agents have groupId: null
		const { client: app } = await connectApp(t, device);
		app.send("mesh.subscribe", { machineId: null });
		const snap = await app.next("mesh.snapshot");
		const nodes = (snap.d as any).nodes as { agentId: string; groupId: string | null }[];
		expect(nodes.find((n) => n.agentId === sender.agentId)?.groupId).toBeNull();

		sender.event({
			type: "comm",
			commId: "first-warm-comm",
			direction: "out",
			channel: "intercom",
			action: "send",
			peer: { sessionId: "warm-receiver", name: "WarmReceiver", cwd: "/home/u/api", ref: null },
			messageId: "warm-msg-1",
			replyTo: null,
			expectsReply: false,
			text: "First comm on warm cache",
			truncated: false,
			delivered: true,
			at: Date.now(),
		});

		const live = await app.next("mesh.comm");
		expect((live.d as any).comm.groupId).toBe(sender.agentId);

		sender.client.close();
		receiver.client.close();
		app.close();
		await Promise.all([sender.client.waitClosed(), receiver.client.waitClosed(), app.waitClosed()]);
	});

	it("W-03: unknown or revoked machineId does not grow MeshService.cache and mesh event index is used", async () => {
		const t = await makeRelay();
		const device = await pairDevice(t);
		const revoked = await pairMachine(t, "revoked-mesh-box");
		t.relay.ctx.entities.revokeMachine(revoked.machineId);

		for (let i = 0; i < 15; i++) {
			const res = await api(t, "GET", `/v1/mesh?machineId=unknown-machine-${i}`, device.deviceToken);
			expect(res.status).toBe(200);
			expect(res.json.nodes).toEqual([]);
			expect(res.json.edges).toEqual([]);
			expect(res.json.groups).toEqual([]);
		}
		const revokedRes = await api(t, "GET", `/v1/mesh?machineId=${revoked.machineId}`, device.deviceToken);
		expect(revokedRes.status).toBe(200);
		expect(revokedRes.json.nodes).toEqual([]);

		expect(((t.relay.ctx.mesh as any).cache as Map<string | null, unknown>).size).toBe(0);

		// Verify partial index 0007 exists and SQLite uses it for mesh event queries
		const idx = t.relay.db
			.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='events_mesh_types'")
			.get() as { sql: string } | undefined;
		expect(idx).toBeDefined();
		const plan = t.relay.db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT * FROM events WHERE agent_id=? AND epoch=? AND type IN ('todo_update', 'subagent_update') ORDER BY seq DESC LIMIT ?",
			)
			.all("a", "e", 1000) as { detail: string }[];
		expect(plan.map((r) => r.detail).join(" ")).toContain("events_mesh_types");
	});

	it("W-04: listUnresolved bounds by recency, limit, and excludes archived agents", async () => {
		const t = await makeRelay();
		const machine = await pairMachine(t, "unresolved-box");
		const active = await connectAgent(t, machine, "active-agent");
		const archived = await connectAgent(t, machine, "archived-agent");
		archived.client.close();
		await archived.client.waitClosed();
		t.relay.ctx.agents.archive(archived.agentId);

		const now = Date.now();
		t.relay.ctx.repos.comms.upsert({
			agent_id: active.agentId,
			comm_id: "old-unresolved",
			machine_id: machine.machineId,
			direction: "out",
			channel: "intercom",
			action: "send",
			peer_session_id: "missing-1",
			peer_name: null,
			peer_cwd: null,
			peer_ref: null,
			peer_agent_id: null,
			message_id: null,
			reply_to: null,
			expects_reply: false,
			text: "old",
			truncated: false,
			delivered: true,
			at: now - 2 * DAY,
		});
		t.relay.ctx.repos.comms.upsert({
			agent_id: archived.agentId,
			comm_id: "archived-unresolved",
			machine_id: machine.machineId,
			direction: "out",
			channel: "intercom",
			action: "send",
			peer_session_id: "missing-2",
			peer_name: null,
			peer_cwd: null,
			peer_ref: null,
			peer_agent_id: null,
			message_id: null,
			reply_to: null,
			expects_reply: false,
			text: "archived",
			truncated: false,
			delivered: true,
			at: now - 1000,
		});
		t.relay.ctx.repos.comms.upsert({
			agent_id: active.agentId,
			comm_id: "recent-unresolved",
			machine_id: machine.machineId,
			direction: "out",
			channel: "intercom",
			action: "send",
			peer_session_id: "missing-3",
			peer_name: null,
			peer_cwd: null,
			peer_ref: null,
			peer_agent_id: null,
			message_id: null,
			reply_to: null,
			expects_reply: false,
			text: "recent",
			truncated: false,
			delivered: true,
			at: now - 500,
		});

		const recent = t.relay.ctx.repos.comms.listUnresolved(now - DAY, 10);
		expect(recent.map((c) => c.comm_id)).toEqual(["recent-unresolved"]);

		active.client.close();
		await active.client.waitClosed();
	});

	it("W-11: PATCH /v1/machines/:id with {} on a revoked machine returns 404", async () => {
		const t = await makeRelay();
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "patch-empty-box");

		const activeRes = await api(t, "PATCH", `/v1/machines/${machine.machineId}`, device.deviceToken, {});
		expect(activeRes.status).toBe(200);

		expect(t.relay.ctx.entities.revokeMachine(machine.machineId)).toBe(true);
		const revokedRes = await api(t, "PATCH", `/v1/machines/${machine.machineId}`, device.deviceToken, {});
		expect(revokedRes.status).toBe(404);
	});

	it("W-12: routes with literal % in agentId (%25ZZ) do not return HTTP 500", async () => {
		const t = await makeRelay();
		const device = await pairDevice(t);

		const commsRes = await api(t, "GET", "/v1/mesh/agents/agent%25ZZ/comms", device.deviceToken);
		expect(commsRes.status).toBe(200);
		expect(commsRes.json).toEqual({ items: [] });

		const msgRes = await api(t, "POST", "/v1/agents/agent%25ZZ/messages", device.deviceToken, {
			clientMsgId: "msg-pct-1",
			text: "hello",
		});
		expect(msgRes.status).toBe(404);
	});

	it("W-13: agentId containing '|' builds valid mesh edges and components", () => {
		const aId = "m1:alpha|one";
		const bId = "m1:beta|two";
		const snap = buildMeshSnapshot({
			agents: [makeAgentRow(aId), makeAgentRow(bId)],
			machines: [makeMachineRow()],
			comms: [
				makeCommRow(aId, bId, { message_id: "p1", at: 1_700_000_000_000 - 2_000 }),
				makeCommRow(bId, aId, { message_id: "p2", action: "reply", reply_to: "p1", at: 1_700_000_000_000 - 1_000 }),
			],
			now: 1_700_000_000_000,
		});

		expect(snap.edges).toHaveLength(1);
		expect(snap.edges[0]).toMatchObject({
			a: aId,
			b: bId,
			count: 2,
			aToB: 1,
			bToA: 1,
		});
		expect(snap.groups).toHaveLength(1);
		expect(snap.groups[0]?.memberAgentIds).toEqual([aId, bId]);
	});

	it("W-14: rapid same-ms archives paginate without skipping items", async () => {
		const t = await makeRelay();
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "rapid-archive-box");
		const ids: string[] = [];

		for (let i = 0; i < 5; i++) {
			const agent = await connectAgent(t, machine, `rapid-${i}`);
			ids.push(agent.agentId);
			agent.client.close();
			await agent.client.waitClosed();
		}

		// Archive all 5 with the exact same timestamp
		const fixedNow = Date.now();
		for (const id of ids) {
			expect(t.relay.ctx.repos.agents.archive(id, fixedNow)).toBe(true);
		}
		// Ensure all archived_at timestamps are strictly unique
		const archivedAts = ids.map((id) => t.relay.ctx.repos.agents.get(id)?.archived_at);
		expect(new Set(archivedAts).size).toBe(5);

		// Paginate through REST API with limit=2 and ensure all 5 are returned
		const collected: string[] = [];
		let before: number | null = null;
		for (let page = 0; page < 10; page++) {
			const qs = before === null ? "?limit=2" : `?limit=2&before=${before}`;
			const res = await api(t, "GET", `/v1/agents/archived${qs}`, device.deviceToken);
			expect(res.status).toBe(200);
			for (const a of res.json.agents) collected.push(a.agentId);
			before = res.json.nextBefore;
			if (before === null) break;
		}
		expect(collected).toHaveLength(5);
		expect(new Set(collected)).toEqual(new Set(ids));
		await sleep(10);
	});
});
