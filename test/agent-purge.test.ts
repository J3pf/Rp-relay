import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let relay: TestRelay;

beforeEach(async () => {
	relay = await startRelay();
});

afterEach(async () => {
	await relay.stop();
	cleanup(relay);
});

async function persistAssistantEvent(
	app: Awaited<ReturnType<typeof connectApp>>["client"],
	agent: AgentClient,
	content: string,
): Promise<void> {
	app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: null, epoch: null });
	await app.next((message) => message.t === "agent.history" && (message.d as any).agentId === agent.agentId);
	agent.event({ type: "message_end", message: { role: "assistant", content } });
	await app.next(
		(message) =>
			message.t === "agent.event" && (message.d as any).agentId === agent.agentId && (message.d as any).seq > 0,
	);
}

async function archiveAgent(agent: AgentClient): Promise<void> {
	agent.client.close();
	await agent.client.waitClosed();
	expect(relay.relay.ctx.agents.archive(agent.agentId)).toBe(true);
}

function addPrompt(agentId: string, promptId: string): void {
	relay.relay.ctx.repos.prompts.insert(agentId, promptBody(agentId, { promptId }) as never, Date.now());
}

function addComm(agentId: string, machineId: string, commId: string): void {
	relay.relay.ctx.repos.comms.upsert({
		agent_id: agentId,
		comm_id: commId,
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
		text: "stored communication",
		truncated: false,
		delivered: null,
		at: Date.now(),
	});
}

async function archivedList(app: Awaited<ReturnType<typeof connectApp>>["client"], d: Record<string, unknown> = {}) {
	const id = app.send("agent.archived", d);
	const response = await app.next((message) => message.t === "agent.archived.list" && message.re === id);
	return response.d as { agents: any[]; nextBefore: number | null };
}

