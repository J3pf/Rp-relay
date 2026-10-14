import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	api,
	Client,
	cleanup,
	connectAgent,
	connectApp,
	helloBody,
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

describe("autenticación WS", () => {
	it("token inválido → cierre 4001", async () => {
		const c = await Client.connect(`${t.ws}/ws/agent`, "rpm_falso");
		expect((await c.waitClosed()).code).toBe(4001);
		const a = await Client.connect(`${t.ws}/ws/app`, "rpd_falso");
		expect((await a.waitClosed()).code).toBe(4001);
	});

	it("sin cabecera Authorization → 4001", async () => {
		const c = await Client.connect(`${t.ws}/ws/agent`, null);
		expect((await c.waitClosed()).code).toBe(4001);
	});

	it("un token de dispositivo no sirve en /ws/agent", async () => {
		const d = await pairDevice(t);
		const c = await Client.connect(`${t.ws}/ws/agent`, d.deviceToken);
		expect((await c.waitClosed()).code).toBe(4001);
	});

	it("ruta WS desconocida → 404", async () => {
		await expect(Client.connect(`${t.ws}/ws/otra`, "x")).rejects.toThrow(/404|socket hang up|Unexpected/);
	});

	it("primer mensaje distinto de hello → error y 4008", async () => {
		const m = await pairMachine(t);
		const c = await Client.connect(`${t.ws}/ws/agent`, m.machineToken);
		c.send("agent.status", { status: "idle" });
		expect((await c.next("error")).d).toMatchObject({ code: "bad_request" });
		expect((await c.waitClosed()).code).toBe(4008);
	});

	it("hello inválido → error y 4008; JSON roto → 4008; versión futura → 4002", async () => {
		const m = await pairMachine(t);
		const c1 = await Client.connect(`${t.ws}/ws/agent`, m.machineToken);
		c1.send("agent.hello", { agentId: "x" });
		expect((await c1.next("error")).d).toMatchObject({ code: "bad_request" });
		expect((await c1.waitClosed()).code).toBe(4008);

		const c2 = await Client.connect(`${t.ws}/ws/agent`, m.machineToken);
		c2.raw("{esto no es json");
		expect((await c2.waitClosed()).code).toBe(4008);

		const c3 = await Client.connect(`${t.ws}/ws/agent`, m.machineToken);
		c3.raw(JSON.stringify({ v: 99, t: "agent.hello", d: {} }));
		expect((await c3.waitClosed()).code).toBe(4002);
	});

	it("agentId de otra PC → rechazado", async () => {
		const m = await pairMachine(t);
		const other = await pairMachine(t);
		const c = await Client.connect(`${t.ws}/ws/agent`, m.machineToken);
		c.send("agent.hello", helloBody(other.machineId));
		expect((await c.next("error")).d).toMatchObject({ code: "unauthorized" });
		expect((await c.waitClosed()).code).toBe(4008);
	});

	it("sin hello a tiempo se cierra con 4008", async () => {
		const t2 = await startRelay({ limits: { helloTimeoutMs: 150 } });
		try {
			const m = await pairMachine(t2);
			const c = await Client.connect(`${t2.ws}/ws/agent`, m.machineToken);
			expect((await c.waitClosed()).code).toBe(4008);
			const d = await pairDevice(t2);
			const a = await Client.connect(`${t2.ws}/ws/app`, d.deviceToken);
			expect((await a.waitClosed()).code).toBe(4008);
		} finally {
			await t2.stop();
			cleanup(t2);
		}
	});
});

