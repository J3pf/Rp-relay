import type { AgentSummary, MachineQuota, MachineSummary, Prompt, PromptOpen } from "@j3pf/rp-protocol";
import type { Ctx } from "../context.js";
import type { AgentRow, MachineRow, PromptRow } from "../db/repos/index.js";
import { agentDisplayName, basename } from "./agentNames.js";

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

	agentLabel(a: AgentRow): string {
		const snapshot = this.c().mesh.getSnapshot(null);
		const node = snapshot.nodes.find((n) => n.agentId === a.id);
		return node?.name ?? agentDisplayName(a);
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

	prompt(p: PromptRow): Prompt {
		const { repos } = this.c();
		const a = repos.agents.get(p.agent_id);
		const m = a ? repos.machines.get(a.machine_id) : undefined;
		const body = parse<PromptOpen>(p.payload) ?? ({} as PromptOpen);
		return {
			...body,
			agentId: p.agent_id,
			state: p.state,
			createdAt: p.created_at,
			resolvedAt: p.resolved_at,
			machineId: a?.machine_id ?? "",
			machineName: m?.name ?? "",
			machineContext: m?.context ?? "personal",
			agentLabel: a ? this.agentLabel(a) : agentDisplayName({ id: p.agent_id }),
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
		return this.c()
			.repos.prompts.list(["open", "answered"])
			.map((p) => this.prompt(p));
	}
}
