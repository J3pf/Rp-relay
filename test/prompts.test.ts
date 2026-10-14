import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	api,
	Client,
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
	promptBody,
	sleep,
	startRelay,
	type TestRelay,
} from "./helpers.js";

let t: TestRelay;
// un relay nuevo por prueba: los temporizadores de gracia y los barridos son globales al relay
beforeEach(async () => {
	t = await startRelay();
});
afterEach(async () => {
	await t.stop();
	cleanup(t);
});

async function setup(session: string) {
	const dev = await pairDevice(t);
	const m = await pairMachine(t, "devbox", { name: "PC Empresa", context: "work" });
	const agent = await connectAgent(t, m, session);
	const { client: app } = await connectApp(t, dev);
	const { client: direct } = await connectApp(t, dev, "direct");
	return { dev, m, agent, app, direct };
}

describe("prompts: primera respuesta gana", () => {
	it("flujo completo: open → push directo → respuesta HTTP → ack → resolved + cancel", async () => {
		const { dev, agent, app, direct } = await setup("p1");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		const opened = await app.next("prompt.opened");
		expect(opened.d).toMatchObject({
			promptId: p.promptId,
			state: "open",
			machineName: "PC Empresa",
			machineContext: "work",
			agentLabel: "refactor auth",
			danger: "high",
		});
		const push = await direct.next("push.notify");
		expect(push.d).toMatchObject({
			k: "prompt",
			body: {
				promptId: p.promptId,
				machineContext: "work",
				kind: "confirm",
				options: [
					{ id: "0", label: "Permitir" },
					{ id: "1", label: "Denegar" },
				],
			},
		});
		direct.send("push.ack", { pushId: (push.d as any).pushId });

		const r = await api(t, "POST", `/v1/prompts/${p.promptId}/answer`, dev.deviceToken, {
			answer: { optionIds: ["0"] },
		});
		expect(r.status).toBe(200);
		expect(r.json).toEqual({ ok: true });
		const toAgent = await agent.client.next("prompt.answer");
		expect(toAgent.d).toMatchObject({ promptId: p.promptId, answer: { optionIds: ["0"] }, deviceId: dev.deviceId });
		// aún no resuelto hasta el ack del plugin
		await app.never("prompt.resolved", 100);
		agent.client.send("prompt.ack", { promptId: p.promptId, accepted: true }, { re: toAgent.id });
		const resolved = await app.next("prompt.resolved");
		expect(resolved.d).toMatchObject({
			promptId: p.promptId,
			by: "remote",
			answer: { optionIds: ["0"] },
			byDeviceId: dev.deviceId,
		});
		// el cancel de push NO va al dispositivo que respondió
		await direct.never((e) => e.t === "push.notify" && (e.d as any).k === "cancel");

		const row = t.relay.ctx.repos.prompts.get(p.promptId)!;
		expect(row.state).toBe("resolved");
		expect(row.resolved_by).toBe("remote");
		// segunda respuesta tardía → 409 already_resolved
		const late = await api(t, "POST", `/v1/prompts/${p.promptId}/answer`, dev.deviceToken, {
			answer: { optionIds: ["1"] },
		});
		expect(late.status).toBe(409);
		expect(late.json).toMatchObject({ ok: false, reason: "already_resolved" });
		for (const c of [agent.client, app, direct]) c.close();
	});

	it("carrera: dos respuestas simultáneas desde dos dispositivos → exactamente una gana", async () => {
		const { dev, agent, app, direct } = await setup("p2");
		const dev2 = await pairDevice(t, "Tablet");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		const results = await Promise.all([
			api(t, "POST", `/v1/prompts/${p.promptId}/answer`, dev.deviceToken, { answer: { optionIds: ["0"] } }),
			api(t, "POST", `/v1/prompts/${p.promptId}/answer`, dev2.deviceToken, { answer: { optionIds: ["1"] } }),
			api(t, "POST", `/v1/prompts/${p.promptId}/answer`, dev.deviceToken, { answer: { optionIds: ["1"] } }),
		]);
		const codes = results.map((r) => r.status).sort();
		expect(codes).toEqual([200, 409, 409]);
		await agent.client.next("prompt.answer");
		await sleep(100);
		expect(agent.client.count("prompt.answer")).toBe(1);
		for (const c of [agent.client, app, direct]) c.close();
	});

	it("carrera por WS: dos apps responden a la vez", async () => {
		const { dev, agent, app, direct } = await setup("p2b");
		const dev2 = await pairDevice(t, "Tablet");
		const { client: app2 } = await connectApp(t, dev2);
		const p = promptBody(agent.agentId, {
			kind: "select",
			options: [
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			],
		});
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		const id1 = app.send("prompt.answer", { promptId: p.promptId, answer: { optionIds: ["a"] } });
		const id2 = app2.send("prompt.answer", { promptId: p.promptId, answer: { optionIds: ["b"] } });
		const r1 = await app.next("prompt.answer.result");
		const r2 = await app2.next("prompt.answer.result");
		expect(r1.re).toBe(id1);
		expect(r2.re).toBe(id2);
		expect([r1, r2].filter((r) => (r.d as any).ok).length).toBe(1);
		expect([r1, r2].find((r) => !(r.d as any).ok)!.d).toMatchObject({ reason: "already_resolved" });
		void dev;
		for (const c of [agent.client, app, app2, direct]) c.close();
	});

	it("resuelto en la terminal: prompt.resolved(local) retira el prompt y manda cancel a todos", async () => {
		const { agent, app, direct } = await setup("p3");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		await direct.next((e) => e.t === "push.notify" && (e.d as any).k === "prompt");
		agent.client.send("prompt.resolved", { promptId: p.promptId, by: "local", answer: { optionIds: ["0"] } });
		const r = await app.next("prompt.resolved");
		expect(r.d).toMatchObject({ promptId: p.promptId, by: "local" });
		const cancel = await direct.next((e) => e.t === "push.notify" && (e.d as any).k === "cancel");
		expect((cancel.d as any).body).toMatchObject({ promptId: p.promptId });
		// responder después → 409
		const dev = await pairDevice(t);
		const late = await api(t, "POST", `/v1/prompts/${p.promptId}/answer`, dev.deviceToken, {
			answer: { confirmed: true },
		});
		expect(late.status).toBe(409);
		for (const c of [agent.client, app, direct]) c.close();
	});

	it("prompt.ack accepted=false (la terminal ganó en paralelo): se resuelve como local y la app recibe already_resolved", async () => {
		const { agent, app, direct } = await setup("p4");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		const rid = app.send("prompt.answer", { promptId: p.promptId, answer: { confirmed: true } });
		expect((await app.next("prompt.answer.result")).d).toMatchObject({ ok: true });
		await agent.client.next("prompt.answer");
		agent.client.send("prompt.ack", { promptId: p.promptId, accepted: false });
		const late = await app.next((e) => e.t === "prompt.answer.result" && e.re === rid);
		expect(late.d).toMatchObject({ ok: false, reason: "already_resolved" });
		expect((await app.next("prompt.resolved")).d).toMatchObject({ by: "local" });
		for (const c of [agent.client, app, direct]) c.close();
	});

	it("agente offline: la respuesta queda 'answered' y se entrega en agent.welcome.pendingAnswers", async () => {
		const { dev, m, agent, app, direct } = await setup("p5");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		agent.client.close();
		await sleep(60);
		const id = app.send("prompt.answer", { promptId: p.promptId, answer: { optionIds: ["0"] } });
		const res = await app.next("prompt.answer.result");
		expect(res.re).toBe(id);
		expect(res.d).toMatchObject({ ok: true, reason: "agent_offline_queued" });
		expect(t.relay.ctx.repos.prompts.get(p.promptId)!.state).toBe("answered");

		const back = await connectAgent(t, m, "p5", { openPrompts: [p] });
		expect((back.welcome.d as any).pendingAnswers).toEqual([
			{ promptId: p.promptId, answer: { optionIds: ["0"] }, deviceId: dev.deviceId },
		]);
		back.client.send("prompt.ack", { promptId: p.promptId, accepted: true });
		expect((await app.next("prompt.resolved")).d).toMatchObject({ by: "remote" });
		for (const c of [back.client, app, direct]) c.close();
	});

	it("desconexión con prompt abierto: se conserva durante la gracia y se cancela después", async () => {
		const { m, agent, app, direct } = await setup("p6");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		agent.client.close();
		await sleep(80);
		expect(t.relay.ctx.repos.prompts.get(p.promptId)!.state).toBe("open");
		const r = await app.next("prompt.resolved", 3000);
		expect(r.d).toMatchObject({ promptId: p.promptId, by: "cancelled" });
		expect(t.relay.ctx.repos.prompts.get(p.promptId)!.state).toBe("cancelled");
		await direct.next((e) => e.t === "push.notify" && (e.d as any).k === "cancel");
		// si el plugin reconecta con el diálogo aún abierto, el relay lo reabre
		const back = await connectAgent(t, m, "p6", { openPrompts: [p] });
		const re = await app.next("prompt.opened");
		expect((re.d as any).promptId).toBe(p.promptId);
		expect(t.relay.ctx.repos.prompts.get(p.promptId)!.state).toBe("open");
		for (const c of [back.client, app, direct]) c.close();
	});

	it("reconexión dentro de la gracia: el prompt sigue abierto y no se duplica", async () => {
		const { m, agent, app, direct } = await setup("p7");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		agent.client.close();
		const back = await connectAgent(t, m, "p7", { openPrompts: [p] });
		await sleep(500);
		expect(t.relay.ctx.repos.prompts.get(p.promptId)!.state).toBe("open");
		expect(app.count("prompt.opened")).toBe(1);
		expect(app.count("prompt.resolved")).toBe(0);
		for (const c of [back.client, app, direct]) c.close();
	});

	it("hello sin el prompt que el relay tenía abierto → resuelto localmente mientras no había conexión", async () => {
		const { m, agent, app, direct } = await setup("p8");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		agent.client.close();
		await sleep(30);
		const back = await connectAgent(t, m, "p8", { openPrompts: [] });
		const r = await app.next("prompt.resolved");
		expect(r.d).toMatchObject({ promptId: p.promptId, by: "local" });
		for (const c of [back.client, app, direct]) c.close();
	});

	it("expiración por expiresAt: no permite responder antes del sweep y el sweep manda prompt.cancel al plugin", async () => {
		const { dev, agent, app, direct } = await setup("p9");
		const p = promptBody(agent.agentId, { expiresAt: Date.now() + 50 });
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		await sleep(120);
		// antes de que corra sweep(), un intento de responder a un prompt ya caducado es rechazado
		const lateBeforeSweep = await api(t, "POST", `/v1/prompts/${p.promptId}/answer`, dev.deviceToken, {
			answer: { optionIds: ["0"] },
		});
		expect(lateBeforeSweep.status).toBe(409);
		expect(lateBeforeSweep.json).toMatchObject({ ok: false, reason: "already_resolved" });
		t.relay.ctx.prompts.sweep();
		expect((await agent.client.next("prompt.cancel")).d).toMatchObject({ promptId: p.promptId });
		expect((await app.next("prompt.resolved")).d).toMatchObject({ by: "timeout" });
		expect(t.relay.ctx.repos.prompts.get(p.promptId)!.state).toBe("expired");
		for (const c of [agent.client, app, direct]) c.close();
	});

	it("re-push de autorizaciones críticas a los 5 y 10 minutos (máx. 3 envíos)", async () => {
		const { agent, app, direct } = await setup("p10");
		const p = promptBody(agent.agentId, { danger: "high" });
		agent.client.send("prompt.open", p);
		await direct.next((e) => e.t === "push.notify" && (e.d as any).k === "prompt");
		const ctx = t.relay.ctx;
		const created = ctx.repos.prompts.get(p.promptId)!.created_at;
		expect(ctx.prompts.sweep(created + 4 * 60_000).repushed).toBe(0);
		expect(ctx.prompts.sweep(created + 5 * 60_000 + 1).repushed).toBe(1);
		expect(ctx.prompts.sweep(created + 6 * 60_000).repushed).toBe(0);
		expect(ctx.prompts.sweep(created + 10 * 60_000 + 1).repushed).toBe(1);
		expect(ctx.prompts.sweep(created + 30 * 60_000).repushed).toBe(0); // tope de 3
		await sleep(50);
		expect(direct.msgs.filter((e) => e.t === "push.notify" && (e.d as any).k === "prompt")).toHaveLength(3);
		for (const c of [agent.client, app, direct]) c.close();
	});

	it("prompts de baja prioridad no se re-notifican", async () => {
		const { agent, app, direct } = await setup("p11");
		const p = promptBody(agent.agentId, { danger: "low", category: "question" });
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		expect(t.relay.ctx.prompts.sweep(Date.now() + 60 * 60_000).repushed).toBe(0);
		for (const c of [agent.client, app, direct]) c.close();
	});

	it("GET /v1/prompts lista las abiertas; app.welcome las incluye", async () => {
		const { dev, agent, app, direct } = await setup("p12");
		const p = promptBody(agent.agentId, {
			kind: "questionnaire",
			category: "question",
			questions: [{ question: "¿DB?", options: [{ id: "0", label: "SQLite" }] }],
			options: undefined,
		});
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		const list = await api(t, "GET", "/v1/prompts?state=open", dev.deviceToken);
		expect(list.json.prompts.some((x: any) => x.promptId === p.promptId && x.kind === "questionnaire")).toBe(true);
		expect((await api(t, "GET", "/v1/prompts?state=zzz", dev.deviceToken)).status).toBe(400);
		const { welcome } = await connectApp(t, dev);
		expect((welcome.d as any).openPrompts.some((x: any) => x.promptId === p.promptId)).toBe(true);
		// el cuestionario no lleva botones en el push
		const push = await direct.next((e) => e.t === "push.notify" && (e.d as any).k === "prompt");
		expect((push.d as any).body.options).toEqual([]);
		for (const c of [agent.client, app, direct]) c.close();
	});

	it("respuesta a prompt inexistente → 404; cuerpo inválido → 400", async () => {
		const dev = await pairDevice(t);
		expect(
			(await api(t, "POST", "/v1/prompts/NOPE/answer", dev.deviceToken, { answer: { confirmed: true } })).status,
		).toBe(404);
		expect((await api(t, "POST", "/v1/prompts/NOPE/answer", dev.deviceToken, { answer: { raro: 1 } })).status).toBe(
			400,
		);
		const c = await Client.connect(`${t.ws}/ws/app`, dev.deviceToken);
		c.send("app.hello", { deviceId: dev.deviceId, app: { version: "1" } });
		await c.next("app.welcome");
		c.send("prompt.answer", { promptId: "NOPE", answer: { confirmed: true } });
		expect((await c.next("prompt.answer.result")).d).toMatchObject({ ok: false, reason: "not_found" });
		c.close();
	});
});
