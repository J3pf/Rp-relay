import { posix } from "node:path";
import type { MeshGroup, MeshNode, MeshSnapshot, SubagentUpdateEvent, TodoTask } from "@j3pf/rp-protocol";
import type { AgentRow } from "../../db/repos/agents.js";
import type { CommRow } from "../../db/repos/comms.js";
import type { MachineRow } from "../../db/repos/machines.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_MS = 20_000;
const INITIATION_ACTIONS = new Set(["send", "ask", "handover", "message"]);

type TopologyMessage = {
	fromAgentId: string;
	toAgentId: string;
	messageId: string | null;
	replyTo: string | null;
	action: CommRow["action"];
	text: string | null;
	at: number;
	commId: string;
};

type InternalEdge = {
	messages: TopologyMessage[];
};

export interface BuildTopologyOptions {
	agents: AgentRow[];
	machines: MachineRow[];
	comms: CommRow[];
	now?: number;
	openPromptsByAgent?: Record<string, number>;
	latestTodosByAgent?: Record<string, TodoTask[]>;
	latestSubagentsByAgent?: Record<string, SubagentUpdateEvent[]>;
	machineFilter?: string | null;
}

function endpoints(comm: CommRow): { from: string; to: string } | null {
	const peerId = comm.peer_agent_id;
	if (!peerId) return null;
	return comm.direction === "out" ? { from: comm.agent_id, to: peerId } : { from: peerId, to: comm.agent_id };
}

function compareRows(a: CommRow, b: CommRow): number {
	if (a.direction !== b.direction) return a.direction === "out" ? -1 : 1;
	if (a.at !== b.at) return b.at - a.at;
	return a.comm_id.localeCompare(b.comm_id);
}

function mergeMessageRows(rows: CommRow[]): TopologyMessage | null {
	const ordered = [...rows].sort(compareRows);
	const primary = ordered[0];
	if (!primary) return null;
	const primaryEndpoints = endpoints(primary);
	const fromAgentId = primaryEndpoints?.from ?? (primary.direction === "out" ? primary.agent_id : undefined);
	const toAgentId =
		primaryEndpoints?.to ??
		(primary.direction === "out"
			? ordered.find((row) => row.direction === "in" && row.peer_agent_id === primary.agent_id)?.agent_id
			: undefined);
	if (!fromAgentId || !toAgentId) return null;
	const replyTo = ordered.find((row) => row.reply_to !== null)?.reply_to ?? null;
	const text =
		ordered.find((row) => row.direction === primary.direction && row.text !== null)?.text ??
		ordered.find((row) => row.text !== null)?.text ??
		null;

	return {
		fromAgentId,
		toAgentId,
		messageId: primary.message_id,
		replyTo,
		action: primary.action,
		text,
		at: ordered.reduce((latest, row) => Math.max(latest, row.at), Number.NEGATIVE_INFINITY),
		commId: primary.comm_id,
	};
}

function deduplicateMessages(comms: CommRow[], agentIds: Set<string>): TopologyMessage[] {
	const byMessageId = new Map<string, CommRow[]>();
	const messages: TopologyMessage[] = [];
	for (const comm of comms) {
		if (comm.message_id === null) {
			const message = mergeMessageRows([comm]);
			if (message) messages.push(message);
			continue;
		}
		const rows = byMessageId.get(comm.message_id) ?? [];
		rows.push(comm);
		byMessageId.set(comm.message_id, rows);
	}
	for (const rows of byMessageId.values()) {
		const message = mergeMessageRows(rows);
		if (message) messages.push(message);
	}

	return messages
		.filter(
			(message) =>
				agentIds.has(message.fromAgentId) &&
				agentIds.has(message.toAgentId) &&
				message.fromAgentId !== message.toAgentId,
		)
		.sort(
			(a, b) =>
				a.at - b.at ||
				(a.messageId ?? a.commId).localeCompare(b.messageId ?? b.commId) ||
				a.fromAgentId.localeCompare(b.fromAgentId) ||
				a.toAgentId.localeCompare(b.toAgentId),
		);
}

function edgeKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function connectedComponents(edges: Map<string, InternalEdge>): string[][] {
	const neighbors = new Map<string, Set<string>>();
	for (const key of edges.keys()) {
		const [a, b] = key.split("|");
		if (!a || !b) continue;
		(neighbors.get(a) ?? neighbors.set(a, new Set()).get(a)!).add(b);
		(neighbors.get(b) ?? neighbors.set(b, new Set()).get(b)!).add(a);
	}
	const components: string[][] = [];
	const visited = new Set<string>();
	for (const start of [...neighbors.keys()].sort()) {
		if (visited.has(start)) continue;
		const component: string[] = [];
		const queue = [start];
		visited.add(start);
		while (queue.length > 0) {
			const current = queue.pop()!;
			component.push(current);
			for (const neighbor of neighbors.get(current) ?? []) {
				if (visited.has(neighbor)) continue;
				visited.add(neighbor);
				queue.push(neighbor);
			}
		}
		components.push(component.sort());
	}
	return components;
}

function commonCwd(agents: AgentRow[]): string | null {
	const paths = agents
		.map((agent) => agent.cwd)
		.filter((cwd): cwd is string => Boolean(cwd))
		.map(posix.normalize);
	if (paths.length === 0) return null;
	const firstParts = paths[0]!.split("/");
	let commonParts = firstParts;
	for (const cwd of paths.slice(1)) {
		const parts = cwd.split("/");
		let length = 0;
		while (length < commonParts.length && length < parts.length && commonParts[length] === parts[length]) length++;
		commonParts = commonParts.slice(0, length);
	}
	const common = commonParts.join("/");
	return common || (paths.every((cwd) => cwd.startsWith("/")) ? "/" : null);
}

function cwdDepth(cwd: string): number {
	return posix.normalize(cwd).split("/").filter(Boolean).length;
}

function isStrictAncestor(parent: string, child: string): boolean {
	const relative = posix.relative(posix.normalize(parent), posix.normalize(child));
	return (
		relative !== "" &&
		relative !== "." &&
		relative !== ".." &&
		!relative.startsWith(`..${posix.sep}`) &&
		!posix.isAbsolute(relative)
	);
}

function todoSummary(tasks: TodoTask[] | undefined): MeshNode["todos"] {
	if (!tasks?.length) return null;
	return {
		total: tasks.length,
		done: tasks.filter((task) => task.status === "done").length,
		inProgress: tasks.filter((task) => task.status === "in_progress").length,
		blocked: tasks.filter((task) => task.status === "blocked").length,
		pending: tasks.filter((task) => task.status === "pending").length,
		current: tasks.find((task) => task.status === "in_progress")?.title ?? null,
	};
}

function latestSubagents(events: SubagentUpdateEvent[] | undefined): MeshNode["subagents"] {
	if (!events?.length) return [];
	const latestByTask = new Map<string, { event: SubagentUpdateEvent; index: number }>();
	for (const [index, event] of events.entries()) latestByTask.set(event.taskId, { event, index });
	return [...latestByTask.values()]
		.sort(
			(a, b) =>
				Number(b.event.status === "running") - Number(a.event.status === "running") ||
				b.index - a.index ||
				a.event.taskId.localeCompare(b.event.taskId),
		)
		.slice(0, 10)
		.map(({ event }) => {
			const { type: _type, ...subagent } = event;
			return subagent;
		});
}

function nodeName(agent: AgentRow): string {
	return agent.session_name || agent.session_id || agent.id;
}

function compareInitiators(
	a: AgentRow,
	b: AgentRow,
	stats: Map<string, { distinctPeers: number; total: number }>,
): number {
	const aStats = stats.get(a.id)!;
	const bStats = stats.get(b.id)!;
	return (
		bStats.distinctPeers - aStats.distinctPeers ||
		bStats.total - aStats.total ||
		a.first_seen_at - b.first_seen_at ||
		a.id.localeCompare(b.id)
	);
}

function cycleWouldForm(nodeId: string, parentId: string, parents: Map<string, string | null>): boolean {
	const seen = new Set<string>();
	let current: string | null | undefined = parentId;
	while (current) {
		if (current === nodeId || seen.has(current)) return true;
		seen.add(current);
		current = parents.get(current);
	}
	return false;
}