describe("agent archived listing and purge", () => {
	it("lists archived agents over WS with display details and exclusive paging", async () => {
		const device = await pairDevice(relay);
		const machine = await pairMachine(relay, "devbox", { name: "Archive machine" });
		const otherMachine = await pairMachine(relay, "other", { name: "Other machine" });
		const active = await connectAgent(relay, machine, "still-active");
		const older = await connectAgent(relay, machine, "archived-older");
		const newer = await connectAgent(relay, machine, "archived-newer");
		const { client: app } = await connectApp(relay, device);

		await persistAssistantEvent(app, older, "older archived answer");
		await archiveAgent(older);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await archiveAgent(newer);

		const all = await archivedList(app);
		expect(all.nextBefore).toBeNull();
		expect(all.agents.map((agent) => agent.agentId)).toEqual([newer.agentId, older.agentId]);
		expect(all.agents[0]).toMatchObject({
			agentId: newer.agentId,
			machineId: machine.machineId,
			machineName: "Archive machine",
			sessionName: "refactor auth",
			cwd: "/home/u/api",
			lastSeenAt: expect.any(Number),
			archivedAt: expect.any(Number),
			lastMessagePreview: null,
			messageCount: 0,
		});
		expect(all.agents[1]).toMatchObject({
			agentId: older.agentId,
			machineName: "Archive machine",
			lastMessagePreview: "older archived answer",
			messageCount: 1,
		});
		expect(all.agents.some((agent) => agent.agentId === active.agentId)).toBe(false);

		const firstPage = await archivedList(app, { limit: 1 });
		expect(firstPage.agents.map((agent) => agent.agentId)).toEqual([newer.agentId]);
		expect(firstPage.nextBefore).toBe(firstPage.agents[0].archivedAt);
		const secondPage = await archivedList(app, { before: firstPage.nextBefore });
		expect(secondPage.agents.map((agent) => agent.agentId)).toEqual([older.agentId]);
		expect(secondPage.nextBefore).toBeNull();
		const filtered = await archivedList(app, { machineId: otherMachine.machineId });
		expect(filtered).toEqual({ agents: [], nextBefore: null });

		// Machine-scoped paging must fill a page from that machine alone and page through it.
		const otherArchived = await connectAgent(relay, otherMachine, "other-archived");
		await archiveAgent(otherArchived);
		const scopedFirst = await archivedList(app, { machineId: machine.machineId, limit: 1 });
		expect(scopedFirst.agents.map((agent) => agent.agentId)).toEqual([newer.agentId]);
		expect(scopedFirst.nextBefore).toBe(scopedFirst.agents[0].archivedAt);
		const scopedSecond = await archivedList(app, {
			machineId: machine.machineId,
			limit: 1,
			before: scopedFirst.nextBefore,
		});
		expect(scopedSecond.agents.map((agent) => agent.agentId)).toEqual([older.agentId]);
		// A full page always hands back an exclusive cursor; the follow-up page proves it terminates.
		expect(scopedSecond.nextBefore).toBe(scopedSecond.agents[0].archivedAt);
		const scopedEnd = await archivedList(app, {
			machineId: machine.machineId,
			limit: 1,
			before: scopedSecond.nextBefore,
		});
		expect(scopedEnd).toEqual({ agents: [], nextBefore: null });

		for (const agent of [active, older, newer, otherArchived]) agent.client.close();
		app.close();
	});

	it("lists archived agents over authenticated REST", async () => {
		const device = await pairDevice(relay);
		const machine = await pairMachine(relay, "devbox", { name: "REST archive machine" });
		const agent = await connectAgent(relay, machine, "rest-archived");
		await archiveAgent(agent);

		const unauthorized = await api(relay, "GET", "/v1/agents/archived");
		expect(unauthorized.status).toBe(401);
		const response = await api(relay, "GET", "/v1/agents/archived", device.deviceToken);
		expect(response.status).toBe(200);
		expect(response.json).toMatchObject({
			agents: [
				{
					agentId: agent.agentId,
					machineId: machine.machineId,
					machineName: "REST archive machine",
					archivedAt: expect.any(Number),
					lastSeenAt: expect.any(Number),
					lastMessagePreview: null,
					messageCount: 0,
				},
			],
			nextBefore: null,
		});
	});

	it("purges one archived agent's history while preserving its sibling", async () => {
		const device = await pairDevice(relay);
		const machine = await pairMachine(relay);
		const target = await connectAgent(relay, machine, "purge-target");
		const sibling = await connectAgent(relay, machine, "purge-sibling");
		const { client: app } = await connectApp(relay, device);
		await persistAssistantEvent(app, target, "target history");
		await persistAssistantEvent(app, sibling, "sibling history");

		const targetPrompt = "purge-target-prompt";
		const siblingPrompt = "purge-sibling-prompt";
		const targetComm = "purge-target-comm";
		const siblingComm = "purge-sibling-comm";
		addPrompt(target.agentId, targetPrompt);
		addPrompt(sibling.agentId, siblingPrompt);
		addComm(target.agentId, machine.machineId, targetComm);
		addComm(sibling.agentId, machine.machineId, siblingComm);
		await archiveAgent(target);
		await archiveAgent(sibling);

		const beforePurge = await archivedList(app, { machineId: machine.machineId });
		expect(beforePurge.agents.find((agent) => agent.agentId === target.agentId)?.messageCount).toBe(1);
		expect(relay.relay.ctx.repos.events.snapshot(target.agentId, target.hello.epoch)).toBeDefined();
		const purgeId = app.send("agent.purge", { agentId: target.agentId });
		const ack = await app.next((message) => message.t === "ack" && message.re === purgeId);
		expect(ack.re).toBe(purgeId);

		const repos = relay.relay.ctx.repos;
		expect(repos.agents.get(target.agentId)).toBeUndefined();
		expect(repos.events.count(target.agentId)).toBe(0);
		expect(repos.events.snapshot(target.agentId, target.hello.epoch)).toBeUndefined();
		expect(repos.prompts.get(targetPrompt)).toBeUndefined();
		expect(repos.comms.get(target.agentId, targetComm)).toBeUndefined();
		expect(repos.agents.get(sibling.agentId)).toBeDefined();
		expect(repos.events.count(sibling.agentId)).toBe(1);
		expect(repos.events.snapshot(sibling.agentId, sibling.hello.epoch)).toBeDefined();
		expect(repos.prompts.get(siblingPrompt)).toBeDefined();
		expect(repos.comms.get(sibling.agentId, siblingComm)).toBeDefined();

		app.close();
		sibling.client.close();
	});

	it("purges over REST and reports an unknown or already purged agent as 404", async () => {
		const device = await pairDevice(relay);
		const machine = await pairMachine(relay);
		const agent = await connectAgent(relay, machine, "rest-purge");
		await archiveAgent(agent);

		const deleted = await api(relay, "DELETE", `/v1/agents/${encodeURIComponent(agent.agentId)}`, device.deviceToken);
		expect(deleted.status).toBe(200);
		expect(deleted.json).toEqual({ ok: true });
		const deletedAgain = await api(
			relay,
			"DELETE",
			`/v1/agents/${encodeURIComponent(agent.agentId)}`,
			device.deviceToken,
		);
		expect(deletedAgain.status).toBe(404);
		const unknown = await api(relay, "DELETE", "/v1/agents/unknown-agent", device.deviceToken);
		expect(unknown.status).toBe(404);
	});

	it("refuses connected and never-archived agents without destroying stored data", async () => {
		const device = await pairDevice(relay);
		const machine = await pairMachine(relay);
		const connected = await connectAgent(relay, machine, "purge-connected");
		const offline = await connectAgent(relay, machine, "purge-unarchived-offline");
		const { client: app } = await connectApp(relay, device);
		await persistAssistantEvent(app, connected, "connected history");
		await persistAssistantEvent(app, offline, "offline history");
		const connectedPrompt = "purge-connected-prompt";
		const offlinePrompt = "purge-offline-prompt";
		addPrompt(connected.agentId, connectedPrompt);
		addPrompt(offline.agentId, offlinePrompt);
		const connectedRequest = app.send("agent.purge", { agentId: connected.agentId });
		const connectedError = await app.next((message) => message.t === "error" && message.re === connectedRequest);
		expect(connectedError.d).toMatchObject({
			code: "conflict",
			message: "no se puede purgar un agente conectado",
		});
		expect(relay.relay.ctx.repos.agents.get(connected.agentId)).toBeDefined();
		expect(relay.relay.ctx.repos.events.count(connected.agentId)).toBe(1);
		expect(relay.relay.ctx.repos.prompts.get(connectedPrompt)).toBeDefined();

		offline.client.close();
		await offline.client.waitClosed();
		const offlineRequest = app.send("agent.purge", { agentId: offline.agentId });
		const offlineError = await app.next((message) => message.t === "error" && message.re === offlineRequest);
		expect(offlineError.d).toMatchObject({
			code: "conflict",
			message: "solo se puede purgar un agente archivado",
		});
		expect(relay.relay.ctx.repos.agents.get(offline.agentId)).toBeDefined();
		expect(relay.relay.ctx.repos.events.count(offline.agentId)).toBe(1);
		expect(relay.relay.ctx.repos.prompts.get(offlinePrompt)).toBeDefined();

		app.close();
		connected.client.close();
	});
});
