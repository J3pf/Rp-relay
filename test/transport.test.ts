import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	api,
	cleanup,
	connectApp,
	helloBody,
	pairDevice,
	pairMachine,
	promptBody,
	sleep,
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

const send = (m: { machineToken: string }, messages: unknown[]) =>
	api(t, "POST", "/v1/agent/send", m.machineToken, messages);
const env = (tt: string, d: unknown, extra: object = {}) => ({ v: 1, t: tt, ts: Date.now(), d, ...extra });
const poll = (m: { machineToken: string }, agentId: string, instance?: string, timeout = 2000) =>
	api(
		t,
		"GET",
		`/v1/agent/poll?agentId=${encodeURIComponent(agentId)}${instance ? `&instance=${instance}` : ""}&timeout=${timeout}`,
		m.machineToken,
	);

describe("transporte long-poll (plugin tras proxy corporativo)", () => {
	it("hello por send, welcome y mensajes por poll; el agente aparece con transport longpoll y recibe mensajes", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const { client: app } = await connectApp(t, dev);
		const hello = helloBody(m.machineId, "lp1", { transport: "longpoll" });
		const r = await send(m, [env("agent.hello", hello, { id: "H1" })]);
		expect(r.json).toMatchObject({ ok: true, accepted: 1, rejected: 0 });
		const w = await poll(m, hello.agentId, hello.instance, 500);
		expect(w.status).toBe(200);
		expect(w.json.messages[0]).toMatchObject({ t: "agent.welcome", re: "H1" });
		await app.next(
			(e) =>
				e.t === "agents.update" && (e.d as any).upsert[0]?.agentId === hello.agentId && (e.d as any).upsert[0].online,
		);

		// eventos y prompts por send
		await send(m, [
			env("agent.snapshot", { epoch: hello.epoch, seq: 0, entries: [] }),
			env("agent.event", {
				epoch: hello.epoch,
				seq: 1,
				e: { type: "message_end", message: { role: "assistant", content: "hola desde long-poll" } },
			}),
		]);
		await app.next(
			(e) => e.t === "agents.update" && (e.d as any).upsert[0]?.lastMessagePreview === "hola desde long-poll",
		);

		// mensaje de la app → el poll pendiente lo recibe
		const pending = poll(m, hello.agentId, hello.instance, 5000);
		await sleep(50);
		app.send("user.message", { agentId: hello.agentId, clientMsgId: "L1", text: "ping" });
		const got = (await pending).json.messages;
		expect(got[0]).toMatchObject({ t: "user.message", d: { clientMsgId: "L1", text: "ping" } });
		await send(m, [env("user.message.ack", { clientMsgId: "L1", disposition: "sent", method: "api" })]);
		expect((await app.next("user.message.ack")).d).toMatchObject({ disposition: "sent" });

		// prompt y respuesta
		const p = promptBody(hello.agentId);
		await send(m, [env("prompt.open", p)]);
		await app.next("prompt.opened");
		await api(t, "POST", `/v1/prompts/${p.promptId}/answer`, dev.deviceToken, { answer: { optionIds: ["0"] } });
		const ans = (await poll(m, hello.agentId, hello.instance, 2000)).json.messages;
		expect(ans[0]).toMatchObject({ t: "prompt.answer", d: { promptId: p.promptId } });
		await send(m, [env("prompt.ack", { promptId: p.promptId, accepted: true })]);
		expect((await app.next("prompt.resolved")).d).toMatchObject({ by: "remote" });
		app.close();
	});

	it("poll sin mensajes devuelve lista vacía al agotar el tiempo; sin sesión → 404", async () => {
		const m = await pairMachine(t);
		const hello = helloBody(m.machineId, "lp2");
		expect((await poll(m, hello.agentId)).status).toBe(404);
		await send(m, [env("agent.hello", hello)]);
		await poll(m, hello.agentId, hello.instance, 100); // welcome
		const t0 = Date.now();
		const r = await poll(m, hello.agentId, hello.instance, 300);
		expect(r.json.messages).toEqual([]);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
	});

	it("mensajes inválidos se rechazan y los errores salen por poll", async () => {
		const m = await pairMachine(t);
		const hello = helloBody(m.machineId, "lp3");
		await send(m, [env("agent.hello", hello)]);
		await poll(m, hello.agentId, hello.instance, 100);
		const r = await send(m, [env("agent.status", { status: "dormido" }, { id: "X1" })]);
		expect(r.json.accepted).toBe(1); // aceptado para procesar…
		const e = (await poll(m, hello.agentId, hello.instance, 500)).json.messages[0];
		expect(e).toMatchObject({ t: "error", re: "X1", d: { code: "bad_request" } }); // …pero el error vuelve por poll
		expect((await send(m, [{ nada: true }])).json.rejected).toBe(1);
	});

	it("una sesión nueva (otra instancia) reemplaza a la anterior: la antigua recibe 410", async () => {
		const m = await pairMachine(t);
		const hello = helloBody(m.machineId, "lp4");
		await send(m, [env("agent.hello", hello)]);
		await poll(m, hello.agentId, hello.instance, 100);
		const old = poll(m, hello.agentId, hello.instance, 3000);
		await sleep(50);
		await send(m, [env("agent.hello", { ...hello, instance: "NUEVA" })]);
		const r = await old;
		expect(r.status).toBe(410);
		expect(r.json.closeCode).toBe(4003);
		// el mismo agente en la sesión vigente sigue online
		const dev = await pairDevice(t);
		expect(
			(await api(t, "GET", "/v1/agents", dev.deviceToken)).json.agents.find((a: any) => a.agentId === hello.agentId)
				.online,
		).toBe(true);
	});

	it("sesión inactiva > tiempo de inactividad pasa a offline", async () => {
		await t.stop();
		cleanup(t);
		t = await startRelay();
		const lp = (t.relay as any).longPoll as { idleMs: number; sweep(): void };
		lp.idleMs = 50;
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const hello = helloBody(m.machineId, "lp5");
		await send(m, [env("agent.hello", hello)]);
		await sleep(120);
		lp.sweep();
		const list = await api(t, "GET", "/v1/agents", dev.deviceToken);
		expect(list.json.agents.find((a: any) => a.agentId === hello.agentId).online).toBe(false);
	});

	it("poll también por POST con el cuerpo JSON (PROTOCOLO §7)", async () => {
		const m = await pairMachine(t);
		const hello = helloBody(m.machineId, "lp6");
		await send(m, [env("agent.hello", hello)]);
		const r = await api(t, "POST", "/v1/agent/poll", m.machineToken, {
			agentId: hello.agentId,
			instance: hello.instance,
			timeout: 500,
		});
		expect(r.status).toBe(200);
		expect(r.json.messages[0].t).toBe("agent.welcome");
		const wrong = await api(t, "POST", "/v1/agent/poll", m.machineToken, {
			agentId: hello.agentId,
			instance: "OTRA",
			timeout: 100,
		});
		expect(wrong.status).toBe(410);
		const other = await pairMachine(t);
		expect(
			(await api(t, "POST", "/v1/agent/poll", other.machineToken, { agentId: hello.agentId, timeout: 100 })).status,
		).toBe(404); // otra PC no puede leer la cola
	});

	it("token de dispositivo en /v1/agent/* → 401", async () => {
		const dev = await pairDevice(t);
		expect((await api(t, "POST", "/v1/agent/send", dev.deviceToken, [])).status).toBe(401);
	});

	it("hello inválido cuenta como rechazado y múltiples agentes en la misma PC se enrutan por agentId", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const other = await pairMachine(t);
		// hello con agentId de otra PC falla y no deja sesión activa ni acepta mensajes posteriores del lote
		const badBatch = await send(m, [
			env("agent.hello", helloBody(other.machineId, "bad")),
			env("agent.status", { status: "working" }),
		]);
		expect(badBatch.json).toEqual({ ok: true, accepted: 0, rejected: 2 });

		// dos agentes long-poll en la misma PC
		const h1 = helloBody(m.machineId, "lp-m1", { transport: "longpoll" });
		const h2 = helloBody(m.machineId, "lp-m2", { transport: "longpoll" });
		await send(m, [env("agent.hello", h1), env("agent.hello", h2)]);
		const r = await send(m, [
			env("agent.status", { status: "working" }, { agentId: h1.agentId }),
			env("agent.status", { status: "error", detail: "boom", agentId: h2.agentId }),
		]);
		expect(r.json).toEqual({ ok: true, accepted: 2, rejected: 0 });
		const list = (await api(t, "GET", "/v1/agents", dev.deviceToken)).json.agents as any[];
		expect(list.find((a) => a.agentId === h1.agentId)?.status).toBe("working");
		expect(list.find((a) => a.agentId === h2.agentId)?.status).toBe("error");
	});
});
