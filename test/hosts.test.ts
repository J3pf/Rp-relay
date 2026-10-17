import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
beforeEach(async () => {
	t = await startRelay();
});
afterEach(async () => {
	await t.stop();
	cleanup(t);
});

const hostHello = (machineId: string) => ({
	machineId,
	hostname: "devbox",
	roots: ["/home/u/proyectos"],
	backends: { herdr: "0.9.3", tmux: "3.4", wt: false, console: false },
	defaultBackend: "herdr",
	launchers: ["gentle-shell", "pi"],
	defaultLauncher: "gentle-shell",
});

async function connectHost(m: { machineId: string; machineToken: string }) {
	const host = await Client.connect(`${t.ws}/ws/host`, m.machineToken);
	host.send("host.hello", hostHello(m.machineId));
	return host;
}

describe("rp-host (/ws/host)", () => {
	it("host.hello marca hostOnline y difunde hosts.update/machines.update; al cerrar vuelve a offline", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const { client: app, welcome } = await connectApp(t, dev);
		expect((welcome.d as any).machines.find((x: any) => x.machineId === m.machineId).hostOnline).toBe(false);
		const host = await connectHost(m);
		const hu = await app.next("hosts.update");
		expect((hu.d as any).upsert[0]).toMatchObject({
			machineId: m.machineId,
			hostname: "devbox",
			roots: ["/home/u/proyectos"],
			online: true,
		});
		await app.next((e) => e.t === "machines.update" && (e.d as any).upsert[0]?.hostOnline === true);
		host.close();
		await app.next((e) => e.t === "hosts.update" && (e.d as any).upsert[0]?.online === false);
		app.close();
	});

	it("host.hello con otro machineId → 4001; token inválido → 4001", async () => {
		const m = await pairMachine(t);
		const other = await pairMachine(t);
		const c = await Client.connect(`${t.ws}/ws/host`, m.machineToken);
		c.send("host.hello", hostHello(other.machineId));
		expect((await c.next("error")).d).toMatchObject({ code: "unauthorized" });
		expect((await c.waitClosed()).code).toBe(4001);
		const bad = await Client.connect(`${t.ws}/ws/host`, "rpm_x");
		expect((await bad.waitClosed()).code).toBe(4001);
	});

	it("la app enruta host.list_dirs / herdr_layout / spawn al host de la PC y recibe la respuesta", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const host = await connectHost(m);
		const { client: app } = await connectApp(t, dev);

		const id1 = app.send("host.list_dirs", { machineId: m.machineId, path: "/home/u/proyectos" });
		const req1 = await host.next("host.list_dirs");
		expect(req1.d).toEqual({ machineId: m.machineId, path: "/home/u/proyectos" });
		host.send("host.dirs", { path: "/home/u/proyectos", dirs: ["api", "web"] }, { re: req1.id });
		const dirs = await app.next("host.dirs");
		expect(dirs.re).toBe(id1);
		expect((dirs.d as any).dirs).toEqual(["api", "web"]);

		const id2 = app.send("host.herdr_layout", { machineId: m.machineId });
		const req2 = await host.next("host.herdr_layout");
		host.send(
			"host.herdr_layout.result",
			{
				workspaces: [
					{ id: "w1", label: "api", tabs: [{ id: "t1", label: "main", panes: [{ id: "p1", agent: "pi" }] }] },
				],
			},
			{ re: req2.id },
		);
		expect((await app.next("host.herdr_layout.result")).re).toBe(id2);

		const id3 = app.send("host.spawn", {
			machineId: m.machineId,
			cwd: "/home/u/proyectos/api",
			name: "api",
			launcher: "gentle-shell",
			backend: "herdr",
			herdrTarget: { type: "workspace" },
		});
		const req3 = await host.next("host.spawn");
		expect((req3.d as any).cwd).toBe("/home/u/proyectos/api");
		host.send(
			"host.spawned",
			{ spawnId: "SP1", backend: "herdr", herdr: { workspaceId: "w1", paneId: "p1" }, tmuxSession: null },
			{ re: req3.id },
		);
		const spawned = await app.next("host.spawned");
		expect(spawned.re).toBe(id3);
		expect((spawned.d as any).spawnId).toBe("SP1");

		// host.spawn con sessionId se enruta intacto
		const idResume = app.send("host.spawn", {
			machineId: m.machineId,
			cwd: "/home/u/proyectos/api",
			sessionId: "01JA0000000000000000000099",
		});
		const reqResume = await host.next("host.spawn");
		expect((reqResume.d as any).sessionId).toBe("01JA0000000000000000000099");
		host.send(
			"host.spawned",
			{ spawnId: "SP-RESUME", backend: "tmux", herdr: null, tmuxSession: null },
			{ re: reqResume.id },
		);
		const spawnedResume = await app.next("host.spawned");
		expect(spawnedResume.re).toBe(idResume);
		expect((spawnedResume.d as any).spawnId).toBe("SP-RESUME");

		// errores del host llegan a la app
		const id4 = app.send("host.kill", { machineId: m.machineId, spawnId: "NOPE" });
		const req4 = await host.next("host.kill");
		host.send("error", { code: "not_found", message: "no creado por el host" }, { re: req4.id });
		const err = await app.next("error");
		expect(err.re).toBe(id4);
		expect(err.d).toMatchObject({ code: "not_found" });
		host.close();
		app.close();
	});

	it("sin host conectado → host_offline; PC desconocida → not_found; el host que cae responde error a lo pendiente", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const { client: app } = await connectApp(t, dev);
		app.send("host.list_dirs", { machineId: m.machineId, path: "/" });
		expect((await app.next("error")).d).toMatchObject({ code: "host_offline" });
		app.send("host.list_dirs", { machineId: "NOPE", path: "/" });
		expect((await app.next("error")).d).toMatchObject({ code: "not_found" });
		const host = await connectHost(m);
		await app.next("hosts.update");
		const id = app.send("host.herdr_layout", { machineId: m.machineId });
		await host.next("host.herdr_layout");
		host.terminate();
		const e = await app.next((x) => x.t === "error" && x.re === id);
		expect(e.d).toMatchObject({ code: "host_offline" });
		app.close();
	});

	it("timeout si el host no responde", async () => {
		await t.stop();
		cleanup(t);
		t = await startRelay({ limits: { hostRequestTimeoutMs: 150 } });
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const host = await connectHost(m);
		const { client: app } = await connectApp(t, dev);
		const id = app.send("host.list_dirs", { machineId: m.machineId, path: "/" });
		await host.next("host.list_dirs");
		const e = await app.next((x) => x.t === "error" && x.re === id);
		expect(e.d).toMatchObject({ code: "timeout" });
		// una respuesta tardía del host se ignora sin romper nada
		host.send("host.dirs", { path: "/", dirs: [] }, { re: id });
		await sleep(50);
		expect((t.relay.ctx.hosts as any).pending.size).toBe(0);
		host.close();
		app.close();
	});

	it("initialPrompt: el relay lo retiene y lo entrega como user.message al agent.hello con ese spawnId", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const host = await connectHost(m);
		const { client: app } = await connectApp(t, dev);
		app.send("host.spawn", { machineId: m.machineId, cwd: "/p", initialPrompt: "arranca con los tests" });
		const req = await host.next("host.spawn");
		expect((req.d as any).initialPrompt).toBeUndefined(); // el host no lo necesita
		host.send(
			"host.spawned",
			{ spawnId: "SPAWN-A", backend: "tmux", herdr: null, tmuxSession: "rp-p" },
			{ re: req.id },
		);
		await app.next("host.spawned");
		const agent = await connectAgent(t, m, "sp1", { spawnId: "SPAWN-A" });
		const um = await agent.client.next("user.message");
		expect(um.d).toMatchObject({ text: "arranca con los tests", delivery: "auto", method: "auto" });
		agent.client.send("user.message.ack", {
			clientMsgId: (um.d as any).clientMsgId,
			disposition: "sent",
			method: "api",
		});
		// el agente aparece como creado por el host
		const list = await (
			await fetch(`${t.http}/v1/agents`, { headers: { authorization: `Bearer ${dev.deviceToken}` } })
		).json();
		expect((list as any).agents.find((a: any) => a.agentId === agent.agentId).spawnedByHost).toBe(true);
		// un segundo hello con el mismo spawnId no vuelve a entregar
		const again = await connectAgent(t, m, "sp1", { spawnId: "SPAWN-A" });
		await again.client.never("user.message", 300);
		for (const c of [host, app, agent.client, again.client]) c.close();
	});

	it("initialPrompt: el hello del agente puede llegar ANTES que host.spawned", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const host = await connectHost(m);
		const { client: app } = await connectApp(t, dev);
		app.send("host.spawn", { machineId: m.machineId, cwd: "/p", initialPrompt: "hola temprano" });
		const req = await host.next("host.spawn");
		const agent = await connectAgent(t, m, "sp2", { spawnId: "SPAWN-B" });
		await agent.client.never("user.message", 100);
		host.send("host.spawned", { spawnId: "SPAWN-B", backend: "tmux", herdr: null, tmuxSession: null }, { re: req.id });
		expect((await agent.client.next("user.message")).d).toMatchObject({ text: "hola temprano" });
		for (const c of [host, app, agent.client]) c.close();
	});

	it("initialPrompt caduca a los 60 s", async () => {
		const m = await pairMachine(t);
		const hosts = t.relay.ctx.hosts as any;
		hosts.holdInitialPrompt(m.machineId, "OLD", "viejo");
		hosts.held.get(`${m.machineId}\u0000OLD`).expires = Date.now() - 1;
		hosts.sweep();
		expect(hosts.held.size).toBe(0);
		const agent = await connectAgent(t, m, "sp3", { spawnId: "OLD" });
		await agent.client.never("user.message", 150);
		agent.client.close();
		void helloBody;
	});

	it("dos apps enviando el mismo env.id en paralelo no colisionan en pending", async () => {
		const dev1 = await pairDevice(t, "App1");
		const dev2 = await pairDevice(t, "App2");
		const m = await pairMachine(t);
		const host = await connectHost(m);
		const { client: app1 } = await connectApp(t, dev1);
		const { client: app2 } = await connectApp(t, dev2);

		app1.raw(JSON.stringify({ v: 1, t: "host.list_dirs", id: "DUP-1", d: { machineId: m.machineId, path: "/a" } }));
		app2.raw(JSON.stringify({ v: 1, t: "host.list_dirs", id: "DUP-1", d: { machineId: m.machineId, path: "/b" } }));

		const reqA = await host.next((e) => e.t === "host.list_dirs" && (e.d as any).path === "/a");
		const reqB = await host.next((e) => e.t === "host.list_dirs" && (e.d as any).path === "/b");
		expect(reqA.id).not.toBe(reqB.id);

		host.send("host.dirs", { path: "/a", dirs: ["only-a"] }, { re: reqA.id });
		host.send("host.dirs", { path: "/b", dirs: ["only-b"] }, { re: reqB.id });

		const res1 = await app1.next("host.dirs");
		const res2 = await app2.next("host.dirs");
		expect(res1.re).toBe("DUP-1");
		expect((res1.d as any).dirs).toEqual(["only-a"]);
		expect(res2.re).toBe("DUP-1");
		expect((res2.d as any).dirs).toEqual(["only-b"]);

		for (const c of [host, app1, app2]) c.close();
	});

	it("host.hello con quotas se proyecta en machines.update y en app.welcome", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const { client: app } = await connectApp(t, dev);

		const sampleQuotas = [
			{
				family: "codex",
				label: "Codex (Pi)",
				plan: "plus",
				ok: true,
				notConfigured: false,
				error: null,
				primaryWindowId: "5h",
				windows: [
					{
						id: "5h",
						label: "5h window",
						usedPercent: 20.0,
						remainingPercent: 80.0,
						resetsAt: "2026-10-15T10:00:00.000Z",
						resetsInSec: 10000,
						note: null,
					},
				],
				updatedAt: "2026-10-15T05:00:00.000Z",
			},
		];

		const host = await Client.connect(`${t.ws}/ws/host`, m.machineToken);
		host.send("host.hello", { ...hostHello(m.machineId), quotas: sampleQuotas });

		const mu = await app.next((e) => e.t === "machines.update" && (e.d as any).upsert[0]?.machineId === m.machineId);
		const updatedMachine = (mu.d as any).upsert[0];
		expect(updatedMachine.quotas).toEqual(sampleQuotas);

		// Nueva app al conectar recibe las cuotas en app.welcome
		const dev2 = await pairDevice(t, "App2");
		const { client: app2, welcome } = await connectApp(t, dev2);
		const welcomeMachine = (welcome.d as any).machines.find((x: any) => x.machineId === m.machineId);
		expect(welcomeMachine.quotas).toEqual(sampleQuotas);

		host.close();
		app.close();
		app2.close();
	});

	it("host.quotas actualiza dinámicamente las cuotas y difunde machines.update", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const host = await connectHost(m);
		const { client: app } = await connectApp(t, dev);

		const updatedQuotas = [
			{
				family: "antigravity",
				label: "Antigravity (Pi)",
				plan: null,
				ok: true,
				notConfigured: false,
				error: null,
				primaryWindowId: "gemini-5h",
				windows: [
					{
						id: "gemini-5h",
						label: "Gemini 5h",
						usedPercent: 45.0,
						remainingPercent: 55.0,
						resetsAt: "2026-10-15T12:00:00.000Z",
						resetsInSec: 14000,
						note: "45% used",
					},
				],
				updatedAt: "2026-10-15T06:00:00.000Z",
			},
		];

		host.send("host.quotas", { quotas: updatedQuotas });

		const mu = await app.next((e) => e.t === "machines.update" && (e.d as any).upsert[0]?.machineId === m.machineId);
		expect((mu.d as any).upsert[0].quotas).toEqual(updatedQuotas);

		// Persistido en base de datos
		const row = t.relay.ctx.repos.machines.get(m.machineId);
		expect(JSON.parse(row!.quotas!)).toEqual(updatedQuotas);

		// Al reconectar el host sin quotas en host.hello, las cuotas antiguas se limpian
		host.close();
		await host.waitClosed();
		const hostReconnect = await connectHost(m);
		const clearedUpdate = await app.next(
			(e) =>
				e.t === "machines.update" &&
				(e.d as any).upsert[0]?.machineId === m.machineId &&
				(e.d as any).upsert[0]?.hostOnline === true &&
				(e.d as any).upsert[0]?.quotas === undefined,
		);
		expect((clearedUpdate.d as any).upsert[0].quotas).toBeUndefined();
		expect(t.relay.ctx.repos.machines.get(m.machineId)?.quotas).toBeNull();

		hostReconnect.close();
		app.close();
	});
});
