import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	Client,
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
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
	roots: ["/home/u/projects"],
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

const isAgentUpsert = (agentId: string, online?: boolean) => (env: { t: string; d?: any }) =>
	env.t === "agents.update" &&
	env.d?.upsert?.some((agent: any) => agent.agentId === agentId && (online === undefined || agent.online === online));
const isAgentRemoval = (agentId: string) => (env: { t: string; d?: any }) =>
	env.t === "agents.update" && env.d?.remove?.includes(agentId);

function isActive(agentId: string): boolean {
	return t.relay.ctx.repos.agents.list().some((agent) => agent.id === agentId);
}

describe("agent lifecycle synchronization", () => {
	it("rejects close when the agent has no Herdr pane binding", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const host = await connectHost(machine);
		const { client: app } = await connectApp(t, device);
		const agent = await connectAgent(t, machine);

		const reqId = app.send("agent.close", { agentId: agent.agentId });
		const error = await app.next((env) => env.t === "error" && env.re === reqId);
		expect(error.d).toMatchObject({ code: "agent_close_unsupported" });
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).toBeNull();
		expect(isActive(agent.agentId)).toBe(true);
		await host.never("host.herdr_close");

		for (const client of [host, app, agent.client]) client.close();
	});

	it("closes the bound Herdr pane, acknowledges, and archives the agent", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const host = await connectHost(machine);
		const { client: app } = await connectApp(t, device);
		const agent = await connectAgent(t, machine, "sess-close", {
			herdr: { paneId: "p3", tabId: "t1", workspaceId: "w2" },
		});

		const reqId = app.send("agent.close", { agentId: agent.agentId });
		const request = await host.next("host.herdr_close");
		expect(request.d).toEqual({ machineId: machine.machineId, paneId: "p3" });
		host.send("host.herdr_closed", { paneId: "p3", ok: true, error: null }, { re: request.id });

		const ack = await app.next((env) => env.t === "ack" && env.re === reqId);
		expect(ack.re).toBe(reqId);
		const removed = await app.next(isAgentRemoval(agent.agentId));
		expect((removed.d as any).remove).toContain(agent.agentId);
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).not.toBeNull();
		expect(isActive(agent.agentId)).toBe(false);

		const fresh = await connectApp(t, device);
		expect((fresh.welcome.d as any).agents.some((entry: any) => entry.agentId === agent.agentId)).toBe(false);

		for (const client of [host, app, fresh.client, agent.client]) client.close();
	});

	it("archives the agent when Herdr reports the pane no longer exists", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const host = await connectHost(machine);
		const { client: app } = await connectApp(t, device);
		const agent = await connectAgent(t, machine, "sess-gone", { herdr: { paneId: "p3" } });

		const reqId = app.send("agent.close", { agentId: agent.agentId });
		const request = await host.next("host.herdr_close");
		host.send("host.herdr_closed", { paneId: "p3", ok: false, error: "pane_not_found" }, { re: request.id });

		// el panel ya no existe: el estado deseado se cumple, así que el cierre es un éxito
		const ack = await app.next((env) => env.t === "ack" && env.re === reqId);
		expect(ack.re).toBe(reqId);
		const removed = await app.next(isAgentRemoval(agent.agentId));
		expect((removed.d as any).remove).toContain(agent.agentId);
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).not.toBeNull();
		expect(isActive(agent.agentId)).toBe(false);

		// el historial sobrevive: archivado, no destruido
		expect(t.relay.ctx.repos.agents.listArchived(10, null, null).map((row) => row.id)).toContain(agent.agentId);
		// y todo cliente converge, no solo el que pidió el cierre
		const fresh = await connectApp(t, device);
		expect((fresh.welcome.d as any).agents.some((entry: any) => entry.agentId === agent.agentId)).toBe(false);

		for (const client of [host, app, fresh.client, agent.client]) client.close();
	});

	it("still returns herdr_close_failed when Herdr genuinely refuses to close the pane", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const host = await connectHost(machine);
		const { client: app } = await connectApp(t, device);
		const agent = await connectAgent(t, machine, "sess-refused", { herdr: { paneId: "p3" } });

		const reqId = app.send("agent.close", { agentId: agent.agentId });
		const request = await host.next("host.herdr_close");
		host.send("host.herdr_closed", { paneId: "p3", ok: false, error: "herdr_close_failed" }, { re: request.id });

		const error = await app.next((env) => env.t === "error" && env.re === reqId);
		expect(error.d).toMatchObject({
			code: "conflict",
			message: "herdr no pudo cerrar el panel: herdr_close_failed",
			reason: "herdr_close_failed",
		});
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).toBeNull();
		expect(isActive(agent.agentId)).toBe(true);
		const fresh = await connectApp(t, device);
		expect((fresh.welcome.d as any).agents.some((entry: any) => entry.agentId === agent.agentId)).toBe(true);

		for (const client of [host, app, fresh.client, agent.client]) client.close();
	});

	it("still fails and keeps the agent when the host reports herdr_unavailable", async () => {
		// Un panel que sí existe puede seguir vivo: archivar aquí sería crear agentes fantasma.
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const host = await connectHost(machine);
		const { client: app } = await connectApp(t, device);
		const agent = await connectAgent(t, machine, "sess-unavailable", { herdr: { paneId: "p3" } });

		const reqId = app.send("agent.close", { agentId: agent.agentId });
		const request = await host.next("host.herdr_close");
		host.send("host.herdr_closed", { paneId: "p3", ok: false, error: "herdr_unavailable" }, { re: request.id });

		const error = await app.next((env) => env.t === "error" && env.re === reqId);
		expect(error.d).toMatchObject({
			code: "conflict",
			message: "herdr no pudo cerrar el panel: herdr_unavailable",
			reason: "herdr_close_failed",
		});
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).toBeNull();
		expect(isActive(agent.agentId)).toBe(true);
		expect(t.relay.ctx.repos.agents.listArchived(10, null, null).map((row) => row.id)).not.toContain(agent.agentId);
		const fresh = await connectApp(t, device);
		expect((fresh.welcome.d as any).agents.some((entry: any) => entry.agentId === agent.agentId)).toBe(true);

		for (const client of [host, app, fresh.client, agent.client]) client.close();
	});

	it("returns host_offline and leaves the agent active when its host is disconnected", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const { client: app } = await connectApp(t, device);
		const agent = await connectAgent(t, machine, "sess-offline", { herdr: { paneId: "p3" } });

		const reqId = app.send("agent.close", { agentId: agent.agentId });
		const error = await app.next((env) => env.t === "error" && env.re === reqId);
		expect(error.d).toMatchObject({ code: "host_offline" });
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).toBeNull();
		expect(isActive(agent.agentId)).toBe(true);

		for (const client of [app, agent.client]) client.close();
	});

	it("returns host_offline when the host disconnects during a pending close", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const host = await connectHost(machine);
		const { client: app } = await connectApp(t, device);
		const agent = await connectAgent(t, machine, "sess-host-drop", { herdr: { paneId: "p3" } });

		const reqId = app.send("agent.close", { agentId: agent.agentId });
		await host.next("host.herdr_close");
		host.terminate();
		const error = await app.next((env) => env.t === "error" && env.re === reqId);
		expect(error.d).toMatchObject({ code: "host_offline" });
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).toBeNull();
		expect(isActive(agent.agentId)).toBe(true);

		for (const client of [host, app, agent.client]) client.close();
	});

	it("returns timeout and leaves the agent active when the host never replies", async () => {
		await t.stop();
		cleanup(t);
		t = await startRelay({ limits: { hostRequestTimeoutMs: 120 } });
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const host = await connectHost(machine);
		const { client: app } = await connectApp(t, device);
		const agent = await connectAgent(t, machine, "sess-timeout", { herdr: { paneId: "p3" } });

		const reqId = app.send("agent.close", { agentId: agent.agentId });
		await host.next("host.herdr_close");
		const error = await app.next((env) => env.t === "error" && env.re === reqId);
		expect(error.d).toMatchObject({ code: "timeout" });
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).toBeNull();
		expect(isActive(agent.agentId)).toBe(true);

		for (const client of [host, app, agent.client]) client.close();
	});

	it("archives on agent.closed and does not upsert again when that socket closes", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const { client: app } = await connectApp(t, device);
		const agent = await connectAgent(t, machine);
		await app.next(isAgentUpsert(agent.agentId, true));
		await app.next(isAgentUpsert(agent.agentId, true));

		agent.client.send("agent.closed", { reason: "pane_closed" });
		const removed = await app.next(isAgentRemoval(agent.agentId));
		expect((removed.d as any).remove).toContain(agent.agentId);
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).not.toBeNull();
		agent.client.close();
		await agent.client.waitClosed();
		await app.never(isAgentUpsert(agent.agentId));

		app.close();
	});

	it("keeps the agent active and marks it offline after a plain socket loss", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const { client: app } = await connectApp(t, device);
		const agent = await connectAgent(t, machine);

		agent.client.terminate();
		const update = await app.next(isAgentUpsert(agent.agentId, false));
		expect((update.d as any).upsert[0]).toMatchObject({ agentId: agent.agentId, online: false });
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).toBeNull();
		expect(isActive(agent.agentId)).toBe(true);

		app.close();
	});

	it("unarchives an agent when the same session reconnects", async () => {
		const device = await pairDevice(t);
		const machine = await pairMachine(t);
		const first = await connectAgent(t, machine, "sess-reconnect");
		first.client.close();
		await first.client.waitClosed();
		expect(t.relay.ctx.agents.archive(first.agentId)).toBe(true);
		expect(t.relay.ctx.repos.agents.get(first.agentId)?.archived_at).not.toBeNull();

		const resumed = await connectAgent(t, machine, "sess-reconnect");
		const { welcome } = await connectApp(t, device);
		expect(t.relay.ctx.repos.agents.get(first.agentId)?.archived_at).toBeNull();
		expect((welcome.d as any).agents.some((entry: any) => entry.agentId === first.agentId)).toBe(true);

		for (const client of [first.client, resumed.client]) client.close();
	});

	it("rejects an unsupported agent.closed reason without archiving", async () => {
		const machine = await pairMachine(t);
		const agent = await connectAgent(t, machine);

		const reqId = agent.client.send("agent.closed", { reason: "network" });
		const error = await agent.client.next((env) => env.t === "error" && env.re === reqId);
		expect(error.d).toMatchObject({ code: "bad_request" });
		expect(t.relay.ctx.repos.agents.get(agent.agentId)?.archived_at).toBeNull();
		expect(isActive(agent.agentId)).toBe(true);

		agent.client.close();
	});
});
