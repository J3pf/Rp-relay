import {
	type CommView,
	type Envelope,
	envelope,
	type MeshSnapshot,
	type SubagentUpdateEvent,
	type TodoTask,
} from "@j3pf/rp-protocol";
import type { Ctx } from "../../context.js";
import type { CommRow } from "../../db/repos/comms.js";
import { DAY } from "../../util/time.js";
import type { AppConn } from "../../ws/conn.js";
import { agentDisplayName } from "../agentNames.js";
import { buildMeshSnapshot, commEndpoints, MESH_EDGE_ACTIVE_MS } from "./topology.js";

const UPDATE_INTERVAL_MS = 500;
const SEEN_TTL_MS = DAY;
const SEEN_PRUNE_INTERVAL_MS = 60_000;
const MAX_SEEN_MESSAGES = 20_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_MATERIALIZED_AGENTS = 2_000;
const MAX_SUBAGENTS_PER_AGENT = 200;
const INITIATION_ACTIONS = new Set(["send", "ask", "handover", "message"]);

type CachedSnapshot = { snapshot: MeshSnapshot; generatedAt: number };
type CachedNodeMeta = { name: string; groupId: string | null };
type MaterializedAgentEvents = {
	epoch: string;
	todos?: TodoTask[];
	subagents: Map<string, SubagentUpdateEvent>;
};

type CommProjectionAgent = {
	id: string;
	machine_id?: string | null;
	session_name?: string | null;
	session_id?: string | null;
	cwd?: string | null;
	redacted?: number | null;
};

export function buildCommView(
	comm: CommRow,
	deps: {
		getAgent: (agentId: string) => CommProjectionAgent | undefined;
		getNode: (agentId: string) => { name?: string | null; groupId?: string | null } | undefined;
	},
): CommView {
	const { from: senderId, to: receiverId } = commEndpoints(comm);
	const sender = senderId ? deps.getAgent(senderId) : undefined;
	const receiver = receiverId ? deps.getAgent(receiverId) : undefined;
	const senderCandidate = sender ?? {
		session_name: comm.direction === "in" ? comm.peer_name : null,
		session_id: comm.direction === "in" ? comm.peer_session_id : null,
		cwd: comm.direction === "in" ? comm.peer_cwd : null,
		id: senderId ?? comm.comm_id,
	};
	const receiverCandidate = receiver ?? {
		session_name: comm.direction === "out" ? comm.peer_name : null,
		session_id: comm.direction === "out" ? comm.peer_session_id : null,
		cwd: comm.direction === "out" ? comm.peer_cwd : null,
		id: receiverId ?? comm.comm_id,
	};
	const senderNode = senderId ? deps.getNode(senderId) : undefined;
	const receiverNode = receiverId ? deps.getNode(receiverId) : undefined;
	return {
		commKey: comm.comm_id,
		fromAgentId: senderId,
		toAgentId: receiverId,
		fromName: senderNode?.name ?? agentDisplayName(senderCandidate),
		toName: receiverNode?.name ?? agentDisplayName(receiverCandidate),
		action: comm.action,
		text: sender?.redacted || receiver?.redacted ? null : comm.text,
		truncated: Boolean(comm.truncated),
		at: comm.at,
		groupId: senderNode?.groupId ?? receiverNode?.groupId ?? null,
	};
}

export class MeshService {
	private cache = new Map<string | null, CachedSnapshot>();
	private nodeMeta = new Map<string, CachedNodeMeta>();
	private agentEvents = new Map<string, MaterializedAgentEvents>();
	private updateTimer: NodeJS.Timeout | undefined;
	private activeExpiryTimer: NodeJS.Timeout | undefined;
	private lastUpdateAt = 0;
	private lastSeenPruneAt = 0;
	private listenerRegistered = false;
	private seenCommIds = new Map<string, number>();
	private seenMessageIds = new Map<string, number>();

	constructor(private c: () => Ctx) {}

	/** Subscribes an app and returns the fresh snapshot for the requested scope. */
	subscribe(conn: AppConn, machineId: string | null): MeshSnapshot {
		this.watchSubscriberChanges();
		this.c().hub.subscribeMesh(conn, machineId);
		this.cache.clear();
		return this.getSnapshot(machineId);
	}

	unsubscribe(conn: AppConn): void {
		this.c().hub.unsubscribeMesh(conn);
	}

