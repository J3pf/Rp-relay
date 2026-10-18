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
		if (/^[0-9a-fA-F]+$/.test(withoutHyphens) && withoutHyphens.length >= 8) {
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
