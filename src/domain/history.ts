import type { Entry } from "@j3pf/rp-protocol";
import type { Ctx } from "../context.js";
import type { EventRow } from "../db/repos/events.js";

const FRAME_BUDGET = 900_000; // por debajo del máx. de 1 MiB por frame

export interface HistoryResult {
	agentId: string;
	epoch: string | null;
	entries: Entry[];
	events: { seq: number; ts: number; e: unknown }[];
	liveFromSeq: number;
	truncated?: boolean;
	needsResync: boolean;
}

/** Construye la respuesta de `agent.subscribe` (PLAN-RELAY §5.4). */
export class HistoryService {
	constructor(private c: () => Ctx) {}

	build(agentId: string, sinceSeq: number | null, epoch: string | null): HistoryResult {
		const { repos, config, hub } = this.c();
		const a = repos.agents.get(agentId)!;
		const cur = a.epoch;
		const snapMeta = repos.events.snapshotMeta(agentId, cur);
		const first = repos.events.firstSeq(agentId, cur);
		const limit = config.limits.eventsPerAgent;

		const snapPruned = Boolean(snapMeta?.pruned);
		const latestSeq = Math.max(a.last_seq, hub.agents.get(agentId)?.lastSeq ?? 0);
		const coversSnapshot = snapMeta === null || sinceSeq === null || sinceSeq >= snapMeta.seq;
		const canResume =
			sinceSeq !== null &&
			epoch === cur &&
			coversSnapshot &&
			((first !== null && sinceSeq >= first - 1 && (!snapPruned || sinceSeq >= first)) ||
				(first === null && snapMeta !== null && !snapPruned && sinceSeq >= snapMeta.seq && latestSeq <= snapMeta.seq) ||
				sinceSeq >= latestSeq);
		const from = canResume ? sinceSeq! : snapMeta ? snapMeta.seq : 0;

		const keptDesc: EventRow[] = [];
		let eventBytes = 0;
		let overflowed = false;
		let rowsBudgetExceeded = false;
		let seenRows = 0;
		for (const row of repos.events.iterateLatest(agentId, cur, from, limit + 1)) {
			seenRows++;
			if (seenRows > limit) {
				overflowed = true;
				break;
			}
			const rowSize = Buffer.byteLength(row.payload, "utf8") + 32;
			if (24 + eventBytes + rowSize > FRAME_BUDGET) {
				rowsBudgetExceeded = true;
				break;
			}
			keptDesc.push(row);
			eventBytes += rowSize;
		}
		keptDesc.reverse();

		let entries: Entry[] = [];
		let truncated =
			Boolean(snapMeta && !canResume && (snapMeta.truncated || snapPruned)) || overflowed || rowsBudgetExceeded;

		if (!canResume && snapMeta !== null && !overflowed && !rowsBudgetExceeded) {
			const snap = repos.events.snapshot(agentId, cur);
			if (snap) {
				const rawEntries = snap.payload.entries as Entry[];
				const entryBytes = rawEntries.map((e) => Buffer.byteLength(JSON.stringify(e), "utf8") + 1);
				let totalBytes = 24 + eventBytes;
				for (const b of entryBytes) totalBytes += b;
				let entryStart = 0;
				while (entryStart < rawEntries.length && totalBytes > FRAME_BUDGET) {
					totalBytes -= entryBytes[entryStart]!;
					entryStart++;
					truncated = true;
				}
				entries = entryStart > 0 ? rawEntries.slice(entryStart) : rawEntries;
			}
		}

		const events = keptDesc.map((r) => ({ seq: r.seq, ts: r.ts, e: JSON.parse(r.payload) as unknown }));
		const out: HistoryResult = {
			agentId,
			epoch: cur,
			entries,
			events,
			liveFromSeq: Math.max(a.last_seq, hub.agents.get(agentId)?.lastSeq ?? 0),
			needsResync: !snapMeta || snapPruned,
		};
		if (truncated) out.truncated = true;
		return out;
	}
}
