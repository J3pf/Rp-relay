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

async function openPrompt(app: Awaited<ReturnType<typeof connectApp>>["client"], agent: AgentClient, id: string) {
	agent.client.send("prompt.open", promptBody(agent.agentId, { promptId: id }));
	return app.next((m) => m.t === "prompt.opened" && (m.d as any).promptId === id);
}

describe("prompt lifecycle around archived agents", () => {
	it("does not surface a prompt from an archived agent whose socket is still open", async () => {
		const machine = await pairMachine(relay);
		const device = await pairDevice(relay);
		const agent = await connectAgent(relay, machine, "archived-leak");
		const { client: app } = await connectApp(relay, device);
		await openPrompt(app, agent, "leak-before");

		agent.client.send("agent.closed", { reason: "pane_closed" });
		await app.next((m) => m.t === "agents.update" && (m.d as any).remove?.includes(agent.agentId));

		agent.client.send("prompt.open", promptBody(agent.agentId, { promptId: "leak-after" }));
		await app.never((m) => m.t === "prompt.opened" && (m.d as any).promptId === "leak-after", 400);
		expect(relay.relay.ctx.repos.prompts.get("leak-after")).toBeUndefined();
		app.close();
	});

	it("keeps forget idempotent instead of claiming an archived agent is connected", async () => {
		const machine = await pairMachine(relay);
		const device = await pairDevice(relay);
		const agent = await connectAgent(relay, machine, "forget-twice");
		const { client: app } = await connectApp(relay, device);
		agent.client.close();
		await agent.client.waitClosed();

		const first = app.send("agent.forget", { agentId: agent.agentId });
		expect((await app.next((m) => m.t === "ack" && m.re === first)).re).toBe(first);
		const second = app.send("agent.forget", { agentId: agent.agentId });
		const secondReply = await app.next((m) => (m.t === "ack" || m.t === "error") && m.re === second);
		expect(secondReply.t).toBe("ack");
		expect(relay.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).toEqual(expect.any(Number));
		app.close();
	});
});

describe("queued prompt answers", () => {
	it("retires the pending notification on other devices when the answer is queued", async () => {
		const machine = await pairMachine(relay);
		const answering = await pairDevice(relay, "Pixel");
		const other = await pairDevice(relay, "Tablet");
		relay.relay.ctx.repos.devices.setPush(other.deviceId, "other-fcm-token", true);
		const agent = await connectAgent(relay, machine, "queued-answer");
		const { client: otherApp } = await connectApp(relay, other, "direct");
		await openPrompt(otherApp, agent, "queued-prompt");
		await otherApp.next((m) => m.t === "push.notify" && (m.d as any).k === "prompt");

		// The agent goes away before anyone answers, so the answer has to be queued.
		agent.client.close();
		await agent.client.waitClosed();
		const result = await api(relay, "POST", "/v1/prompts/queued-prompt/answer", answering.deviceToken, {
			answer: { optionIds: ["0"] },
		});
		expect(result.status).toBe(200);
		expect(result.json).toMatchObject({ ok: true, reason: "agent_offline_queued" });

		await otherApp.next((m) => m.t === "push.notify" && (m.d as any).k === "cancel", 1000);
		expect(relay.relay.ctx.repos.prompts.get("queued-prompt")?.state).toBe("answered");
		const pending = relay.relay.ctx.repos.outbox.pendingFor(other.deviceId, Date.now());
		expect(pending.some((row) => row.kind === "prompt")).toBe(false);
		expect(pending.some((row) => row.kind === "cancel" && row.ref_id === "queued-prompt")).toBe(true);

		// A fresh app connection still sees the queued answer so the UI can show it as answered.
		const laterApp = await connectApp(relay, other);
		expect((laterApp.welcome.d as any).openPrompts.some((p: any) => p.promptId === "queued-prompt")).toBe(true);
		laterApp.client.close();
		otherApp.close();
	});
});
