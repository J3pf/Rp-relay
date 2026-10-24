import { type CommView, envelope, type MeshSnapshot, type SubagentUpdateEvent, type TodoTask } from "@j3pf/rp-protocol";
import type { Ctx } from "../../context.js";
import type { CommRow } from "../../db/repos/comms.js";
import type { AppConn } from "../../ws/conn.js";
import { agentDisplayName } from "../agentNames.js";
import { buildMeshSnapshot } from "./topology.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const UPDATE_INTERVAL_MS = 500;
const SEEN_TTL_MS = DAY_MS;
const MAX_SEEN_MESSAGES = 20_000;

type CachedSnapshot = { snapshot: MeshSnapshot; generatedAt: number };

export class MeshService {
	private cache = new Map<string | null, CachedSnapshot>();
	private updateTimer: NodeJS.Timeout | undefined;
	private activeExpiryTimer: NodeJS.Timeout | undefined;
	private lastUpdateAt = 0;
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

	getSnapshot(machineId: string | null): MeshSnapshot {
		const now = Date.now();
		let snapshot = this.cache.get(machineId)?.snapshot;
		if (!snapshot) {
			const { repos } = this.c();
			const machines = repos.machines.list();
			const activeMachineIds = new Set(machines.filter((m) => !m.revoked_at).map((m) => m.id));
			const agents = repos.agents
				.list()
				.filter((a) => activeMachineIds.has(a.machine_id) && (machineId === null || a.machine_id === machineId));
			const latestTodosByAgent: Record<string, TodoTask[]> = Object.create(null);
			const latestSubagentsByAgent: Record<string, SubagentUpdateEvent[]> = Object.create(null);
			for (const agent of agents) {
				for (const event of repos.events.listByTypes(
					agent.id,
					agent.epoch,
					["todo_update", "subagent_update"],
					1_000,
				)) {
					let payload: { type?: string; tasks?: TodoTask[]; [key: string]: unknown };
					try {
						payload = JSON.parse(event.payload) as typeof payload;
					} catch {
						continue;
					}
					if (payload.type === "todo_update" && Array.isArray(payload.tasks)) {
						latestTodosByAgent[agent.id] = payload.tasks;
					} else if (
						payload.type === "subagent_update" &&
						typeof payload.taskId === "string" &&
						payload.taskId.length > 0 &&
						typeof payload.status === "string"
					) {
						let events = latestSubagentsByAgent[agent.id];
						if (!events) {
							events = [];
							latestSubagentsByAgent[agent.id] = events;
						}
						events.push(payload as SubagentUpdateEvent);
					}
				}
			}
			const openPromptsByAgent: Record<string, number> = Object.create(null);
			for (const prompt of repos.prompts.list(["open", "answered"])) {
				openPromptsByAgent[prompt.agent_id] = (openPromptsByAgent[prompt.agent_id] ?? 0) + 1;
			}
			snapshot = buildMeshSnapshot({
				agents,
				machines,
				comms: repos.comms.listSince(now - DAY_MS),
				now,
				machineFilter: machineId,
				openPromptsByAgent,
				latestTodosByAgent,
				latestSubagentsByAgent,
			});
			this.cache.set(machineId, { snapshot, generatedAt: snapshot.generatedAt });
			this.scheduleActiveExpiry([...this.cache.values()].map((cached) => cached.snapshot));
		}
		return {
			...snapshot,
			generatedAt: now,
			edges: snapshot.edges.map((edge) => ({
				...edge,
				active: now - edge.lastAt <= 20_000,
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

		const senderId = comm.direction === "out" ? comm.agent_id : comm.peer_agent_id;
		const receiverId = comm.direction === "out" ? comm.peer_agent_id : comm.agent_id;
		if (!senderId || !receiverId) return;
		const sender = repos.agents.get(senderId);
		const receiver = repos.agents.get(receiverId);
		if (!sender || !receiver) return;

		const now = Date.now();
		this.pruneSeen(now);
		const commKey = `${comm.agent_id}\u0000${comm.comm_id}`;
		if (this.seenCommIds.has(commKey) || (comm.message_id !== null && this.seenMessageIds.has(comm.message_id))) {
			this.seenCommIds.set(commKey, now);
			if (comm.message_id !== null) this.seenMessageIds.set(comm.message_id, now);
			return;
		}
		this.seenCommIds.set(commKey, now);
		if (comm.message_id !== null) this.seenMessageIds.set(comm.message_id, now);
		this.pruneSeen(now);

		const subscribers = [...hub.meshSubscribers()].filter(
			([, scope]) => scope === null || scope === sender.machine_id || scope === receiver.machine_id,
		);
		if (subscribers.length === 0) return;

		let snapshot = this.cache.get(null)?.snapshot;
		let senderNode = snapshot?.nodes.find((node) => node.agentId === senderId);
		let receiverNode = snapshot?.nodes.find((node) => node.agentId === receiverId);
		if (!snapshot || !senderNode || !receiverNode) {
			this.cache.delete(null);
			snapshot = this.getSnapshot(null);
			senderNode = snapshot.nodes.find((node) => node.agentId === senderId);
			receiverNode = snapshot.nodes.find((node) => node.agentId === receiverId);
		}
		const groupId = senderNode?.groupId ?? receiverNode?.groupId ?? null;
		const fromName = senderNode?.name ?? agentDisplayName(sender);
		const toName = receiverNode?.name ?? agentDisplayName(receiver);

		const commView: CommView = {
			commKey: comm.comm_id,
			fromAgentId: senderId,
			toAgentId: receiverId,
			fromName,
			toName,
			action: comm.action,
			text: sender.redacted ? null : comm.text,
			truncated: Boolean(comm.truncated),
			at: comm.at,
			groupId,
		};
		const message = envelope("mesh.comm", { comm: commView });
		for (const [conn] of subscribers) {
			if (!conn.ready) continue;
			hub.sendApp(conn, message, true);
		}
	}

	dispose(): void {
		if (this.updateTimer) clearTimeout(this.updateTimer);
		this.updateTimer = undefined;
		this.clearActiveExpiryTimer();
		this.cache.clear();
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

	private scheduleActiveExpiry(snapshots: MeshSnapshot[]): void {
		const { hub } = this.c();
		if (!hub.hasMeshSubscribers()) {
			this.clearActiveExpiryTimer();
			return;
		}

		let earliestExpiry = Number.POSITIVE_INFINITY;
		for (const snapshot of snapshots) {
			for (const edge of snapshot.edges) {
				if (edge.active) earliestExpiry = Math.min(earliestExpiry, edge.lastAt + 20_001);
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
				this.cache.clear();
				this.scheduleUpdate();
			},
			Math.max(1, earliestExpiry - Date.now()),
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
		const snapshots = new Map<string | null, MeshSnapshot>();
		for (const [conn, machineId] of subscribers) {
			if (!conn.ready) continue;
			try {
				let snapshot = snapshots.get(machineId);
				if (!snapshot) {
					snapshot = this.getSnapshot(machineId);
					snapshots.set(machineId, snapshot);
				}
				hub.sendApp(conn, envelope("mesh.update", snapshot), true);
			} catch (error) {
				log.warn({ err: (error as Error).message, machineId }, "no se pudo generar la actualización del mesh");
			}
		}
	}

	private pruneSeen(now: number): void {
		for (const seen of [this.seenCommIds, this.seenMessageIds]) {
			for (const [key, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(key);
			while (seen.size > MAX_SEEN_MESSAGES) {
				const oldest = seen.keys().next().value as string | undefined;
				if (oldest === undefined) break;
				seen.delete(oldest);
			}
		}
	}
}
