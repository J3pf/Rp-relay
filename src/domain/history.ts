import type { Entry } from "@j3pf/rp-protocol";
import type { Ctx } from "../context.js";

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
		const snap = repos.events.snapshot(agentId, cur);
		const first = repos.events.firstSeq(agentId, cur);
		const limit = config.limits.eventsPerAgent;

		let entries: Entry[] = [];
		let from = 0;
		const canResume =
			sinceSeq !== null &&
			epoch === cur &&
			((first !== null && sinceSeq >= first - 1) ||
				(first === null && snap !== undefined && sinceSeq >= snap.seq) ||
				sinceSeq >= a.last_seq);
		if (canResume) {
			from = sinceSeq!;
		} else if (snap) {
			entries = snap.payload.entries as Entry[];
			from = snap.seq;
		}
		const rows = repos.events.since(agentId, cur, from, limit);
		let events = rows.map((r) => ({ seq: r.seq, ts: r.ts, e: JSON.parse(r.payload) as unknown }));

		let truncated = false;
		const size = () => Buffer.byteLength(JSON.stringify({ entries, events }));
		while (entries.length > 0 && size() > FRAME_BUDGET) {
			entries = entries.slice(Math.ceil(entries.length / 4));
			truncated = true;
		}
		while (events.length > 0 && size() > FRAME_BUDGET) {
			events = events.slice(Math.ceil(events.length / 4));
			truncated = true;
		}
		const out: HistoryResult = {
			agentId,
			epoch: cur,
			entries,
			events,
			liveFromSeq: Math.max(a.last_seq, hub.agents.get(agentId)?.lastSeq ?? 0),
			needsResync: !snap,
		};
		if (truncated) out.truncated = true;
		return out;
	}
}
