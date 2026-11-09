import { type Envelope, envelope } from "@j3pf/rp-protocol";
import type { Ctx } from "../context.js";

/** Difusión de cambios de estado a las apps (machines.update, agents.update, hosts.update). */
export class Publisher {
	private lastDirectSignature = new Map<string, string>();

	constructor(private c: () => Ctx) {}

	agent(agentId: string): void {
		const { repos, hub, summaries } = this.c();
		const row = repos.agents.get(agentId);
		if (!row || row.archived_at !== null) return;
		const m = repos.machines.get(row.machine_id);
		if (m?.revoked_at) return;
		const s = summaries.agent(row);
		hub.broadcastApps(envelope("agents.update", { upsert: [s], remove: [] }), { mode: "foreground" });
		// el canal directo recibe actualizaciones cuando cambian estado, tarea activa o metadatos del agente
		const isWorking = s.status === "working" || s.status === "compacting";
		const directSig = JSON.stringify([
			s.status,
			s.activeTask,
			s.online,
			s.openPromptCount,
			s.sessionName,
			s.cwd,
			s.gitBranch,
			s.machineName,
			s.machineContext,
		]);
		if (this.lastDirectSignature.get(agentId) !== directSig) {
			this.lastDirectSignature.set(agentId, directSig);
			hub.broadcastApps(
				envelope("agents.update", {
					upsert: [{ ...s, lastMessagePreview: isWorking ? s.lastMessagePreview : null }],
					remove: [],
				}),
				{
					mode: "direct",
				},
			);
		}
	}

	agentRemoved(agentId: string): void {
		this.lastDirectSignature.delete(agentId);
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
		const { repos, hub, summaries } = this.c();
		const m = repos.machines.get(machineId);
		if (!m || m.revoked_at) return;
		hub.broadcastApps(
			envelope("hosts.update", {
				upsert: [summaries.host(m)],
				remove: [],
			}),
			{ mode: "foreground" },
		);
	}

	hostRemoved(machineId: string): void {
		this.c().hub.broadcastApps(envelope("hosts.update", { upsert: [], remove: [machineId] }), {
			mode: "foreground",
		});
	}

	toApps(env: Envelope, mode?: "foreground" | "direct"): void {
		this.c().hub.broadcastApps(env, mode ? { mode } : {});
	}
}