function commsParents(
	members: AgentRow[],
	messages: TopologyMessage[],
	orchestratorId: string | null,
): Map<string, string | null> {
	const ids = new Set(members.map((agent) => agent.id));
	const initiated = new Map<string, Map<string, number>>();
	const totals = new Map<string, number>();
	for (const message of messages) {
		if (!INITIATION_ACTIONS.has(message.action)) continue;
		if (!ids.has(message.fromAgentId) || !ids.has(message.toAgentId)) continue;
		const outgoing = initiated.get(message.fromAgentId) ?? new Map<string, number>();
		outgoing.set(message.toAgentId, (outgoing.get(message.toAgentId) ?? 0) + 1);
		initiated.set(message.fromAgentId, outgoing);
		totals.set(message.fromAgentId, (totals.get(message.fromAgentId) ?? 0) + 1);
	}
	const agentById = new Map(members.map((agent) => [agent.id, agent]));
	const parents = new Map<string, string | null>(members.map((agent) => [agent.id, null]));
	const childInitiators = new Map<string, { id: string; count: number }[]>();
	for (const [from, destinations] of initiated) {
		for (const [to, count] of destinations) {
			const candidates = childInitiators.get(to) ?? [];
			candidates.push({ id: from, count });
			childInitiators.set(to, candidates);
		}
	}
	const totalInitiationsById = new Map(members.map((agent) => [agent.id, totals.get(agent.id) ?? 0]));
	const compareParentCandidates = (a: { id: string; count: number }, b: { id: string; count: number }) => {
		const aAgent = agentById.get(a.id)!;
		const bAgent = agentById.get(b.id)!;
		return (
			b.count - a.count ||
			Number(b.id === orchestratorId) - Number(a.id === orchestratorId) ||
			totalInitiationsById.get(b.id)! - totalInitiationsById.get(a.id)! ||
			aAgent.first_seen_at - bAgent.first_seen_at ||
			a.id.localeCompare(b.id)
		);
	};

	if (orchestratorId) parents.set(orchestratorId, null);
	for (const agent of [...members].sort((a, b) => a.id.localeCompare(b.id))) {
		if (agent.id === orchestratorId) continue;
		const candidates = (childInitiators.get(agent.id) ?? []).sort(compareParentCandidates);
		for (const candidate of candidates) {
			if (candidate.id === orchestratorId || !cycleWouldForm(agent.id, candidate.id, parents)) {
				parents.set(agent.id, candidate.id);
				break;
			}
		}
	}
	return parents;
}

function commsGroup(
	members: AgentRow[],
	messages: TopologyMessage[],
): { group: MeshGroup; parents: Map<string, string | null>; roles: Map<string, MeshNode["role"]> } {
	const stats = new Map<string, { distinctPeers: number; total: number }>();
	const distinctPeers = new Map<string, Set<string>>();
	const totalInitiations = new Map<string, number>();
	for (const message of messages) {
		if (!INITIATION_ACTIONS.has(message.action)) continue;
		const peers = distinctPeers.get(message.fromAgentId) ?? new Set<string>();
		peers.add(message.toAgentId);
		distinctPeers.set(message.fromAgentId, peers);
		totalInitiations.set(message.fromAgentId, (totalInitiations.get(message.fromAgentId) ?? 0) + 1);
	}
	for (const member of members) {
		stats.set(member.id, {
			distinctPeers: distinctPeers.get(member.id)?.size ?? 0,
			total: totalInitiations.get(member.id) ?? 0,
		});
	}
	const eligible = members
		.filter((member) => (stats.get(member.id)?.total ?? 0) > 0)
		.sort((a, b) => compareInitiators(a, b, stats));
	const orchestrator = eligible[0] ?? null;
	const memberIds = members.map((member) => member.id).sort();
	const groupId = orchestrator?.id ?? `group-${memberIds[0]}`;
	const label = orchestrator?.session_name || posix.basename(commonCwd(members) ?? "") || "Mesh Group";
	const parents = commsParents(members, messages, orchestrator?.id ?? null);
	const roles = new Map<string, MeshNode["role"]>();
	for (const member of members) {
		roles.set(
			member.id,
			member.id === orchestrator?.id ? "orchestrator" : parents.get(member.id) ? "subordinate" : "solo",
		);
	}
	return {
		group: {
			groupId,
			label,
			orchestratorAgentId: orchestrator?.id ?? null,
			machineIds: [...new Set(members.map((member) => member.machine_id))].sort(),
			memberAgentIds: memberIds,
			confidence: "comms",
		},
		parents,
		roles,
	};
}

