import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PromptRow } from "../src/db/repos/prompts.js";
import {
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

let relay: TestRelay;

beforeEach(async () => {
	relay = await startRelay({ limits: { promptGraceSeconds: 60 } });
});

afterEach(async () => {
	await relay.stop();
	cleanup(relay);
});

describe("agent archive lifecycle", () => {
	it("agent.forget archives an offline agent, preserves history, and removes it from app and mesh listings", async () => {
		const device = await pairDevice(relay);
		const machine = await pairMachine(relay);
		const agent = await connectAgent(relay, machine, "archive-offline");
		const { client: app } = await connectApp(relay, device);
		app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: null, epoch: null });
		await app.next("agent.history");

		agent.event({ type: "message_end", message: { role: "assistant", content: "preserved history" } });
		await app.next((message) => message.t === "agent.event" && (message.d as any).seq === 1);
		const eventCountBefore = relay.relay.ctx.repos.events.count(agent.agentId);
		const snapshotBefore = relay.relay.ctx.repos.events.snapshot(agent.agentId, agent.hello.epoch);
		expect(eventCountBefore).toBe(1);
		expect(snapshotBefore).toBeDefined();

		const openPrompt = promptBody(agent.agentId, { promptId: "archive-open-prompt" });
		const answeredPrompt = promptBody(agent.agentId, { promptId: "archive-answered-prompt" });
		agent.client.send("prompt.open", openPrompt);
		await app.next((message) => message.t === "prompt.opened" && (message.d as any).promptId === openPrompt.promptId);
		agent.client.send("prompt.open", answeredPrompt);
		await app.next(
			(message) => message.t === "prompt.opened" && (message.d as any).promptId === answeredPrompt.promptId,
		);
		const answered = await api(relay, "POST", `/v1/prompts/${answeredPrompt.promptId}/answer`, device.deviceToken, {
			answer: { optionIds: ["0"] },
		});
		expect(answered.status).toBe(200);
		await agent.client.next("prompt.answer");
		expect(relay.relay.ctx.repos.prompts.get(answeredPrompt.promptId)?.state).toBe("answered");

		const comm = relay.relay.ctx.repos.comms.upsert({
			agent_id: agent.agentId,
			comm_id: "archive-preserved-comm",
			machine_id: machine.machineId,
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
			text: "preserved comm",
			truncated: false,
			delivered: null,
			at: Date.now(),
		});

		agent.client.close();
		await app.next(
			(message) =>
				message.t === "agents.update" &&
				(message.d as any).upsert[0]?.agentId === agent.agentId &&
				!(message.d as any).upsert[0].online,
		);
		const forgetId = app.send("agent.forget", { agentId: agent.agentId });
		const ack = await app.next("ack");
		expect(ack.re).toBe(forgetId);
		const removed = await app.next(
			(message) => message.t === "agents.update" && (message.d as any).remove?.includes(agent.agentId),
		);
		expect(removed.d).toMatchObject({ upsert: [], remove: [agent.agentId] });

		const archived = relay.relay.ctx.repos.agents.get(agent.agentId);
		expect(archived).toBeDefined();
		expect(archived!.archived_at).toEqual(expect.any(Number));
		expect(archived!.online).toBe(0);
		expect(relay.relay.ctx.repos.agents.list().some((row) => row.id === agent.agentId)).toBe(false);
		expect(relay.relay.ctx.repos.events.count(agent.agentId)).toBe(eventCountBefore);
		expect(relay.relay.ctx.repos.events.snapshot(agent.agentId, agent.hello.epoch)).toEqual(snapshotBefore);
		expect(relay.relay.ctx.repos.comms.get(agent.agentId, comm.comm_id)).toEqual(comm);
		for (const promptId of [openPrompt.promptId, answeredPrompt.promptId]) {
			expect(relay.relay.ctx.repos.prompts.get(promptId)).toMatchObject({ id: promptId, state: "cancelled" });
		}
		const machineUpdate = await app.next(
			(message) =>
				message.t === "machines.update" &&
				(message.d as any).upsert[0]?.machineId === machine.machineId &&
				(message.d as any).upsert[0].agentCount === 0,
		);
		expect((machineUpdate.d as any).upsert[0].agentCount).toBe(0);

		const { client: laterApp, welcome } = await connectApp(relay, device);
		const welcomeData = welcome.d as any;
		expect(welcomeData.agents.some((row: any) => row.agentId === agent.agentId)).toBe(false);
		expect(welcomeData.machines.find((row: any) => row.machineId === machine.machineId).agentCount).toBe(0);
		laterApp.send("mesh.subscribe", { machineId: null });
		const mesh = await laterApp.next("mesh.snapshot");
		expect((mesh.d as any).nodes.some((node: any) => node.agentId === agent.agentId)).toBe(false);

		const repo = relay.relay.ctx.repos.agents;
		expect(repo.listAll().some((row) => row.id === agent.agentId)).toBe(true);
		expect(repo.listArchived(10).some((row) => row.id === agent.agentId)).toBe(true);
		expect(repo.listArchived(10, archived!.archived_at).some((row) => row.id === agent.agentId)).toBe(false);
		expect(repo.byMachine(machine.machineId).some((row) => row.id === agent.agentId)).toBe(false);
		expect(repo.counts().get(machine.machineId)).toBeUndefined();

		app.close();
		laterApp.close();
	});

	it("keeps the connected-agent conflict response and never republishes an archived row on socket loss", async () => {
		const device = await pairDevice(relay);
		const machine = await pairMachine(relay);
		const agent = await connectAgent(relay, machine, "archive-connected");
		const { client: app } = await connectApp(relay, device);
		const forgetId = app.send("agent.forget", { agentId: agent.agentId });
		const conflict = await app.next("error");
		expect(conflict.re).toBe(forgetId);
		expect(conflict.d).toMatchObject({ code: "conflict", message: "no se puede olvidar un agente conectado" });
		expect(relay.relay.ctx.repos.agents.get(agent.agentId)!.archived_at).toBeNull();

		expect(relay.relay.ctx.agents.archive(agent.agentId)).toBe(true);
		await app.next((message) => message.t === "agents.update" && (message.d as any).remove?.includes(agent.agentId));
		agent.client.close();
		await agent.client.waitClosed();
		await app.never(
			(message) =>
				message.t === "agents.update" && (message.d as any).upsert?.some((row: any) => row.agentId === agent.agentId),
			150,
		);
		app.close();
	});

	it("exposes archived queries with an exclusive timestamp cursor and still deletes all agents by machine", async () => {
		const machine = await pairMachine(relay);
		const active = await connectAgent(relay, machine, "archive-query-active");
		const archived = await connectAgent(relay, machine, "archive-query-archived");
		active.client.close();
		archived.client.close();
		await Promise.all([active.client.waitClosed(), archived.client.waitClosed()]);
		const repo = relay.relay.ctx.repos.agents;
		expect(repo.archive(archived.agentId, 100)).toBe(true);
		expect(repo.list().map((row) => row.id)).toEqual([active.agentId]);
		expect(repo.byMachine(machine.machineId).map((row) => row.id)).toEqual([active.agentId]);
		expect(
			repo
				.listAll()
				.map((row) => row.id)
				.sort(),
		).toEqual([active.agentId, archived.agentId].sort());
		expect(repo.listArchived(10).map((row) => row.id)).toEqual([archived.agentId]);
		expect(repo.listArchived(10, 100)).toEqual([]);
		expect(repo.counts().get(machine.machineId)).toEqual({ total: 1, online: 0 });
		repo.deleteByMachine(machine.machineId);
		expect(repo.get(active.agentId)).toBeUndefined();
		expect(repo.get(archived.agentId)).toBeUndefined();
	});

	it("does not dispatch prompt, settled, error, or terminal-wait pushes for archived agents", async () => {
		const device = await pairDevice(relay);
		relay.relay.ctx.repos.devices.setPush(device.deviceId, "fake-fcm-token", true);
		const machine = await pairMachine(relay);
		const agent = await connectAgent(relay, machine, "archive-no-push");
		agent.client.close();
		await agent.client.waitClosed();
		expect(relay.relay.ctx.agents.archive(agent.agentId)).toBe(true);

		const prompt: PromptRow = {
			id: "archive-no-push-prompt",
			agent_id: agent.agentId,
			kind: "confirm",
			category: "permission",
			payload: JSON.stringify(promptBody(agent.agentId, { promptId: "archive-no-push-prompt" })),
			state: "open",
			answer: null,
			resolved_by: null,
			answered_by_device: null,
			created_at: Date.now(),
			answered_at: null,
			resolved_at: null,
			expires_at: null,
			push_attempts: 0,
		};
		relay.relay.ctx.dispatcher.promptOpened(prompt);
		relay.relay.ctx.dispatcher.settled(agent.agentId, "hola");
		relay.relay.ctx.dispatcher.agentError(agent.agentId, "error");
		relay.relay.ctx.dispatcher.terminalWait(agent.agentId, "waiting");
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(relay.fcm.sent).toEqual([]);
		expect(relay.relay.ctx.repos.outbox.pendingFor(device.deviceId, Date.now())).toEqual([]);
		expect(prompt.push_attempts).toBe(0);
	});

	it("retention does not purge archived agents or their events", async () => {
		const machine = await pairMachine(relay);
		const agent = await connectAgent(relay, machine, "archive-retention");
		const device = await pairDevice(relay);
		const { client: app } = await connectApp(relay, device);
		app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: null, epoch: null });
		await app.next("agent.history");
		agent.event({ type: "message_end", message: { role: "assistant", content: "retained" } });
		await app.next((message) => message.t === "agent.event" && (message.d as any).seq === 1);
		agent.client.close();
		await app.next(
			(message) =>
				message.t === "agents.update" &&
				(message.d as any).upsert[0]?.agentId === agent.agentId &&
				!(message.d as any).upsert[0].online,
		);
		expect(relay.relay.ctx.agents.archive(agent.agentId)).toBe(true);
		const eventCount = relay.relay.ctx.repos.events.count(agent.agentId);
		expect(eventCount).toBe(1);

		const purged = relay.relay.ctx.repos.agents.purgeOffline(Date.now() + 30 * 24 * 3600 * 1000);
		expect(purged).not.toContain(agent.agentId);
		expect(relay.relay.ctx.repos.agents.get(agent.agentId)!.archived_at).toEqual(expect.any(Number));
		expect(relay.relay.ctx.repos.events.count(agent.agentId)).toBe(eventCount);
		app.close();
	});
});