	/** Incrementally updates materialized todo/subagent state for already-hydrated agents. */
	onEvent(agentId: string, epoch: string, event: { type: string; [key: string]: unknown }): void {
		if (event.type !== "todo_update" && event.type !== "subagent_update") return;
		const entry = this.agentEvents.get(agentId);
		if (!entry) return;
		if (entry.epoch !== epoch) {
			this.agentEvents.delete(agentId);
			return;
		}
		if (event.type === "todo_update" && Array.isArray(event.tasks)) {
			entry.todos = event.tasks as TodoTask[];
			return;
		}
		if (
			event.type === "subagent_update" &&
			typeof event.taskId === "string" &&
			event.taskId.length > 0 &&
			typeof event.status === "string"
		) {
			entry.subagents.delete(event.taskId);
			entry.subagents.set(event.taskId, event as SubagentUpdateEvent);
			if (entry.subagents.size > MAX_SUBAGENTS_PER_AGENT) {
				let evictKey: string | undefined;
				for (const [taskId, ev] of entry.subagents) {
					if (ev.status !== "running") {
						evictKey = taskId;
						break;
					}
				}
				evictKey ??= entry.subagents.keys().next().value;
				if (evictKey !== undefined) entry.subagents.delete(evictKey);
			}
		}
	}

	/** Clears cached per-agent materialized state on epoch change, archive, or purge. */
	clearAgent(agentId: string): void {
		this.agentEvents.delete(agentId);
		this.nodeMeta.delete(agentId);
	}

	/** Drops cached node display metadata (e.g. after session_info_changed or reconnect). */
	clearNodeMeta(agentId: string): void {
		this.nodeMeta.delete(agentId);
	}

	private getOrHydrateAgentEvents(agentId: string, epoch: string): MaterializedAgentEvents {
		const cached = this.agentEvents.get(agentId);
		if (cached && cached.epoch === epoch) {
			return cached;
		}
		const { repos } = this.c();
		let todos: TodoTask[] | undefined;
		const latestTodo = repos.events.latestByType(agentId, epoch, "todo_update");
		if (latestTodo) {
			try {
				const payload = JSON.parse(latestTodo.payload) as { type?: string; tasks?: TodoTask[] };
				if (payload.type === "todo_update" && Array.isArray(payload.tasks)) {
					todos = payload.tasks;
				}
			} catch {
				// ignore malformed persisted event
			}
		}
		const subagents = new Map<string, SubagentUpdateEvent>();
		for (const event of repos.events.listByTypes(agentId, epoch, ["subagent_update"], 1_000)) {
			let payload: { type?: string; taskId?: unknown; status?: unknown; [key: string]: unknown };
			try {
				payload = JSON.parse(event.payload) as typeof payload;
			} catch {
				continue;
			}
			if (
				payload.type === "subagent_update" &&
				typeof payload.taskId === "string" &&
				payload.taskId.length > 0 &&
				typeof payload.status === "string"
			) {
				subagents.delete(payload.taskId);
				subagents.set(payload.taskId, payload as SubagentUpdateEvent);
			}
		}
		const materialized: MaterializedAgentEvents = { epoch, todos, subagents };
		this.agentEvents.delete(agentId);
		this.agentEvents.set(agentId, materialized);
		while (this.agentEvents.size > MAX_MATERIALIZED_AGENTS) {
			const oldest = this.agentEvents.keys().next().value;
			if (oldest === undefined) break;
			this.agentEvents.delete(oldest);
		}
		return materialized;
	}

