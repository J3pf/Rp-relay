import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupNow, restoreBackup, verifyDb } from "../src/backup/index.js";
import { openDb } from "../src/db/index.js";
import {
	api,
	Client,
	cleanup,
	connectAgent,
	connectApp,
	helloBody,
	pairDevice,
	pairMachine,
	promptBody,
	sleep,
	startRelay,
	type TestRelay,
} from "./helpers.js";

const toClean: TestRelay[] = [];
const start = async (...a: Parameters<typeof startRelay>) => {
	const t = await startRelay(...a);
	toClean.push(t);
	return t;
};
afterEach(async () => {
	for (const t of toClean.splice(0)) {
		await t.stop().catch(() => {});
		cleanup(t);
	}
});

/** Reconexión de un cliente de referencia con backoff, como los plugins/apps reales. */
async function reconnectAgent(
	t: TestRelay,
	m: { machineId: string; machineToken: string },
	hello: ReturnType<typeof helloBody>,
) {
	for (let i = 0; i < 30; i++) {
		try {
			const c = await Client.connect(`${t.ws}/ws/agent`, m.machineToken);
			c.send("agent.hello", hello);
			const welcome = await c.next("agent.welcome");
			return { c, welcome };
		} catch {
			await sleep(100);
		}
	}
	throw new Error("no se pudo reconectar");
}

describe("resiliencia: relay caído y reiniciado", () => {
	it("relay muerto con un prompt abierto y respondido a medias: nada se pierde y se resuelve una sola vez", async () => {
		let t = await start();
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "r1");
		const p = promptBody(agent.agentId, { promptId: "RP1" }) as any;
		const { client: app } = await connectApp(t, dev);
		agent.client.send("prompt.open", p);
		await app.next("prompt.opened");
		// el móvil responde, el plugin lo recibe pero el relay "muere" antes de recibir el ack
		const r = await api(t, "POST", "/v1/prompts/RP1/answer", dev.deviceToken, { answer: { optionIds: ["0"] } });
		expect(r.status).toBe(200);
		await agent.client.next("prompt.answer");
		t = await t.restart();
		toClean.push(t);
		expect((await agent.client.waitClosed()).code).toBe(1012); // el cierre ordenado avisa con service restart
		expect(t.relay.ctx.repos.prompts.get("RP1")!.state).toBe("answered");

		// el plugin reconecta enviando su prompt abierto (aún no lo había resuelto) y recibe la respuesta pendiente
		const { c, welcome } = await reconnectAgent(t, m, { ...agent.hello, instance: "I2", openPrompts: [p] } as any);
		expect((welcome.d as any).pendingAnswers).toEqual([
			{ promptId: "RP1", answer: { optionIds: ["0"] }, deviceId: dev.deviceId },
		]);
		// segunda respuesta de otro dispositivo → rechazada
		const dev2 = await pairDevice(t, "Tablet");
		expect(
			(await api(t, "POST", "/v1/prompts/RP1/answer", dev2.deviceToken, { answer: { optionIds: ["1"] } })).status,
		).toBe(409);
		c.send("prompt.ack", { promptId: "RP1", accepted: true });
		await sleep(100);
		expect(t.relay.ctx.repos.prompts.get("RP1")).toMatchObject({ state: "resolved", resolved_by: "remote" });
		c.close();
		app.close();
	});

	it("tras reiniciar el relay, los agentes quedan offline hasta reconectar; sin reconexión los prompts abiertos se cancelan tras la gracia", async () => {
		let t = await start();
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "r2");
		agent.client.send("prompt.open", promptBody(agent.agentId, { promptId: "RP2" }));
		await sleep(80);
		t = await t.restart();
		toClean.push(t);
		const list = await api(t, "GET", "/v1/agents", dev.deviceToken);
		expect(list.json.agents.find((a: any) => a.agentId === agent.agentId).online).toBe(false);
		expect(t.relay.ctx.repos.prompts.get("RP2")!.state).toBe("open");
		await sleep(700);
		expect(t.relay.ctx.repos.prompts.get("RP2")!.state).toBe("cancelled");
	});

	it("reconexión de apps y plugins: el historial continúa (sinceSeq) y los eventos persistidos sobreviven al reinicio", async () => {
		let t = await start();
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "r3");
		for (let i = 0; i < 5; i++) agent.event({ type: "message_end", message: { role: "assistant", content: `m${i}` } });
		await sleep(100);
		t = await t.restart();
		toClean.push(t);
		const { c, welcome } = await reconnectAgent(t, m, { ...agent.hello, instance: "I2" });
		expect((welcome.d as any).lastSeq).toBe(5); // mismo epoch: el relay conserva el último seq
		c.send("agent.event", {
			epoch: agent.hello.epoch,
			seq: 6,
			e: { type: "message_end", message: { role: "assistant", content: "m5" } },
		});
		const { client: app } = await connectApp(t, dev);
		app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: 3, epoch: agent.hello.epoch });
		const h = (await app.next("agent.history")).d as any;
		expect(h.events.map((e: any) => e.seq)).toEqual([4, 5, 6]);
		c.close();
		app.close();
	});

	it("cierre ordenado: todos los clientes reciben 1012 y la DB queda consistente", async () => {
		const t = await start();
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "r4");
		const { client: app } = await connectApp(t, dev);
		const { client: direct } = await connectApp(t, dev, "direct");
		await t.stop();
		for (const c of [agent.client, app, direct]) expect((await c.waitClosed()).code).toBe(1012);
		const db = openDb(join(t.dir, "relay.db"), { readonly: true });
		expect((db.pragma("integrity_check") as any[])[0].integrity_check).toBe("ok");
		db.close();
	});
});