function cwdGroups(members: AgentRow[]): {
	groups: MeshGroup[];
	parents: Map<string, string | null>;
	roles: Map<string, MeshNode["role"]>;
} {
	const eligible = members.filter((agent) => Boolean(agent.cwd));
	const neighbors = new Map<string, Set<string>>();
	for (const a of eligible) {
		for (const b of eligible) {
			if (a.id === b.id || a.machine_id !== b.machine_id || !isStrictAncestor(a.cwd!, b.cwd!)) continue;
			(neighbors.get(a.id) ?? neighbors.set(a.id, new Set()).get(a.id)!).add(b.id);
			(neighbors.get(b.id) ?? neighbors.set(b.id, new Set()).get(b.id)!).add(a.id);
		}
	}
	const groups: MeshGroup[] = [];
	const parents = new Map<string, string | null>();
	const roles = new Map<string, MeshNode["role"]>();
	const byId = new Map(eligible.map((agent) => [agent.id, agent]));
	const visited = new Set<string>();
	for (const start of [...neighbors.keys()].sort()) {
		if (visited.has(start)) continue;
		const ids: string[] = [];
		const queue = [start];
		visited.add(start);
		while (queue.length) {
			const current = queue.pop()!;
			ids.push(current);
			for (const next of neighbors.get(current) ?? []) {
				if (visited.has(next)) continue;
				visited.add(next);
				queue.push(next);
			}
		}
		const component = ids.map((id) => byId.get(id)!).sort((a, b) => a.id.localeCompare(b.id));
		if (component.length < 2) continue;
		const roots = component
			.filter(
				(agent) =>
					!component.some((other) => other.machine_id === agent.machine_id && isStrictAncestor(other.cwd!, agent.cwd!)),
			)
			.sort(
				(a, b) => cwdDepth(a.cwd!) - cwdDepth(b.cwd!) || a.first_seen_at - b.first_seen_at || a.id.localeCompare(b.id),
			);
		const root = roots[0]!;
		const memberIds = component.map((agent) => agent.id).sort();
		for (const member of component) {
			if (member.id === root.id) {
				parents.set(member.id, null);
				roles.set(member.id, "orchestrator");
				continue;
			}
			const ancestors = component
				.filter(
					(other) =>
						other.id !== member.id &&
						other.machine_id === member.machine_id &&
						isStrictAncestor(other.cwd!, member.cwd!),
				)
				.sort(
					(a, b) =>
						cwdDepth(b.cwd!) - cwdDepth(a.cwd!) || a.first_seen_at - b.first_seen_at || a.id.localeCompare(b.id),
				);
			const parentId = ancestors[0]?.id ?? root.id;
			parents.set(member.id, parentId);
			roles.set(member.id, "subordinate");
		}
		groups.push({
			groupId: root.id,
			label: root.session_name || posix.basename(posix.normalize(root.cwd!)) || "Mesh Group",
			orchestratorAgentId: root.id,
			machineIds: [...new Set(component.map((agent) => agent.machine_id))].sort(),
			memberAgentIds: memberIds,
			confidence: "cwd",
		});
	}
	return { groups, parents, roles };
}