	getSnapshot(machineId: string | null): MeshSnapshot {
		const now = Date.now();
		const cachedEntry = this.cache.get(machineId);
		let snapshot = cachedEntry?.snapshot;
		if (cachedEntry) {
			this.cache.delete(machineId);
			this.cache.set(machineId, cachedEntry);
		}
		if (!snapshot) {
			const { repos, hub } = this.c();
			const machines = repos.machines.list();
			const activeMachineIds = new Set(machines.filter((m) => !m.revoked_at).map((m) => m.id));
			if (machineId !== null && !activeMachineIds.has(machineId)) {
				return {
					machineId,
					generatedAt: now,
					groups: [],
					nodes: [],
					edges: [],
				};
			}
			const agents = repos.agents
				.list()
				.filter((a) => activeMachineIds.has(a.machine_id) && (machineId === null || a.machine_id === machineId));
			const latestTodosByAgent: Record<string, TodoTask[]> = Object.create(null);
			const latestSubagentsByAgent: Record<string, SubagentUpdateEvent[]> = Object.create(null);
			for (const agent of agents) {
				const materialized = this.getOrHydrateAgentEvents(agent.id, agent.epoch);
				if (materialized.todos) {
					latestTodosByAgent[agent.id] = materialized.todos;
				}
				if (materialized.subagents.size > 0) {
					latestSubagentsByAgent[agent.id] = [...materialized.subagents.values()];
				}
			}
			const openPromptsByAgent: Record<string, number> = Object.create(null);
			for (const [agentId, count] of repos.prompts.countOpenByAgent()) {
				openPromptsByAgent[agentId] = count;
			}
			snapshot = buildMeshSnapshot({
				agents,
				machines,
				comms: repos.comms.listSince(now - DAY, machineId),
				now,
				onlineAgentIds: new Set(hub.agents.keys()),
				machineFilter: machineId,
				openPromptsByAgent,
				latestTodosByAgent,
				latestSubagentsByAgent,
			});
			for (const node of snapshot.nodes) {
				this.nodeMeta.set(node.agentId, { name: node.name, groupId: node.groupId });
			}
			if (machineId === null) {
				const activeAgentIds = new Set(agents.map((a) => a.id));
				for (const id of this.agentEvents.keys()) {
					if (!activeAgentIds.has(id)) this.agentEvents.delete(id);
				}
				for (const id of this.nodeMeta.keys()) {
					if (!activeAgentIds.has(id)) this.nodeMeta.delete(id);
				}
			}
			this.cache.set(machineId, { snapshot, generatedAt: snapshot.generatedAt });
			while (this.cache.size > MAX_CACHE_ENTRIES) {
				const oldest = this.cache.keys().next().value;
				if (oldest === undefined) break;
				this.cache.delete(oldest);
			}
			this.scheduleActiveExpiry(
				[...this.cache.values()].map((cached) => cached.snapshot),
				now,
			);
		}
		return {
			...snapshot,
			generatedAt: now,
			edges: snapshot.edges.map((edge) => ({
				...edge,
				active: now - edge.lastAt <= MESH_EDGE_ACTIVE_MS,
			})),
		};
	}

	invalidate(): void {
		this.cache.clear();
		const { hub } = this.c();
		if (!hub.hasMeshSubscribers()) return;
		this.scheduleUpdate();
	}

	/** Broadcasts a newly persisted comm to matching subscribers, suppressing duplicate message IDs. */
	onComm(comm: CommRow): void {
		const { hub, repos } = this.c();
		if (!hub.hasMeshSubscribers()) return;

		const { from: senderId, to: receiverId } = commEndpoints(comm);
		if (!senderId || !receiverId) return;
		const sender = repos.agents.get(senderId);
		const receiver = repos.agents.get(receiverId);
		if (!sender && !receiver) return;

		const now = Date.now();
		this.pruneSeen(now);
		const commKey = `${comm.agent_id}\u0000${comm.comm_id}`;
		const seenCommAt = this.seenCommIds.get(commKey);
		const seenMsgAt = comm.message_id !== null ? this.seenMessageIds.get(comm.message_id) : undefined;
		const isDuplicate =
			(seenCommAt !== undefined && now - seenCommAt <= SEEN_TTL_MS) ||
			(seenMsgAt !== undefined && now - seenMsgAt <= SEEN_TTL_MS);
		this.touchSeen(this.seenCommIds, commKey, now);
		if (comm.message_id !== null) this.touchSeen(this.seenMessageIds, comm.message_id, now);
		if (isDuplicate) return;

		const subscribers = [...hub.meshSubscribers()].filter(
			([, scope]) =>
				scope === null || scope === sender?.machine_id || scope === receiver?.machine_id || scope === comm.machine_id,
		);
		if (subscribers.length === 0) return;

		const senderMeta = this.nodeMeta.get(senderId);
		const receiverMeta = this.nodeMeta.get(receiverId);
		const existingGroupId = senderMeta?.groupId ?? receiverMeta?.groupId ?? null;
		const derivedGroupId =
			existingGroupId ??
			(INITIATION_ACTIONS.has(comm.action) ? senderId : `group-${senderId < receiverId ? senderId : receiverId}`);
		if (existingGroupId === null) {
			if (senderMeta) senderMeta.groupId = derivedGroupId;
			if (receiverMeta) receiverMeta.groupId = derivedGroupId;
		}
		const commView = buildCommView(comm, {
			getAgent: (agentId) =>
				agentId === senderId ? sender : agentId === receiverId ? receiver : repos.agents.get(agentId),
			getNode: (agentId) => {
				const meta = this.nodeMeta.get(agentId);
				return { name: meta?.name, groupId: meta?.groupId ?? derivedGroupId };
			},
		});
		const message = envelope("mesh.comm", { comm: commView });
		let raw: string | undefined;
		for (const [conn] of subscribers) {
			if (!conn.ready) continue;
			if (conn.sendSerialized) {
				raw ??= JSON.stringify(message);
				hub.sendAppSerialized(conn, raw, true);
			} else {
				hub.sendApp(conn, message, true);
			}
		}
	}

