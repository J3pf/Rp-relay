import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

let t: TestRelay;
beforeAll(async () => {
	t = await startRelay();
});
afterAll(async () => {
	await t.stop();
	cleanup(t);
});

describe("WS mesh subscriptions", () => {
	it("sends an immediate all-machine snapshot and scopes machine subscriptions", async () => {
		const device = await pairDevice(t);
		const machineA = await pairMachine(t, "mesh-a");
		const machineB = await pairMachine(t, "mesh-b");
		const agentA = await connectAgent(t, machineA, "mesh-agent-a");
		const agentB = await connectAgent(t, machineB, "mesh-agent-b");
		const { client: app } = await connectApp(t, device);

		const allId = app.send("mesh.subscribe", { machineId: null });
		const allSnapshot = await app.next("mesh.snapshot");
		expect(allSnapshot.re).toBe(allId);
		expect(allSnapshot.d).toMatchObject({ machineId: null });
		expect((allSnapshot.d as any).nodes.map((node: any) => node.agentId)).toEqual(
			expect.arrayContaining([agentA.agentId, agentB.agentId]),
		);

		app.send("mesh.subscribe", { machineId: machineA.machineId });
		const scoped = await app.next("mesh.snapshot");
		expect(scoped.d).toMatchObject({ machineId: machineA.machineId });
		expect((scoped.d as any).nodes.map((node: any) => node.agentId)).toEqual([agentA.agentId]);

		agentA.client.close();
		agentB.client.close();
		app.close();
		await Promise.all([agentA.client.waitClosed(), agentB.client.waitClosed(), app.waitClosed()]);
		expect(t.relay.ctx.hub.hasMeshSubscribers()).toBe(false);
	});

	it("stops sending updates after mesh.unsubscribe", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const agent = await connectAgent(t, machine, "mesh-unsubscribe");
		const { client: app } = await connectApp(t, device);
		app.send("mesh.subscribe", { machineId: null });
		await app.next("mesh.snapshot");

		app.send("mesh.unsubscribe", {});
		agent.client.send("agent.status", { status: "working", detail: "after unsubscribe" });
		await app.never("mesh.update", 700);
		expect(t.relay.ctx.hub.hasMeshSubscribers()).toBe(false);

		agent.client.close();
		app.close();
		await Promise.all([agent.client.waitClosed(), app.waitClosed()]);
	});

	it("coalesces status, todo, and subagent changes to at most two updates per second", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const agent = await connectAgent(t, machine, "mesh-coalesce");
		const { client: app } = await connectApp(t, device);
		app.send("mesh.subscribe", { machineId: null });
		await app.next("mesh.snapshot");

		agent.client.send("agent.status", { status: "working", detail: "one" });
		const statusUpdate = await app.next(
			(message) => message.t === "agents.update" && (message.d as any).upsert[0]?.status === "working",
		);
		expect((statusUpdate.d as any).upsert[0].agentId).toBe(agent.agentId);
		agent.client.send("agent.statuses", { items: { "gentle:mode": "Permissions: AUTO" } });
		const statusesUpdate = await app.next(
			(message) => message.t === "agents.update" && (message.d as any).upsert[0]?.gentleMode === "auto",
		);
		expect((statusesUpdate.d as any).upsert[0].agentId).toBe(agent.agentId);
		agent.event({ type: "todo_update", tasks: [{ id: "todo-1", title: "Task", status: "in_progress" }] });
		agent.event({
			type: "subagent_update",
			taskId: "task-1",
			agent: "worker",
			label: "Worker",
			status: "running",
			model: null,
			thinking: null,
			startedAt: Date.now(),
			endedAt: null,
			durationMs: null,
			turns: 0,
			toolCalls: 0,
			tokens: null,
			cost: null,
			error: null,
			result: null,
			tools: [],
		});

		await sleep(1_100);
		const updates = app.count("mesh.update");
		expect(updates).toBeGreaterThan(0);
		expect(updates).toBeLessThanOrEqual(2);
		const latest = [...app.msgs].reverse().find((message) => message.t === "mesh.update");
		expect(latest).toBeDefined();
		const updatedAgent = (latest!.d as any).nodes.find((node: any) => node.agentId === agent.agentId);
		expect(updatedAgent).toMatchObject({
			status: "working",
			todos: { total: 1, inProgress: 1, current: "Task" },
			subagents: [expect.objectContaining({ taskId: "task-1", status: "running" })],
		});

		agent.client.close();
		app.close();
		await Promise.all([agent.client.waitClosed(), app.waitClosed()]);
	});

	it("broadcasts one live mesh.comm for deduplicated messages", async () => {
		const device = await pairDevice(t);
		const scopedDevice = await pairDevice(t);
		const unrelatedDevice = await pairDevice(t);
		const senderMachine = await pairMachine(t, "mesh-sender-machine");
		const receiverMachine = await pairMachine(t, "mesh-receiver-machine");
		const unrelatedMachine = await pairMachine(t, "mesh-unrelated-machine");
		const sender = await connectAgent(t, senderMachine, "mesh-sender", {
			session: { id: "mesh-sender", file: null, name: "Sender" },
		});
		const receiver = await connectAgent(t, receiverMachine, "mesh-receiver", {
			session: { id: "mesh-receiver", file: null, name: "Receiver" },
		});
		const { client: app } = await connectApp(t, device);
		const { client: scopedApp } = await connectApp(t, scopedDevice);
		const { client: unrelatedApp } = await connectApp(t, unrelatedDevice);
		app.send("mesh.subscribe", { machineId: null });
		await app.next("mesh.snapshot");
		scopedApp.send("mesh.subscribe", { machineId: receiverMachine.machineId });
		await scopedApp.next("mesh.snapshot");
		unrelatedApp.send("mesh.subscribe", { machineId: unrelatedMachine.machineId });
		await unrelatedApp.next("mesh.snapshot");

		const at = Date.now();
		sender.event({
			type: "comm",
			commId: "mesh-comm-out",
			direction: "out",
			channel: "intercom",
			action: "handover",
			peer: { sessionId: "mesh-receiver", name: "Receiver", cwd: "/home/u/api", ref: null },
			messageId: "mesh-message-1",
			replyTo: null,
			expectsReply: false,
			text: "Please continue this task",
			truncated: false,
			delivered: true,
			at,
		});
		const live = await app.next("mesh.comm");
		const scopedLive = await scopedApp.next("mesh.comm");
		await unrelatedApp.never("mesh.comm", 100);
		expect(live.d).toMatchObject({
			comm: {
				commKey: "mesh-comm-out",
				fromAgentId: sender.agentId,
				toAgentId: receiver.agentId,
				fromName: "Sender",
				toName: "Receiver",
				action: "handover",
				text: "Please continue this task",
				truncated: false,
				at,
				groupId: sender.agentId,
			},
		});
		expect(scopedLive.d).toMatchObject({
			comm: { fromAgentId: sender.agentId, toAgentId: receiver.agentId },
		});

		receiver.event({
			type: "comm",
			commId: "mesh-comm-in",
			direction: "in",
			channel: "intercom",
			action: "send",
			peer: { sessionId: "mesh-sender", name: "Sender", cwd: "/home/u/api", ref: null },
			messageId: "mesh-message-1",
			replyTo: null,
			expectsReply: false,
			text: "Please continue this task",
			truncated: false,
			delivered: null,
			at,
		});
		const update = await app.next("mesh.update");
		expect((update.d as any).edges).toHaveLength(1);
		expect((update.d as any).edges[0].count).toBe(1);
		expect(app.count("mesh.comm")).toBe(1);

		sender.client.close();
		receiver.client.close();
		app.close();
		scopedApp.close();
		unrelatedApp.close();
		await Promise.all([
			sender.client.waitClosed(),
			receiver.client.waitClosed(),
			app.waitClosed(),
			scopedApp.waitClosed(),
			unrelatedApp.waitClosed(),
		]);
	});

	it("refreshes an active comm edge to inactive without another event", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const sender = await connectAgent(t, machine, "mesh-active-sender");
		const receiver = await connectAgent(t, machine, "mesh-active-receiver");
		const { client: app } = await connectApp(t, device);
		app.send("mesh.subscribe", { machineId: null });
		await app.next("mesh.snapshot");

		const at = Date.now() - 16_000;
		sender.event({
			type: "comm",
			commId: "mesh-active-expiry",
			direction: "out",
			channel: "intercom",
			action: "send",
			peer: { sessionId: "mesh-active-receiver", name: "Receiver", cwd: "/home/u/api", ref: null },
			messageId: "mesh-active-message",
			replyTo: null,
			expectsReply: false,
			text: "A recent comm",
			truncated: false,
			delivered: true,
			at,
		});

		try {
			await app.next("mesh.comm");
			const activeUpdate = await app.next(
				(message) =>
					message.t === "mesh.update" &&
					(message.d as any).edges.some((edge: any) => edge.lastAt === at && edge.active === true),
			);
			const activeEdge = (activeUpdate.d as any).edges.find((edge: any) => edge.lastAt === at);
			expect(activeEdge).toMatchObject({ lastAt: at, active: true });

			const inactiveUpdate = await app.next(
				(message) =>
					message.t === "mesh.update" &&
					(message.d as any).edges.some((edge: any) => edge.lastAt === at && edge.active === false),
				7_000,
			);
			const inactiveEdge = (inactiveUpdate.d as any).edges.find((edge: any) => edge.lastAt === at);
			expect(inactiveEdge).toMatchObject({ lastAt: at, active: false });
		} finally {
			sender.client.close();
			receiver.client.close();
			app.close();
			await Promise.all([sender.client.waitClosed(), receiver.client.waitClosed(), app.waitClosed()]);
		}
	});

	it("redacts live comm text from a redacted sender", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const sender = await connectAgent(t, machine, "mesh-redacted", {
			redacted: true,
			session: { id: "mesh-redacted", file: null, name: "Private sender" },
		});
		const receiver = await connectAgent(t, machine, "mesh-public", {
			session: { id: "mesh-public", file: null, name: "Public receiver" },
		});
		const { client: app } = await connectApp(t, device);
		app.send("mesh.subscribe", { machineId: null });
		await app.next("mesh.snapshot");

		try {
			sender.event({
				type: "comm",
				commId: "mesh-comm-redacted",
				direction: "out",
				channel: "intercom",
				action: "send",
				peer: { sessionId: "mesh-public", name: "Public receiver", cwd: "/home/u/api", ref: null },
				messageId: "mesh-message-redacted",
				replyTo: null,
				expectsReply: false,
				text: "Secret text",
				truncated: false,
				delivered: true,
				at: Date.now(),
			});
			const live = await app.next("mesh.comm");
			expect((live.d as any).comm.text).toBeNull();
			const update = await app.next("mesh.update");
			const redactedEdge = (update.d as any).edges.find(
				(edge: any) => edge.a === sender.agentId || edge.b === sender.agentId,
			);
			expect(redactedEdge?.lastPreview).toBeNull();
		} finally {
			sender.client.close();
			receiver.client.close();
			app.close();
			await Promise.all([sender.client.waitClosed(), receiver.client.waitClosed(), app.waitClosed()]);
		}
	});

	it("does not build snapshots when events arrive without subscribers", async () => {
		const machine = await pairMachine(t);
		const agent = await connectAgent(t, machine, "mesh-no-subscriber");
		const listAgents = vi.spyOn(t.relay.ctx.repos.agents, "list");

		try {
			agent.client.send("agent.status", { status: "working", detail: "no listeners" });
			await sleep(50);
			expect(t.relay.ctx.hub.hasMeshSubscribers()).toBe(false);
			expect(listAgents).not.toHaveBeenCalled();
		} finally {
			listAgents.mockRestore();
			agent.client.close();
			await agent.client.waitClosed();
		}
	});
});