export function buildMeshSnapshot(options: BuildTopologyOptions): MeshSnapshot {
	const now = options.now ?? Date.now();
	const machineFilter = options.machineFilter ?? null;
	const agents = options.agents
		.filter((agent) => machineFilter === null || agent.machine_id === machineFilter)
		.sort((a, b) => a.id.localeCompare(b.id));
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	const machinesById = new Map(options.machines.map((machine) => [machine.id, machine]));
	const recentComms = options.comms.filter((comm) => comm.at >= now - DAY_MS);
	const messages = deduplicateMessages(recentComms, new Set(agentsById.keys()));
	const edgesById = new Map<string, InternalEdge>();
	for (const message of messages) {
		const key = edgeKey(message.fromAgentId, message.toAgentId);
		const edge = edgesById.get(key) ?? { messages: [] };
		edge.messages.push(message);
		edgesById.set(key, edge);
	}

	const components = connectedComponents(edgesById);
	const groups: MeshGroup[] = [];
	const groupIdByAgent = new Map<string, string>();
	const roleByAgent = new Map<string, MeshNode["role"]>();
	const parentByAgent = new Map<string, string | null>();
	for (const ids of components) {
		const members = ids.map((id) => agentsById.get(id)!).filter(Boolean);
		const componentMessages = messages.filter(
			(message) => ids.includes(message.fromAgentId) && ids.includes(message.toAgentId),
		);
		const topology = commsGroup(members, componentMessages);
		groups.push(topology.group);
		for (const member of members) {
			groupIdByAgent.set(member.id, topology.group.groupId);
			roleByAgent.set(member.id, topology.roles.get(member.id) ?? "solo");
			parentByAgent.set(member.id, topology.parents.get(member.id) ?? null);
		}
	}

	const noComms = agents.filter((agent) => !groupIdByAgent.has(agent.id));
	const cwd = cwdGroups(noComms);
	groups.push(...cwd.groups);
	for (const [id, role] of cwd.roles) {
		roleByAgent.set(id, role);
		parentByAgent.set(id, cwd.parents.get(id) ?? null);
		const group = cwd.groups.find((candidate) => candidate.memberAgentIds.includes(id));
		if (group) groupIdByAgent.set(id, group.groupId);
	}
	for (const agent of agents) {
		if (roleByAgent.has(agent.id)) continue;
		roleByAgent.set(agent.id, "solo");
		parentByAgent.set(agent.id, null);
	}

	const lastCommAtByAgent = new Map<string, number>();
	for (const message of messages) {
		lastCommAtByAgent.set(
			message.fromAgentId,
			Math.max(lastCommAtByAgent.get(message.fromAgentId) ?? -Infinity, message.at),
		);
		lastCommAtByAgent.set(
			message.toAgentId,
			Math.max(lastCommAtByAgent.get(message.toAgentId) ?? -Infinity, message.at),
		);
	}

	const edges = [...edgesById.entries()]
		.map(([id, edge]) => {
			const [a, b] = id.split("|") as [string, string];
			const orderedMessages = [...edge.messages].sort(
				(x, y) =>
					x.at - y.at ||
					(x.messageId ?? x.commId).localeCompare(y.messageId ?? y.commId) ||
					x.fromAgentId.localeCompare(y.fromAgentId),
			);
			const latest = orderedMessages[orderedMessages.length - 1]!;
			const replies = new Set(
				orderedMessages
					.filter((message) => message.action === "reply" && message.replyTo !== null)
					.map((message) => message.replyTo!),
			);
			const asks = orderedMessages.filter((message) => message.action === "ask");
			const latestSender = agentsById.get(latest.fromAgentId);
			const latestPreview = latestSender?.redacted ? null : latest.text === null ? null : latest.text.slice(0, 140);
			return {
				edgeId: id,
				a,
				b,
				count: orderedMessages.length,
				aToB: orderedMessages.filter((message) => message.fromAgentId === a && message.toAgentId === b).length,
				bToA: orderedMessages.filter((message) => message.fromAgentId === b && message.toAgentId === a).length,
				lastAt: latest.at,
				lastFrom: latest.fromAgentId,
				lastAction: latest.action,
				lastPreview: latestPreview,
				pendingAsk: asks.some((message) => !message.messageId || !replies.has(message.messageId)),
				active: now - latest.at <= ACTIVE_MS,
			};
		})
		.sort((a, b) => a.edgeId.localeCompare(b.edgeId));

	const nodes: MeshNode[] = agents.map((agent) => {
		const machine = machinesById.get(agent.machine_id);
		const redacted = Boolean(agent.redacted);
		return {
			agentId: agent.id,
			machineId: agent.machine_id,
			machineName: machine?.name ?? agent.machine_id,
			machineColor: machine?.color ?? "#808080",
			name: nodeName(agent),
			cwd: agent.cwd,
			gitBranch: agent.git_branch,
			model: agent.model,
			status: agent.status as MeshNode["status"],
			activity: redacted ? null : agent.last_preview,
			online: Boolean(agent.online),
			role: roleByAgent.get(agent.id) ?? "solo",
			parentAgentId: parentByAgent.get(agent.id) ?? null,
			groupId: groupIdByAgent.get(agent.id) ?? null,
			todos: todoSummary(options.latestTodosByAgent?.[agent.id]),
			subagents: latestSubagents(options.latestSubagentsByAgent?.[agent.id]),
			lastCommAt: lastCommAtByAgent.get(agent.id) ?? null,
			openPromptCount: Math.max(0, Math.trunc(options.openPromptsByAgent?.[agent.id] ?? 0)),
		};
	});

	return {
		machineId: machineFilter,
		generatedAt: now,
		groups: groups.sort((a, b) => a.groupId.localeCompare(b.groupId)),
		nodes,
		edges,
	};
}