describe("agentes, apps y eventos", () => {
	it("hello → welcome; la app ve el agente en vivo, con PC y contadores", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t, "devbox", { name: "Portátil personal", context: "personal" });
		const { client: app, welcome } = await connectApp(t, dev);
		expect((welcome.d as any).relayName).toBe("Test");
		expect((welcome.d as any).machines.find((x: any) => x.machineId === m.machineId)).toMatchObject({
			name: "Portátil personal",
			context: "personal",
			online: false,
			agentCount: 0,
		});

		const agent = await connectAgent(t, m);
		expect(agent.welcome.d).toMatchObject({ lastSeq: null, pendingAnswers: [] });
		const upd = await app.next(
			(e) =>
				e.t === "agents.update" &&
				(e.d as any).upsert[0]?.agentId === agent.agentId &&
				(e.d as any).upsert[0].online === true,
		);
		expect((upd.d as any).upsert[0]).toMatchObject({
			machineId: m.machineId,
			machineName: "Portátil personal",
			machineContext: "personal",
			sessionName: "refactor auth",
			cwd: "/home/u/api",
			gitBranch: "main",
			model: "anthropic/claude",
			status: "idle",
			launcher: "pi",
			spawnedByHost: false,
		});
		const mu = await app.next(
			(e) =>
				e.t === "machines.update" && (e.d as any).upsert[0]?.machineId === m.machineId && (e.d as any).upsert[0].online,
		);
		expect((mu.d as any).upsert[0].agentCount).toBe(1);

		// la lista HTTP coincide
		const list = await api(t, "GET", "/v1/agents", dev.deviceToken);
		expect(list.json.agents.find((a: any) => a.agentId === agent.agentId).online).toBe(true);
		agent.client.close();
		await app.next(
			(e) =>
				e.t === "agents.update" &&
				(e.d as any).upsert[0]?.agentId === agent.agentId &&
				(e.d as any).upsert[0].online === false,
		);
		app.close();
	});

	it("suscripción: historial desde snapshot + eventos persistidos y streaming en vivo (deltas no persistidos)", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-hist");
		agent.client.send("agent.snapshot", {
			epoch: agent.hello.epoch,
			seq: 0,
			entries: [{ eid: "e1", kind: "user", at: 1, msg: { role: "user", content: "hola" } }],
		});
		agent.event({ type: "agent_start" });
		agent.event({ type: "message_start" });
		agent.event({ type: "message_delta", contentIndex: 0, kind: "text", delta: "ho" });
		agent.event({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Listo, ya está." }] },
		});
		agent.event({ type: "tool_execution_update", partialResult: "x" });
		await sleep(80);

		const { client: app } = await connectApp(t, dev);
		const subId = app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: null, epoch: null });
		const hist = await app.next((e) => e.t === "agent.history");
		expect(hist.re).toBe(subId);
		const h = hist.d as any;
		expect(h.entries).toHaveLength(1);
		expect(h.events.map((e: any) => e.e.type)).toEqual(["agent_start", "message_end"]); // sólo persistidos
		expect(h.epoch).toBe(agent.hello.epoch);
		expect(h.liveFromSeq).toBe(5);

		// en vivo: incluye deltas
		agent.event({ type: "message_delta", contentIndex: 0, kind: "text", delta: "x" });
		const live = await app.next("agent.event");
		expect(live.d as any).toMatchObject({ agentId: agent.agentId, seq: 6, e: { type: "message_delta" } });

		// reanudación con sinceSeq y epoch: solo lo nuevo
		agent.event({ type: "message_end", message: { role: "assistant", content: "segundo" } });
		await app.next((e) => e.t === "agent.event" && (e.d as any).seq === 7);
		const { client: app2 } = await connectApp(t, dev);
		app2.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: 4, epoch: agent.hello.epoch });
		const h2 = (await app2.next("agent.history")).d as any;
		expect(h2.entries).toHaveLength(0);
		expect(h2.events.map((e: any) => e.seq)).toEqual([7]);

		// epoch distinto → vuelve a mandar el snapshot
		app2.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: 4, epoch: "OTRO" });
		const h3 = (await app2.next("agent.history")).d as any;
		expect(h3.entries).toHaveLength(1);

		// vista previa del último mensaje
		const list = await api(t, "GET", "/v1/agents", dev.deviceToken);
		expect(list.json.agents.find((a: any) => a.agentId === agent.agentId).lastMessagePreview).toBe("segundo");

		// unsubscribe: ya no llegan eventos
		app2.send("agent.unsubscribe", { agentId: agent.agentId });
		await app2.next("ack");
		agent.event({ type: "message_delta", contentIndex: 0, kind: "text", delta: "y" });
		await app2.never("agent.event");
		agent.client.close();
		app.close();
		app2.close();
	});

	it("reenvío de eventos con seq repetido se descarta (al menos una vez → sin duplicados)", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-dup");
		const { client: app } = await connectApp(t, dev);
		app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: null, epoch: null });
		await app.next("agent.history");
		agent.event({ type: "message_end", message: { role: "assistant", content: "uno" } });
		await app.next("agent.event");
		agent.client.send("agent.event", {
			epoch: agent.hello.epoch,
			seq: 1,
			e: { type: "message_end", message: { role: "assistant", content: "uno" } },
		});
		await app.never("agent.event");
		const n = t.relay.db.prepare("SELECT COUNT(*) AS n FROM events WHERE agent_id=?").get(agent.agentId) as {
			n: number;
		};
		expect(n.n).toBe(1);
		agent.client.close();
		app.close();
	});

	it("reconexión del mismo agente: lastSeq en welcome y la anterior conexión se cierra con 4003", async () => {
		const m = await pairMachine(t);
		const a1 = await connectAgent(t, m, "s-re");
		a1.event({ type: "message_end", message: { role: "assistant", content: "x" } });
		await sleep(50);
		// mismo epoch, nueva instancia
		const c2 = await Client.connect(`${t.ws}/ws/agent`, m.machineToken);
		c2.send("agent.hello", { ...a1.hello, instance: "NUEVA-INSTANCIA" });
		const w = await c2.next("agent.welcome");
		expect((w.d as any).lastSeq).toBe(1);
		expect((await a1.client.waitClosed()).code).toBe(4003);
		// la desconexión de la conexión reemplazada no deja al agente offline
		const dev = await pairDevice(t);
		const list = await api(t, "GET", "/v1/agents", dev.deviceToken);
		expect(list.json.agents.find((a: any) => a.agentId === a1.agentId).online).toBe(true);
		// epoch nuevo → lastSeq null
		const c3 = await Client.connect(`${t.ws}/ws/agent`, m.machineToken);
		c3.send("agent.hello", { ...a1.hello, instance: "I3", epoch: "EPOCH-NUEVO" });
		expect(((await c3.next("agent.welcome")).d as any).lastSeq).toBeNull();
		c2.close();
		c3.close();
	});

	it("status, statuses (modo de gentle) y metadatos derivados de eventos", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-st", { gentle: { version: "4.1.0", mode: "normal" } });
		const { client: app } = await connectApp(t, dev);
		agent.client.send("agent.status", { status: "working", detail: "bash: npm test" });
		const u1 = await app.next((e) => e.t === "agents.update" && (e.d as any).upsert[0]?.status === "working");
		expect((u1.d as any).upsert[0].agentId).toBe(agent.agentId);
		agent.client.send("agent.statuses", { items: { "gentle:mode": "Permissions: AUTO" } });
		const u2 = await app.next((e) => e.t === "agents.update" && (e.d as any).upsert[0]?.gentleMode === "auto");
		expect(u2).toBeTruthy();
		agent.event({ type: "session_info_changed", name: "nuevo nombre" });
		agent.event({ type: "model_select", model: { provider: "openai", id: "gpt" } });
		await app.next((e) => e.t === "agents.update" && (e.d as any).upsert[0]?.sessionName === "nuevo nombre");
		await app.next((e) => e.t === "agents.update" && (e.d as any).upsert[0]?.model === "openai/gpt");
		agent.client.close();
		app.close();
	});

	it("suscribirse a un agente inexistente → not_found; el canal directo no admite suscripciones", async () => {
		const dev = await pairDevice(t);
		const { client: app } = await connectApp(t, dev);
		const id = app.send("agent.subscribe", { agentId: "no:existe", sinceSeq: null, epoch: null });
		const e = await app.next("error");
		expect(e.re).toBe(id);
		expect(e.d).toMatchObject({ code: "not_found" });
		const { client: direct } = await connectApp(t, dev, "direct");
		direct.send("agent.subscribe", { agentId: "no:existe", sinceSeq: null, epoch: null });
		expect((await direct.next("error")).d).toMatchObject({ code: "bad_request" });
		app.close();
		direct.close();
	});

	it("app.hello con deviceId ajeno → 4001", async () => {
		const dev = await pairDevice(t);
		const c = await Client.connect(`${t.ws}/ws/app`, dev.deviceToken);
		c.send("app.hello", { deviceId: "OTRO", app: { version: "1" } });
		expect((await c.next("error")).d).toMatchObject({ code: "unauthorized" });
		expect((await c.waitClosed()).code).toBe(4001);
	});

	it("agent.forget sólo para agentes offline", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-forget");
		const { client: app } = await connectApp(t, dev);
		app.send("agent.forget", { agentId: agent.agentId });
		expect((await app.next("error")).d).toMatchObject({ code: "conflict" });
		agent.client.close();
		await app.next((e) => e.t === "agents.update" && (e.d as any).upsert[0]?.online === false);
		const id = app.send("agent.forget", { agentId: agent.agentId });
		expect((await app.next("ack")).re).toBe(id);
		const rm = await app.next((e) => e.t === "agents.update" && (e.d as any).remove?.includes(agent.agentId));
		expect(rm).toBeTruthy();
		expect(t.relay.ctx.repos.agents.get(agent.agentId)).toBeUndefined();
		app.close();
	});
});

