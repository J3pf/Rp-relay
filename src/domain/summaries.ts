import type { AgentSummary, MachineQuota, MachineSummary, Prompt, PromptOpen } from "@j3pf/rp-protocol";
import type { Ctx } from "../context.js";
import type { AgentRow, MachineRow, PromptRow } from "../db/repos/index.js";
import { agentDisplayName, basename, disambiguateAgentNames } from "./agentNames.js";

const parse = <T>(s: string | null): T | null => {
	if (!s) return null;
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
};

export { basename };

export class Summaries {
	constructor(private c: () => Ctx) {}

	agentLabel(a: AgentRow, namesForMachine?: Map<string, string>): string {
		if (namesForMachine) {
			return namesForMachine.get(a.id) ?? agentDisplayName(a);
		}
		const { repos } = this.c();
		const m = repos.machines.get(a.machine_id);
		if (!m || m.revoked_at) return agentDisplayName(a);
		const names = disambiguateAgentNames(repos.agents.byMachine(a.machine_id));
		return names.get(a.id) ?? agentDisplayName(a);
	}

	machine(
		m: MachineRow,
		counts?: Map<string, { total: number; online: number }>,
		openByAgent?: Map<string, number>,
	): MachineSummary {
		const { repos, hub } = this.c();
		const cs = counts ?? repos.agents.counts();
		const ob = openByAgent ?? repos.prompts.countOpenByAgent();
		const c = cs.get(m.id) ?? { total: 0, online: 0 };
		let open = 0;
		for (const a of repos.agents.byMachine(m.id)) open += ob.get(a.id) ?? 0;
		const hostOnline = hub.hosts.has(m.id);
		const agentOnline = hub.agentsOfMachine(m.id).length > 0;
		const quotas = m.quotas ? parse<MachineQuota[]>(m.quotas) : null;
		return {
			machineId: m.id,
			name: m.name,
			context: m.context,
			color: m.color,
			icon: m.icon,
			online: hostOnline || agentOnline,
			agentCount: c.total,
			openPromptCount: open,
			hostOnline,
			relayId: repos.meta.relayId(),
			quotas: quotas ?? undefined,
		};
	}

	agent(a: AgentRow, machine?: MachineRow, openByAgent?: Map<string, number>): AgentSummary {
		const { repos, hub } = this.c();
		const m = machine ?? repos.machines.get(a.machine_id)!;
		const open = openByAgent ? (openByAgent.get(a.id) ?? 0) : repos.prompts.countOpenForAgent(a.id);
		return {
			agentId: a.id,
			machineId: a.machine_id,
			machineName: m.name,
			machineContext: m.context,
			machineColor: m.color,
			sessionName: a.session_name,
			cwd: a.cwd,
			gitBranch: a.git_branch,
			model: a.model,
			status: a.status as AgentSummary["status"],
			online: hub.agents.has(a.id),
			lastSeenAt: a.last_seen_at,
			openPromptCount: open,
			lastMessagePreview: a.last_preview,
			launcher: a.launcher,
			herdr: parse(a.herdr),
			gentleMode: a.gentle_mode,
			redacted: a.redacted === 1,
			spawnedByHost: a.spawn_id !== null,
			kind: a.kind,
		};
	}

	prompt(
		p: PromptRow,
		batch?: {
			agents: Map<string, AgentRow | undefined>;
			machines: Map<string, MachineRow | undefined>;
			namesByMachine: Map<string, Map<string, string>>;
		},
	): Prompt {
		const { repos } = this.c();
		const a = batch ? batch.agents.get(p.agent_id) : repos.agents.get(p.agent_id);
		const m = a ? (batch ? batch.machines.get(a.machine_id) : repos.machines.get(a.machine_id)) : undefined;
		const body = parse<PromptOpen>(p.payload) ?? ({} as PromptOpen);
		let namesForMachine: Map<string, string> | undefined;
		if (batch && a && m && !m.revoked_at) {
			namesForMachine = batch.namesByMachine.get(a.machine_id);
			if (!namesForMachine) {
				namesForMachine = disambiguateAgentNames(repos.agents.byMachine(a.machine_id));
				batch.namesByMachine.set(a.machine_id, namesForMachine);
			}
		}
		return {
			...body,
			agentId: p.agent_id,
			state: p.state,
			createdAt: p.created_at,
			resolvedAt: p.resolved_at,
			machineId: a?.machine_id ?? "",
			machineName: m?.name ?? "",
			machineContext: m?.context ?? "personal",
			agentLabel: a ? this.agentLabel(a, namesForMachine) : agentDisplayName({ id: p.agent_id }),
		};
	}

	allMachines(): MachineSummary[] {
		const { repos } = this.c();
		const counts = repos.agents.counts();
		const ob = repos.prompts.countOpenByAgent();
		return repos.machines.list().map((m) => this.machine(m, counts, ob));
	}

	allAgents(): AgentSummary[] {
		const { repos } = this.c();
		const ob = repos.prompts.countOpenByAgent();
		const machines = new Map(repos.machines.list(true).map((m) => [m.id, m]));
		return repos.agents
			.list()
			.filter((a) => machines.get(a.machine_id) && !machines.get(a.machine_id)!.revoked_at)
			.map((a) => this.agent(a, machines.get(a.machine_id), ob));
	}

	openPrompts(): Prompt[] {
		const { repos } = this.c();
		const rows = repos.prompts.list(["open", "answered"]);
		if (rows.length === 0) return [];
		const batch = {
			agents: new Map<string, AgentRow | undefined>(),
			machines: new Map<string, MachineRow | undefined>(),
			namesByMachine: new Map<string, Map<string, string>>(),
		};
		for (const p of rows) {
			if (!batch.agents.has(p.agent_id)) {
				const a = repos.agents.get(p.agent_id);
				batch.agents.set(p.agent_id, a);
				if (a && !batch.machines.has(a.machine_id)) {
					batch.machines.set(a.machine_id, repos.machines.get(a.machine_id));
				}
			}
		}
		return rows.map((p) => this.prompt(p, batch));
	}
}