	dispose(): void {
		if (this.updateTimer) clearTimeout(this.updateTimer);
		this.updateTimer = undefined;
		this.clearActiveExpiryTimer();
		this.cache.clear();
		this.agentEvents.clear();
		this.nodeMeta.clear();
	}

	private watchSubscriberChanges(): void {
		if (this.listenerRegistered) return;
		this.listenerRegistered = true;
		this.c().hub.onMeshSubscribersChanged(() => {
			if (this.c().hub.hasMeshSubscribers()) return;
			if (this.updateTimer) clearTimeout(this.updateTimer);
			this.updateTimer = undefined;
			this.clearActiveExpiryTimer();
			this.cache.clear();
		});
	}

	private clearActiveExpiryTimer(): void {
		if (this.activeExpiryTimer) clearTimeout(this.activeExpiryTimer);
		this.activeExpiryTimer = undefined;
	}

	private scheduleActiveExpiry(snapshots: MeshSnapshot[], now = Date.now()): void {
		const { hub } = this.c();
		if (!hub.hasMeshSubscribers()) {
			this.clearActiveExpiryTimer();
			return;
		}

		let earliestExpiry = Number.POSITIVE_INFINITY;
		for (const snapshot of snapshots) {
			for (const edge of snapshot.edges) {
				if (now - edge.lastAt <= MESH_EDGE_ACTIVE_MS) {
					earliestExpiry = Math.min(earliestExpiry, edge.lastAt + MESH_EDGE_ACTIVE_MS + 1);
				}
			}
		}
		if (!Number.isFinite(earliestExpiry)) {
			this.clearActiveExpiryTimer();
			return;
		}

		this.clearActiveExpiryTimer();
		this.activeExpiryTimer = setTimeout(
			() => {
				this.activeExpiryTimer = undefined;
				this.scheduleUpdate();
				this.scheduleActiveExpiry(
					[...this.cache.values()].map((cached) => cached.snapshot),
					Date.now(),
				);
			},
			Math.max(1, earliestExpiry - now),
		);
		this.activeExpiryTimer.unref();
	}

	private scheduleUpdate(): void {
		if (this.updateTimer) return;
		const wait =
			this.lastUpdateAt === 0 ? UPDATE_INTERVAL_MS : Math.max(0, this.lastUpdateAt + UPDATE_INTERVAL_MS - Date.now());
		this.updateTimer = setTimeout(() => {
			this.updateTimer = undefined;
			this.flushUpdates();
		}, wait);
		this.updateTimer.unref();
	}

	private flushUpdates(): void {
		const { hub, log } = this.c();
		if (!hub.hasMeshSubscribers()) return;
		this.lastUpdateAt = Date.now();
		const subscribers = [...hub.meshSubscribers()];
		const payloads = new Map<string | null, { env: Envelope; raw?: string }>();
		for (const [conn, machineId] of subscribers) {
			if (!conn.ready) continue;
			try {
				let entry = payloads.get(machineId);
				if (!entry) {
					entry = { env: envelope("mesh.update", this.getSnapshot(machineId)) };
					payloads.set(machineId, entry);
				}
				if (conn.sendSerialized) {
					entry.raw ??= JSON.stringify(entry.env);
					hub.sendAppSerialized(conn, entry.raw, true);
				} else {
					hub.sendApp(conn, entry.env, true);
				}
			} catch (error) {
				log.warn({ err: (error as Error).message, machineId }, "no se pudo generar la actualización del mesh");
			}
		}
	}

	private touchSeen(seen: Map<string, number>, key: string, now: number): void {
		seen.delete(key);
		seen.set(key, now);
		while (seen.size > MAX_SEEN_MESSAGES) {
			const oldest = seen.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			seen.delete(oldest);
		}
	}

	private pruneSeen(now: number): void {
		if (now - this.lastSeenPruneAt < SEEN_PRUNE_INTERVAL_MS) return;
		this.lastSeenPruneAt = now;
		for (const seen of [this.seenCommIds, this.seenMessageIds]) {
			for (const [key, at] of seen) {
				if (now - at > SEEN_TTL_MS) seen.delete(key);
				else break;
			}
		}
	}
}
