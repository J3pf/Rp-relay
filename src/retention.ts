import type { Ctx } from "./context.js";
import { DAY } from "./util/time.js";

export interface RetentionStats {
	events: number;
	agents: number;
	blobs: number;
	prompts: number;
	staleAnswered: number;
	codes: number;
	outbox: number;
	comms: number;
}

/** Retención (PLAN-RELAY §4): eventos, agentes offline, adjuntos, prompts cerrados, códigos y entregas push viejas. */
export async function runRetention(c: Ctx, now = Date.now()): Promise<RetentionStats> {
	const { repos, config, publisher, blobs } = c;
	const L = config.limits;
	const events = repos.events.prune(now - L.eventRetentionDays * DAY, L.eventsPerAgent);
	// no se purgan agentes con prompts abiertos o conectados
	const stale = repos.agents.purgeOffline(now - L.offlineAgentRetentionDays * DAY);
	for (const id of stale) publisher.agentRemoved(id);
	const staleAnswered = c.prompts.expireStaleAnswered(now - DAY);
	const prompts = repos.prompts.purgeClosed(now - L.promptRetentionDays * DAY);
	const codes = repos.pairing.purge(now - DAY);
	const outbox = repos.outbox.purge(now);
	const commsPruned = repos.comms.prune(7, 20_000, now);
	if (stale.length > 0 || commsPruned > 0 || staleAnswered > 0 || events > 0) {
		c.mesh.invalidate();
	}
	const blobsRemoved = await blobs.gc(now);
	return {
		events,
		agents: stale.length,
		blobs: blobsRemoved,
		prompts,
		staleAnswered,
		codes,
		outbox,
		comms: commsPruned,
	};
}