describe("resiliencia: red", () => {
	it("corte de red del plugin con mensajes en vuelo: el reintento con el mismo clientMsgId no duplica", async () => {
		const t = await start();
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "n1");
		const { client: app } = await connectApp(t, dev);
		app.send("user.message", { agentId: agent.agentId, clientMsgId: "NET1", text: "hola" });
		const first = await agent.client.next("user.message");
		agent.client.terminate(); // se corta antes de acusar recibo
		await app.next("error", 2000).then((e) => expect(e.d).toMatchObject({ code: "agent_timeout" }));
		const { c } = await reconnectAgent(t, m, { ...agent.hello, instance: "I2" });
		app.send("user.message", { agentId: agent.agentId, clientMsgId: "NET1", text: "hola" });
		const again = await c.next("user.message");
		expect((again.d as any).clientMsgId).toBe((first.d as any).clientMsgId);
		c.send("user.message.ack", { clientMsgId: "NET1", disposition: "sent", method: "api" });
		await app.next("user.message.ack");
		// y un tercer reintento ya no llega al plugin
		app.send("user.message", { agentId: agent.agentId, clientMsgId: "NET1", text: "hola" });
		await app.next("user.message.ack");
		await c.never("user.message");
		c.close();
		app.close();
	});

	it("corte de 'minutos' de la app: respuestas pendientes se aplican al volver (HTTP idempotente) y la app recupera el estado", async () => {
		const t = await start();
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "n2");
		const { client: app } = await connectApp(t, dev);
		app.terminate();
		const p = promptBody(agent.agentId, { promptId: "NP1" });
		agent.client.send("prompt.open", p);
		agent.event({ type: "message_end", message: { role: "assistant", content: "durante el corte" } });
		await sleep(100);
		const { client: back, welcome } = await connectApp(t, dev);
		expect((welcome.d as any).openPrompts.map((x: any) => x.promptId)).toContain("NP1");
		back.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: null, epoch: null });
		const h = (await back.next("agent.history")).d as any;
		expect(h.events.some((e: any) => e.e.message?.content === "durante el corte")).toBe(true);
		const r1 = await api(t, "POST", "/v1/prompts/NP1/answer", dev.deviceToken, { answer: { optionIds: ["0"] } });
		const r2 = await api(t, "POST", "/v1/prompts/NP1/answer", dev.deviceToken, { answer: { optionIds: ["0"] } }); // reintento de WorkManager
		expect([r1.status, r2.status]).toEqual([200, 409]);
		agent.client.close();
		back.close();
	});

	it("Pi se reinicia durante un message_update: nuevo epoch, el historial anterior se sustituye por el snapshot nuevo", async () => {
		const t = await start();
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const a1 = await connectAgent(t, m, "n3");
		a1.event({ type: "agent_start" });
		a1.event({ type: "message_start" });
		a1.event({ type: "message_delta", contentIndex: 0, kind: "text", delta: "a medias" });
		a1.client.terminate(); // el proceso muere sin message_end
		await sleep(80);
		const hello2 = { ...a1.hello, instance: "I2", epoch: "EPOCH2" };
		const { c, welcome } = await reconnectAgent(t, m, hello2);
		expect((welcome.d as any).lastSeq).toBeNull(); // epoch distinto
		c.send("agent.snapshot", {
			epoch: "EPOCH2",
			seq: 0,
			entries: [{ eid: "z", kind: "user", at: 1, msg: { role: "user", content: "nuevo" } }],
		});
		c.send("agent.event", { epoch: "EPOCH2", seq: 1, e: { type: "agent_start" } });
		await sleep(80);
		const { client: app } = await connectApp(t, dev);
		app.send("agent.subscribe", { agentId: a1.agentId, sinceSeq: 5, epoch: a1.hello.epoch });
		const h = (await app.next("agent.history")).d as any;
		expect(h.epoch).toBe("EPOCH2");
		expect(h.entries).toHaveLength(1);
		expect(h.events.map((e: any) => e.seq)).toEqual([1]);
		expect(
			t.relay.db.prepare("SELECT COUNT(*) AS n FROM events WHERE epoch<>'EPOCH2' AND agent_id=?").get(a1.agentId),
		).toEqual({ n: 0 });
		c.close();
		app.close();
	});

	it("heartbeat: un cliente que no contesta al ping se cierra", async () => {
		const { startHeartbeat } = await import("../src/ws/conn.js");
		const { WebSocketServer, WebSocket } = await import("ws");
		const wss = new WebSocketServer({ port: 0 });
		await new Promise((r) => wss.on("listening", r));
		const port = (wss.address() as any).port;
		const closed = new Promise<void>((resolve) =>
			wss.on("connection", (s) => {
				startHeartbeat(s, { pingMs: 40, pongMs: 60 });
				s.on("close", () => resolve());
			}),
		);
		const client = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false });
		await new Promise((r) => client.on("open", r));
		await closed;
		wss.close();
	});

	it("contrapresión: bajo presión se descartan deltas pero se conservan los eventos finales; consumidor lento extremo → 1013", async () => {
		const t = await start({ limits: { maxBufferedBytes: 1024, hardBufferedBytes: 4096 } });
		const hub = t.relay.ctx.hub;
		const sent: string[] = [];
		const fake = {
			id: "x",
			deviceId: "d",
			mode: "foreground" as const,
			subs: new Set<string>(),
			ready: true,
			bufferedAmount: 2000,
			send: (e: any) => {
				sent.push(e.t);
				return true;
			},
			close: (code: number) => sent.push(`close:${code}`),
		};
		expect(hub.sendApp(fake, { v: 1, t: "agent.event", d: {} }, true)).toBe(false); // delta descartado
		expect(hub.sendApp(fake, { v: 1, t: "agent.event", d: {} }, false)).toBe(true); // final conservado
		fake.bufferedAmount = 10_000;
		expect(hub.sendApp(fake, { v: 1, t: "agent.event", d: {} }, false)).toBe(false);
		expect(sent).toEqual(["agent.event", "close:1013"]);
	});
});

