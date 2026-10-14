import { type Envelope, envelope } from "@j3pf/rp-protocol";
import type { Ctx } from "../context.js";

/** Difusión de cambios de estado a las apps (machines.update, agents.update, hosts.update). */
export class Publisher {
	constructor(private c: () => Ctx) {}

	agent(agentId: string): void {
		const { repos, hub, summaries } = this.c();
		const row = repos.agents.get(agentId);
		if (!row) return;
		const m = repos.machines.get(row.machine_id);
		if (m?.revoked_at) return;
		const s = summaries.agent(row);
		hub.broadcastApps(envelope("agents.update", { upsert: [s], remove: [] }), { mode: "foreground" });
		// el canal directo recibe la versión resumida (sin vista previa del último mensaje)
		hub.broadcastApps(envelope("agents.update", { upsert: [{ ...s, lastMessagePreview: null }], remove: [] }), {
			mode: "direct",
		});
	}

	agentRemoved(agentId: string): void {
		this.c().hub.broadcastApps(envelope("agents.update", { upsert: [], remove: [agentId] }));
	}

	machine(machineId: string): void {
		const { repos, hub, summaries } = this.c();
		const m = repos.machines.get(machineId);
		if (!m || m.revoked_at) return;
		hub.broadcastApps(envelope("machines.update", { upsert: [summaries.machine(m)], remove: [] }), {
			mode: "foreground",
		});
	}

	machineRemoved(machineId: string): void {
		const { hub } = this.c();
		hub.broadcastApps(envelope("machines.update", { upsert: [], remove: [machineId] }), { mode: "foreground" });
	}

	host(machineId: string): void {
		const { repos, hub } = this.c();
		const m = repos.machines.get(machineId);
		if (!m || m.revoked_at) return;
		const info = m.host_info ? (JSON.parse(m.host_info) as any) : {};
		const online = hub.hosts.has(machineId);
		hub.broadcastApps(
			envelope("hosts.update", {
				upsert: [
					{
						machineId,
						hostname: info.hostname ?? m.hostname ?? m.name,
						roots: info.roots ?? [],
						online,
						backends: info.backends ?? null,
						defaultBackend: info.defaultBackend ?? null,
						launchers: info.launchers ?? [],
						defaultLauncher: info.defaultLauncher ?? null,
					},
				],
				remove: [],
			}),
			{ mode: "foreground" },
		);
	}

	toApps(env: Envelope, mode?: "foreground" | "direct"): void {
		this.c().hub.broadcastApps(env, mode ? { mode } : {});
	}
}
