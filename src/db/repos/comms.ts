import { DAY } from "../../util/time.js";
import { type DB, stmt } from "../index.js";

export interface CommRow {
	agent_id: string;
	comm_id: string;
	machine_id: string;
	direction: "out" | "in";
	channel: "intercom" | "orchestrator";
	action: "send" | "ask" | "reply" | "handover" | "message";
	peer_session_id: string | null;
	peer_name: string | null;
	peer_cwd: string | null;
	peer_ref: string | null;
	peer_agent_id: string | null;
	message_id: string | null;
	reply_to: string | null;
	expects_reply: number;
	text: string | null;
	truncated: number;
	delivered: number | null;
	at: number;
	created_at: number;
	updated_at: number;
}

export interface CommInput {
	agent_id: string;
	comm_id: string;
	machine_id: string;
	direction: CommRow["direction"];
	channel: CommRow["channel"];
	action: CommRow["action"];
	peer_session_id: string | null;
	peer_name: string | null;
	peer_cwd: string | null;
	peer_ref: string | null;
	peer_agent_id?: string | null;
	message_id: string | null;
	reply_to: string | null;
	expects_reply: boolean;
	text: string | null;
	truncated: boolean;
	delivered: boolean | 0 | 1 | null;
	at: number;
}

export class CommsRepo {
	private pruneTx?: (retentionDays: number, maxRows: number, now: number) => number;
	constructor(private db: DB) {}

	upsert(comm: CommInput): CommRow {
		const now = Date.now();
		stmt(
			this.db,
			`INSERT INTO comms(
				agent_id, comm_id, machine_id, direction, channel, action,
				peer_session_id, peer_name, peer_cwd, peer_ref, peer_agent_id,
				message_id, reply_to, expects_reply, text, truncated, delivered,
				at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(agent_id, comm_id) DO UPDATE SET
				machine_id=excluded.machine_id,
				direction=excluded.direction,
				channel=excluded.channel,
				action=excluded.action,
				peer_session_id=COALESCE(excluded.peer_session_id, comms.peer_session_id),
				peer_name=COALESCE(excluded.peer_name, comms.peer_name),
				peer_cwd=COALESCE(excluded.peer_cwd, comms.peer_cwd),
				peer_ref=COALESCE(excluded.peer_ref, comms.peer_ref),
				peer_agent_id=COALESCE(excluded.peer_agent_id, comms.peer_agent_id),
				message_id=COALESCE(excluded.message_id, comms.message_id),
				reply_to=COALESCE(excluded.reply_to, comms.reply_to),
				expects_reply=excluded.expects_reply,
				text=COALESCE(excluded.text, comms.text),
				truncated=excluded.truncated,
				delivered=COALESCE(excluded.delivered, comms.delivered),
				at=excluded.at,
				updated_at=excluded.updated_at`,
		).run(
			comm.agent_id,
			comm.comm_id,
			comm.machine_id,
			comm.direction,
			comm.channel,
			comm.action,
			comm.peer_session_id,
			comm.peer_name,
			comm.peer_cwd,
			comm.peer_ref,
			comm.peer_agent_id ?? null,
			comm.message_id,
			comm.reply_to,
			comm.expects_reply ? 1 : 0,
			comm.text,
			comm.truncated ? 1 : 0,
			typeof comm.delivered === "boolean" ? Number(comm.delivered) : comm.delivered,
			comm.at,
			now,
			now,
		);
		return this.get(comm.agent_id, comm.comm_id)!;
	}

	get(agentId: string, commId: string): CommRow | undefined {
		return stmt(this.db, "SELECT * FROM comms WHERE agent_id=? AND comm_id=?").get(agentId, commId) as
			| CommRow
			| undefined;
	}

	listSince(sinceAt: number, machineId?: string | null): CommRow[] {
		if (machineId != null) {
			return stmt(this.db, "SELECT * FROM comms WHERE at>=? AND machine_id=? ORDER BY at DESC, comm_id DESC").all(
				sinceAt,
				machineId,
			) as CommRow[];
		}
		return stmt(this.db, "SELECT * FROM comms WHERE at>=? ORDER BY at DESC, comm_id DESC").all(sinceAt) as CommRow[];
	}

	listConversation(a: string, b: string, before?: number, limit = 50): CommRow[] {
		const beforeClause = before === undefined ? "" : " AND at<?";
		return stmt(
			this.db,
			`SELECT * FROM comms
			 WHERE ((agent_id=? AND peer_agent_id=?) OR (agent_id=? AND peer_agent_id=?))${beforeClause}
			 ORDER BY at DESC, comm_id DESC LIMIT ?`,
		).all(...(before === undefined ? [a, b, b, a, limit] : [a, b, b, a, before, limit])) as CommRow[];
	}

	listByAgent(agentId: string, limit = 50): CommRow[] {
		return stmt(this.db, "SELECT * FROM comms WHERE agent_id=? OR peer_agent_id=? ORDER BY at DESC LIMIT ?").all(
			agentId,
			agentId,
			limit,
		) as CommRow[];
	}

	listUnresolved(): CommRow[] {
		return stmt(
			this.db,
			"SELECT * FROM comms WHERE peer_agent_id IS NULL ORDER BY at DESC, comm_id DESC",
		).all() as CommRow[];
	}

	setPeerAgentId(agentId: string, commId: string, peerAgentId: string): void {
		stmt(this.db, "UPDATE comms SET peer_agent_id=?, updated_at=? WHERE agent_id=? AND comm_id=?").run(
			peerAgentId,
			Date.now(),
			agentId,
			commId,
		);
	}

	prune(retentionDays = 7, maxRows = 20_000, now = Date.now()): number {
		this.pruneTx ??= this.db.transaction((days: number, max: number, currentTime: number) => {
			let deleted = stmt(this.db, "DELETE FROM comms WHERE at<?").run(currentTime - days * DAY).changes;
			const remaining = (stmt(this.db, "SELECT COUNT(*) AS n FROM comms").get() as { n: number }).n;
			if (remaining > max) {
				deleted += stmt(
					this.db,
					`DELETE FROM comms WHERE rowid IN (
						SELECT rowid FROM comms ORDER BY at ASC, agent_id ASC, comm_id ASC LIMIT ?
					)`,
				).run(remaining - max).changes;
			}
			return deleted;
		});
		return this.pruneTx(retentionDays, maxRows, now);
	}
}