describe("mensajes de usuario", () => {
	it("app → relay → plugin → ack → app, con idempotencia por clientMsgId", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-msg");
		const { client: app } = await connectApp(t, dev);
		const id = app.send("user.message", {
			agentId: agent.agentId,
			clientMsgId: "CM1",
			text: "hola agente",
			delivery: "followUp",
			method: "interactive",
		});
		const fwd = await agent.client.next("user.message");
		expect(fwd.d).toMatchObject({
			clientMsgId: "CM1",
			text: "hola agente",
			deviceId: dev.deviceId,
			delivery: "followUp",
			method: "interactive",
			asCommand: false,
			attachments: [],
		});
		agent.client.send("user.message.ack", {
			clientMsgId: "CM1",
			disposition: "typed",
			method: "interactive",
			error: null,
		});
		const ack = await app.next("user.message.ack");
		expect(ack.re).toBe(id);
		expect(ack.d).toMatchObject({ clientMsgId: "CM1", disposition: "typed" });

		// reintento con el mismo clientMsgId: se responde igual y NO se reenvía al plugin
		const id2 = app.send("user.message", { agentId: agent.agentId, clientMsgId: "CM1", text: "hola agente" });
		const ack2 = await app.next("user.message.ack");
		expect(ack2.re).toBe(id2);
		expect(ack2.d).toMatchObject({ clientMsgId: "CM1", disposition: "typed" });
		await agent.client.never("user.message");
		agent.client.close();
		app.close();
	});

	it("reintento mientras el ack está en vuelo comparte la misma entrega", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-fly");
		const { client: app } = await connectApp(t, dev);
		app.send("user.message", { agentId: agent.agentId, clientMsgId: "F1", text: "a" });
		await agent.client.next("user.message");
		app.send("user.message", { agentId: agent.agentId, clientMsgId: "F1", text: "a" });
		await sleep(50);
		agent.client.send("user.message.ack", { clientMsgId: "F1", disposition: "sent", method: "api" });
		await app.next("user.message.ack");
		await app.next("user.message.ack");
		expect(agent.client.count("user.message")).toBe(1);
		agent.client.close();
		app.close();
	});

	it("agente offline → agent_offline (no se encolan mensajes de chat); desconocido → not_found", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-off");
		agent.client.close();
		await sleep(80);
		const { client: app } = await connectApp(t, dev);
		const id = app.send("user.message", { agentId: agent.agentId, clientMsgId: "O1", text: "hola" });
		const e = await app.next("error");
		expect(e.re).toBe(id);
		expect(e.d).toMatchObject({ code: "agent_offline" });
		app.send("user.message", { agentId: "x:y", clientMsgId: "O2", text: "hola" });
		expect((await app.next("error")).d).toMatchObject({ code: "not_found" });
		// y al volver el agente no recibe órdenes viejas
		const back = await connectAgent(t, m, "s-off");
		await back.client.never("user.message");
		back.client.close();
		app.close();
	});

	it("el plugin no confirma → agent_timeout (y un reintento posterior sí se reenvía)", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-to");
		const { client: app } = await connectApp(t, dev);
		app.send("user.message", { agentId: agent.agentId, clientMsgId: "T1", text: "hola" });
		await agent.client.next("user.message");
		const e = await app.next("error", 2000);
		expect(e.d).toMatchObject({ code: "agent_timeout" });
		app.send("user.message", { agentId: agent.agentId, clientMsgId: "T1", text: "hola" });
		await agent.client.next("user.message"); // el plugin deduplica; el relay reintenta
		agent.client.send("user.message.ack", { clientMsgId: "T1", disposition: "duplicate" });
		expect((await app.next("user.message.ack")).d).toMatchObject({ disposition: "duplicate" });
		agent.client.close();
		app.close();
	});

	it("vía HTTP /v1/agents/{id}/messages devuelve el ack", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-http");
		const p = api(t, "POST", `/v1/agents/${encodeURIComponent(agent.agentId)}/messages`, dev.deviceToken, {
			clientMsgId: "H1",
			text: "desde la notificación",
		});
		const fwd = await agent.client.next("user.message");
		expect((fwd.d as any).text).toBe("desde la notificación");
		agent.client.send("user.message.ack", { clientMsgId: "H1", disposition: "sent", method: "api" });
		const r = await p;
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ clientMsgId: "H1", disposition: "sent" });
		const off = await api(t, "POST", `/v1/agents/${encodeURIComponent("nada:nada")}/messages`, dev.deviceToken, {
			clientMsgId: "H2",
			text: "x",
		});
		expect(off.status).toBe(404);
		agent.client.close();
	});

	it("abort llega al plugin; sobre agente offline → error", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-abort");
		const { client: app } = await connectApp(t, dev);
		const id = app.send("agent.abort", { agentId: agent.agentId });
		await agent.client.next("agent.abort");
		expect((await app.next("ack")).re).toBe(id);
		agent.client.close();
		await sleep(80);
		app.send("agent.abort", { agentId: agent.agentId });
		expect((await app.next("error")).d).toMatchObject({ code: "agent_offline" });
		app.close();
	});
});