describe("copias de seguridad y restauración", () => {
	it("VACUUM INTO crea una copia íntegra; restaurarla recupera los datos y conserva la base anterior", async () => {
		const t = await start();
		const dev = await pairDevice(t);
		const m = await pairMachine(t, "pc", { name: "PC original" });
		const file = t.relay.backup();
		expect(verifyDb(file)).toMatchObject({ ok: true });
		expect(existsSync(file)).toBe(true);

		// se "pierde" información después de la copia
		await api(t, "DELETE", `/v1/machines/${m.machineId}`, dev.deviceToken);
		await t.stop();
		const dbFile = join(t.dir, "relay.db");
		const { previous } = restoreBackup(file, dbFile);
		expect(previous).toBeTruthy();
		expect(existsSync(previous!)).toBe(true);
		const t2 = await startRelay({}, { dir: t.dir });
		toClean.push(t2);
		const row = t2.relay.ctx.repos.machines.get(m.machineId)!;
		expect(row.name).toBe("PC original");
		expect(row.revoked_at).toBeNull();
		// el token de la PC restaurada vuelve a funcionar
		const c = await Client.connect(`${t2.ws}/ws/agent`, m.machineToken);
		c.send("agent.hello", helloBody(m.machineId, "bk"));
		await c.next("agent.welcome");
		c.close();
	});

	it("restore rechaza copias corruptas o ajenas", () => {
		const t = join(process.env.TMPDIR ?? "/tmp", `rp-bad-${Date.now()}.db`);
		writeFileSync(t, "esto no es sqlite");
		expect(verifyDb(t).ok).toBe(false);
		expect(() => restoreBackup(t, `${t}.dest`)).toThrow(/no es válida/);
		const db = openDb(`${t}.other`);
		db.exec("CREATE TABLE otra(x)");
		db.close();
		expect(verifyDb(`${t}.other`)).toMatchObject({ ok: false });
	});

	it("la migración crea una copia previa cuando hay datos", async () => {
		const t = await start();
		await pairDevice(t);
		await t.stop();
		const { migrate } = await import("../src/db/migrate.js");
		const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const mdir = mkdtempSync(join(tmpdir(), "rp-mig-"));
		const { readMigrations } = await import("../src/db/migrate.js");
		for (const mig of readMigrations()) writeFileSync(join(mdir, mig.name), mig.sql);
		writeFileSync(join(mdir, "0002_extra.sql"), "CREATE TABLE extra (id INTEGER PRIMARY KEY);");
		const db = openDb(join(t.dir, "relay.db"));
		let backedUp = false;
		const applied = migrate(db, {
			dir: mdir,
			beforeApply: () => {
				backedUp = true;
				backupNow(db, join(t.dir, "backups"));
			},
		});
		db.close();
		expect(applied).toEqual([2]);
		expect(backedUp).toBe(true);
		expect(readdirSync(join(t.dir, "backups")).length).toBe(1);
		void mkdirSync;
	});
});
