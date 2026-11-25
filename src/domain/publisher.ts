import { type AgentSummary, envelope } from "@j3pf/rp-protocol";
import type { Ctx } from "../context.js";

const DEFAULT_DIRECT_COSMETIC_MS = 5_000;

export interface PublisherOptions {
	directCosmeticMs?: number;
}

/** Difusión de cambios de estado a las apps (machines.update, agents.update, hosts.update). */
export class Publisher {
	private lastDirectCriticalSig = new Map<string, string>();
	private lastDirectCosmeticSig = new Map<string, string>();
	private pendingDirectCosmetic = new Set<string>();
	private cosmeticTimer: NodeJS.Timeout | undefined;
	private directCosmeticMs: number;

	constructor(
		private c: () => Ctx,
		opts: PublisherOptions = {},
	) {
		this.directCosmeticMs = opts.directCosmeticMs ?? DEFAULT_DIRECT_COSMETIC_MS;
	}

	setDirectCosmeticMs(ms: number): void {
		this.directCosmeticMs = Math.max(0, ms);
	}

	agent(agentId: string): void {
		const { repos, hub, summaries } = this.c();
		const row = repos.agents.get(agentId);
		if (!row || row.archived_at !== null) return;
		const m = repos.machines.get(row.machine_id);
		if (m?.revoked_at) return;
		const s = summaries.agent(row, m);
		hub.broadcastApps(envelope("agents.update", { upsert: [s], remove: [] }), { mode: "foreground" });

		if (!hub.hasApps({ mode: "direct" })) {
			if (this.lastDirectCriticalSig.size > 0 || this.pendingDirectCosmetic.size > 0) {
				this.clearDirectState();
			}
			return;
		}

		// el canal directo separa transiciones críticas (inmediatas) de progreso cosmético (coalescido y suprimido con pantalla apagada)
		const isWorking = s.status === "working" || s.status === "compacting";
		const directPreview = isWorking ? s.lastMessagePreview : null;
		const directSummary: AgentSummary = { ...s, lastMessagePreview: directPreview };

		const criticalSig = JSON.stringify([s.status, s.online, s.openPromptCount, s.redacted, s.sessionName, s.kind]);
		const cosmeticSig = JSON.stringify([
			s.activeTask ?? null,
			directPreview,
			s.cwd,
			s.gitBranch,
			s.machineName,
			s.machineContext,
		]);

		if (this.lastDirectCriticalSig.get(agentId) !== criticalSig) {
			this.lastDirectCriticalSig.set(agentId, criticalSig);
			this.lastDirectCosmeticSig.set(agentId, cosmeticSig);
			this.pendingDirectCosmetic.delete(agentId);
			if (this.pendingDirectCosmetic.size === 0 && this.cosmeticTimer) {
				clearTimeout(this.cosmeticTimer);
				this.cosmeticTimer = undefined;
			}
			hub.broadcastApps(envelope("agents.update", { upsert: [directSummary], remove: [] }), { mode: "direct" });
			return;
		}

		if (this.lastDirectCosmeticSig.get(agentId) !== cosmeticSig) {
			if (!hub.hasApps({ mode: "direct", screenOn: true })) {
				if (this.pendingDirectCosmetic.size > 0 || this.cosmeticTimer) {
					this.pendingDirectCosmetic.clear();
					if (this.cosmeticTimer) {
						clearTimeout(this.cosmeticTimer);
						this.cosmeticTimer = undefined;
					}
				}
				return;
			}
			this.lastDirectCosmeticSig.set(agentId, cosmeticSig);
			this.pendingDirectCosmetic.add(agentId);
			if (!this.cosmeticTimer) {
				this.cosmeticTimer = setTimeout(() => this.flushDirectCosmetic(), this.directCosmeticMs);
				this.cosmeticTimer.unref();
			}
		}
	}

	flushDirectCosmetic(): void {
		if (this.cosmeticTimer) {
			clearTimeout(this.cosmeticTimer);
			this.cosmeticTimer = undefined;
		}
		if (this.pendingDirectCosmetic.size === 0) return;
		const dirtyIds = [...this.pendingDirectCosmetic];
		this.pendingDirectCosmetic.clear();
		const { repos, hub, summaries } = this.c();
		if (!hub.hasApps({ mode: "direct", screenOn: true })) return;
		const upsert: AgentSummary[] = [];
		for (const id of dirtyIds) {
			const row = repos.agents.get(id);
			if (!row || row.archived_at !== null) continue;
			const m = repos.machines.get(row.machine_id);
			if (m?.revoked_at) continue;
			const s = summaries.agent(row, m);
			const isWorking = s.status === "working" || s.status === "compacting";
			upsert.push({ ...s, lastMessagePreview: isWorking ? s.lastMessagePreview : null });
		}
		if (upsert.length === 0) return;
		hub.broadcastApps(envelope("agents.update", { upsert, remove: [] }), {
			mode: "direct",
			screenOn: true,
		});
	}

	private clearDirectState(): void {
		if (this.cosmeticTimer) {
			clearTimeout(this.cosmeticTimer);
			this.cosmeticTimer = undefined;
		}
		this.lastDirectCriticalSig.clear();
		this.lastDirectCosmeticSig.clear();
		this.pendingDirectCosmetic.clear();
	}

	stop(): void {
		this.clearDirectState();
	}

	dispose(): void {
		this.stop();
	}

	agentRemoved(agentId: string): void {
		this.lastDirectCriticalSig.delete(agentId);
		this.lastDirectCosmeticSig.delete(agentId);
		this.pendingDirectCosmetic.delete(agentId);
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
}
