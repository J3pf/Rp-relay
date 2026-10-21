import type { AgentHello } from "@j3pf/rp-protocol";
import { type DB, stmt } from "../index.js";

export interface AgentRow {
	id: string;
	machine_id: string;
	kind: string;
	instance: string;
	epoch: string;
	session_id: string;
	session_name: string | null;
	session_file: string | null;
	launcher: string | null;
	herdr: string | null;
	gentle: string | null;
	gentle_mode: string | null;
	statuses: string | null;
	redacted: number;
	spawn_id: string | null;
	cwd: string | null;
	git_branch: string | null;
	git_dirty: number | null;
	model: string | null;
	thinking: string | null;
	status: string;
	status_detail: string | null;
	online: number;
	pid: number | null;
	pi_version: string | null;
	plugin_version: string | null;
	features: string | null;
	transport: string | null;
	last_seq: number;
	last_preview: string | null;
	first_seen_at: number;
	last_seen_at: number;
}

const j = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

export class AgentsRepo {
	private deleteTx?: (id: string) => void;
	constructor(private db: DB) {}
	get(id: string): AgentRow | undefined {
		return stmt(this.db, "SELECT * FROM agents WHERE id=?").get(id) as AgentRow | undefined;
	}
	list(): AgentRow[] {
		return stmt(this.db, "SELECT * FROM agents ORDER BY last_seen_at DESC").all() as AgentRow[];
	}
	byMachine(machineId: string): AgentRow[] {
		return stmt(this.db, "SELECT * FROM agents WHERE machine_id=?").all(machineId) as AgentRow[];
	}
	/** Inserta o actualiza el agente a partir de `agent.hello`; reinicia `last_seq` si cambia el epoch. */
	upsertFromHello(
		machineId: string,
		h: AgentHello,
		now: number,
	): { row: AgentRow; epochChanged: boolean; previousSeq: number } {
		const prev = this.get(h.agentId);
		const epochChanged = !prev || prev.epoch !== h.epoch;
		const gentleMode = h.gentle?.mode ?? null;
		const vals = [
			h.kind ?? "pi",
			h.instance,
			h.epoch,
			h.session.id,
			h.session.name ?? null,
			h.session.file ?? null,
			h.launcher ?? null,
			j(h.herdr),
			j(h.gentle),
			gentleMode,
			h.redacted ? 1 : 0,
			h.spawnId ?? null,
			h.cwd ?? null,
			h.git?.branch ?? null,
			h.git?.dirty === undefined ? null : h.git.dirty ? 1 : 0,
			h.model ? `${h.model.provider}/${h.model.id}` : null,
			h.thinking ?? null,
			h.status,
			h.host.pid ?? null,
			h.pi.version,
			h.plugin.version,
			JSON.stringify(h.plugin.features),
			h.transport ?? "ws",
		];
		if (!prev) {
			stmt(
				this.db,
				`INSERT INTO agents(id,machine_id,kind,instance,epoch,session_id,session_name,session_file,launcher,herdr,gentle,gentle_mode,redacted,spawn_id,
					 cwd,git_branch,git_dirty,model,thinking,status,pid,pi_version,plugin_version,features,transport,online,last_seq,first_seen_at,last_seen_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)`,
			).run(h.agentId, machineId, ...vals, now, now);
		} else {
			stmt(
				this.db,
				`UPDATE agents SET kind=?,instance=?,epoch=?,session_id=?,session_name=?,session_file=?,launcher=?,herdr=?,gentle=?,gentle_mode=?,redacted=?,spawn_id=?,
					 cwd=?,git_branch=?,git_dirty=?,model=?,thinking=?,status=?,status_detail=NULL,pid=?,pi_version=?,plugin_version=?,features=?,transport=?,
					 online=1,last_seq=CASE WHEN ? THEN 0 ELSE last_seq END,last_seen_at=CASE WHEN ? THEN ? ELSE last_seen_at END WHERE id=?`,
			).run(...vals, epochChanged ? 1 : 0, epochChanged ? 1 : 0, now, h.agentId);
		}
		return { row: this.get(h.agentId)!, epochChanged, previousSeq: prev && !epochChanged ? prev.last_seq : 0 };
	}
	setOffline(id: string, now: number): void {
		stmt(this.db, "UPDATE agents SET online=0, last_seen_at=COALESCE(last_seen_at, ?) WHERE id=?").run(now, id);
	}
	setAllOffline(now: number): number {
		return stmt(this.db, "UPDATE agents SET online=0, last_seen_at=COALESCE(last_seen_at, ?) WHERE online=1").run(now)
			.changes;
	}
	touch(id: string, now: number): void {
		stmt(this.db, "UPDATE agents SET last_seen_at=? WHERE id=?").run(now, id);
	}
	setSeq(id: string, seq: number): void {
		stmt(this.db, "UPDATE agents SET last_seq=MAX(last_seq, ?) WHERE id=?").run(seq, id);
	}
	setPreview(id: string, preview: string): void {
		stmt(this.db, "UPDATE agents SET last_preview=? WHERE id=?").run(preview, id);
	}
	setStatus(id: string, status: string, detail: string | null): void {
		stmt(this.db, "UPDATE agents SET status=?, status_detail=? WHERE id=?").run(status, detail, id);
	}
	setStatuses(id: string, items: Record<string, string | null>, gentleMode: string | null): void {
		stmt(this.db, "UPDATE agents SET statuses=?, gentle_mode=COALESCE(?, gentle_mode) WHERE id=?").run(
			JSON.stringify(items),
			gentleMode,
			id,
		);
	}
	setSession(id: string, name: string | null): void {
		stmt(this.db, "UPDATE agents SET session_name=? WHERE id=?").run(name, id);
	}
	setModel(id: string, model: string | null): void {
		stmt(this.db, "UPDATE agents SET model=? WHERE id=?").run(model, id);
	}
	setThinking(id: string, thinking: string | null): void {
		stmt(this.db, "UPDATE agents SET thinking=? WHERE id=?").run(thinking, id);
	}
	resetEpoch(id: string, epoch: string): void {
		stmt(this.db, "UPDATE agents SET epoch=?, last_seq=0 WHERE id=?").run(epoch, id);
	}
	delete(id: string): void {
		this.deleteTx ??= this.db.transaction((agentId: string) => {
			stmt(this.db, "DELETE FROM events WHERE agent_id=?").run(agentId);
			stmt(this.db, "DELETE FROM snapshots WHERE agent_id=?").run(agentId);
			stmt(this.db, "DELETE FROM prompts WHERE agent_id=? AND state NOT IN ('open','answered')").run(agentId);
			stmt(this.db, "DELETE FROM agents WHERE id=?").run(agentId);
		});
		this.deleteTx(id);
	}
	/** Agentes offline desde antes de `before` (con sus eventos). */
	purgeOffline(before: number): string[] {
		const ids = (
			stmt(
				this.db,
				"SELECT id FROM agents WHERE online=0 AND last_seen_at<? AND id NOT IN (SELECT agent_id FROM prompts WHERE state IN ('open','answered'))",
			).all(before) as { id: string }[]
		).map((r) => r.id);
		for (const id of ids) this.delete(id);
		return ids;
	}
	deleteByMachine(machineId: string): void {
		for (const a of this.byMachine(machineId)) this.delete(a.id);
	}
	counts(): Map<string, { total: number; online: number }> {
		const out = new Map<string, { total: number; online: number }>();
		for (const r of stmt(
			this.db,
			"SELECT machine_id, COUNT(*) AS total, SUM(online) AS online FROM agents GROUP BY machine_id",
		).all() as {
			machine_id: string;
			total: number;
			online: number;
		}[])
			out.set(r.machine_id, { total: r.total, online: r.online ?? 0 });
		return out;
	}
}
