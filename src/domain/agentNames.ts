export interface AgentNameInput {
	session_name?: string | null;
	session_id?: string | null;
	id?: string | null;
	cwd?: string | null;
}

export interface AgentSnapshotCandidate extends AgentNameInput {
	id: string;
	machine_id: string;
	first_seen_at?: number;
}

const UUID_REGEX = /^({)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(})?$/i;
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const AUTO_SUBAGENT_REGEX = /^subagent(?:-chat)?-[0-9a-fA-F-]+$/i;
const RAW_HEX_REGEX = /^[0-9a-fA-F]{8,}$/;

export function basename(p: string | null | undefined): string | null {
	if (!p) return null;
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts.length ? parts[parts.length - 1]! : null;
}

export function isHumanName(name: string | null | undefined, agent?: AgentNameInput): boolean {
	if (!name || typeof name !== "string") return false;
	const trimmed = name.trim();
	if (trimmed.length === 0) return false;
	if (trimmed === "null" || trimmed === "undefined") return false;

	if (agent) {
		if (agent.session_id && (trimmed === agent.session_id || trimmed === agent.session_id.trim())) {
			return false;
		}
		if (agent.id) {
			const idTrimmed = agent.id.trim();
			if (trimmed === idTrimmed || trimmed === idTrimmed.split(":").pop()) {
				return false;
			}
		}
	}

	if (UUID_REGEX.test(trimmed)) return false;
	if (ULID_REGEX.test(trimmed)) return false;
	if (AUTO_SUBAGENT_REGEX.test(trimmed)) return false;
	if (RAW_HEX_REGEX.test(trimmed)) return false;

	if (trimmed.includes("-")) {
		const withoutHyphens = trimmed.replace(/-/g, "");
		if (/^[0-9a-fA-F]+$/.test(withoutHyphens) && withoutHyphens.length >= 8 && /\d/.test(withoutHyphens)) {
			return false;
		}
	}

	return true;
}

export function agentDisplayName(agent?: AgentNameInput | null): string {
	if (!agent) return "Agent";

	if (agent.session_name && isHumanName(agent.session_name, agent)) {
		return agent.session_name.trim();
	}

	const dirName = basename(agent.cwd);
	if (dirName && isHumanName(dirName)) {
		return dirName;
	}

	return "Agent";
}

export function disambiguateAgentNames<T extends AgentSnapshotCandidate>(agents: T[]): Map<string, string> {
	const result = new Map<string, string>();
	const byMachine = new Map<string, T[]>();

	for (const agent of agents) {
		const list = byMachine.get(agent.machine_id) ?? [];
		list.push(agent);
		byMachine.set(agent.machine_id, list);
	}

	for (const machineAgents of byMachine.values()) {
		const byBaseName = new Map<string, T[]>();
		for (const agent of machineAgents) {
			const base = agentDisplayName(agent);
			const list = byBaseName.get(base) ?? [];
			list.push(agent);
			byBaseName.set(base, list);
		}

		for (const [baseName, group] of byBaseName.entries()) {
			if (group.length === 1) {
				result.set(group[0]!.id, baseName);
				continue;
			}

			const sorted = [...group].sort(
				(a, b) => (a.first_seen_at ?? 0) - (b.first_seen_at ?? 0) || a.id.localeCompare(b.id),
			);

			sorted.forEach((agent, index) => {
				const suffix = index === 0 ? "" : ` (${index + 1})`;
				result.set(agent.id, `${baseName}${suffix}`);
			});
		}
	}

	return result;
}

export function commonCwdBasename(agents: AgentNameInput[]): string | null {
	const paths = agents
		.map((agent) => agent.cwd)
		.filter((cwd): cwd is string => Boolean(cwd))
		.map((cwd) => cwd.replace(/\\/g, "/").replace(/\/+/g, "/"));
	if (paths.length === 0) return null;
	const firstSegments = paths[0]!.split("/").filter(Boolean);
	let common = firstSegments;
	for (const p of paths.slice(1)) {
		const segments = p.split("/").filter(Boolean);
		let length = 0;
		while (length < common.length && length < segments.length && common[length] === segments[length]) {
			length++;
		}
		common = common.slice(0, length);
	}
	return common.length > 0 ? common[common.length - 1]! : null;
}

export function groupDisplayLabel(
	orchestrator: AgentNameInput | null | undefined,
	members: AgentNameInput[] = [],
): string {
	if (orchestrator?.session_name && isHumanName(orchestrator.session_name, orchestrator)) {
		return orchestrator.session_name.trim();
	}

	const allAgents = orchestrator ? [orchestrator, ...members] : members;
	const commonBase = commonCwdBasename(allAgents);
	if (commonBase && isHumanName(commonBase)) {
		return commonBase;
	}

	const orchName = orchestrator ? agentDisplayName(orchestrator) : null;
	if (orchName && orchName !== "Agent" && isHumanName(orchName)) {
		return orchName;
	}

	return "Mesh Group";
}