describe("revocación", () => {
	it("revocar una PC cierra sus agentes con 4001 y la retira de la app; revocar un dispositivo corta su WS", async () => {
		const dev = await pairDevice(t);
		const dev2 = await pairDevice(t, "Tablet");
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-rev");
		const { client: app } = await connectApp(t, dev);
		const r = await api(t, "DELETE", `/v1/machines/${m.machineId}`, dev.deviceToken);
		expect(r.status).toBe(200);
		expect((await agent.client.waitClosed()).code).toBe(4001);
		await app.next((e) => e.t === "machines.update" && (e.d as any).remove?.includes(m.machineId));
		// el cierre asíncrono del socket del agente NO vuelve a publicar el agente revocado como upsert
		await app.never(
			(e) => e.t === "agents.update" && (e.d as any).upsert?.some((a: any) => a.agentId === agent.agentId),
			150,
		);
		// el token revocado ya no conecta
		const again = await Client.connect(`${t.ws}/ws/agent`, m.machineToken);
		expect((await again.waitClosed()).code).toBe(4001);
		// revocar dispositivo
		const { client: app2 } = await connectApp(t, dev2);
		const r2 = await api(t, "DELETE", `/v1/devices/${dev2.deviceId}`, dev.deviceToken);
		expect(r2.status).toBe(200);
		expect((await app2.waitClosed()).code).toBe(4001);
		expect((await api(t, "GET", "/v1/agents", dev2.deviceToken)).status).toBe(401);
		app.close();
	});

	it("onSnapshot publica agents.update; history.build reanuda en first-1 y trunca entries antes que events", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "s-snap-hist");
		const { client: app } = await connectApp(t, dev);
		agent.client.send("agent.snapshot", {
			epoch: agent.hello.epoch,
			seq: 10,
			entries: [
				{ eid: "e1", kind: "user", at: 1, msg: { role: "user", content: "x".repeat(400_000) } },
				{ eid: "e2", kind: "user", at: 2, msg: { role: "user", content: "y".repeat(400_000) } },
			],
		});
		const snapUpd = await app.next(
			(e) => e.t === "agents.update" && (e.d as any).upsert?.[0]?.agentId === agent.agentId,
		);
		expect(snapUpd).toBeTruthy();

		agent.client.send("agent.event", {
			epoch: agent.hello.epoch,
			seq: 11,
			e: { type: "message_end", message: { role: "assistant", content: "z".repeat(200_000) } },
		});
		agent.client.send("agent.event", {
			epoch: agent.hello.epoch,
			seq: 12,
			e: { type: "message_end", message: { role: "assistant", content: "fin" } },
		});
		await sleep(80);

		// sinceSeq === first - 1 (10 === 11 - 1) reanuda sin recargar snapshot
		const resumed = t.relay.ctx.history.build(agent.agentId, 10, agent.hello.epoch);
		expect(resumed.entries).toHaveLength(0);
		expect(resumed.events.map((e) => e.seq)).toEqual([11, 12]);

		// presupuesto de frame superado en carga completa: trunca entries antes que events
		const full = t.relay.ctx.history.build(agent.agentId, null, null);
		expect(full.truncated).toBe(true);
		expect(full.entries.length).toBeLessThan(2);
		expect(full.events.map((e) => e.seq)).toEqual([11, 12]);

		agent.client.close();
		app.close();
	});

	it("PATCH de PC (nombre, contexto, color) se difunde a las apps", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const { client: app } = await connectApp(t, dev);
		const r = await api(t, "PATCH", `/v1/machines/${m.machineId}`, dev.deviceToken, {
			name: "PC Empresa",
			context: "work",
			color: "#112233",
			quietHours: { from: "20:00", to: "08:00", tz: "America/Bogota" },
		});
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ name: "PC Empresa", context: "work", color: "#112233" });
		const upd = await app.next((e) => e.t === "machines.update" && (e.d as any).upsert[0]?.name === "PC Empresa");
		expect((upd.d as any).upsert[0].context).toBe("work");
		expect((await api(t, "PATCH", `/v1/machines/${m.machineId}`, dev.deviceToken, { color: "rojo" })).status).toBe(400);
		expect((await api(t, "PATCH", "/v1/machines/NOPE", dev.deviceToken, { name: "x" })).status).toBe(404);
		const list = await api(t, "GET", "/v1/machines", dev.deviceToken);
		expect(list.json.machines.find((x: any) => x.machineId === m.machineId).name).toBe("PC Empresa");
		app.close();
	});
});
