import type { DB } from "../index.js";

export interface MachineRow {
	id: string;
	name: string;
	hostname: string | null;
	token_hash: Buffer;
	context: string;
	color: string;
	icon: string | null;
	quiet_hours: string | null;
	host_info: string | null;
	created_at: number;
	last_seen_at: number | null;
	revoked_at: number | null;
}

export interface MachinePatchRow {
	name?: string;
	context?: string;
	color?: string;
	icon?: string | null;
	quietHours?: unknown;
}

const PALETTE = ["#4F7DF3", "#E5703A", "#3DAA6D", "#B05CE0", "#D9A21B", "#E0507A", "#2AA7B8"];

export class MachinesRepo {
	constructor(private db: DB) {}
	insert(m: { id: string; name: string; hostname: string; tokenHash: Buffer; context: string; now: number }): void {
		const count = (this.db.prepare("SELECT COUNT(*) AS n FROM machines").get() as { n: number }).n;
		const color = m.context === "work" ? "#E5703A" : PALETTE[count % PALETTE.length]!;
		this.db
			.prepare(
				"INSERT INTO machines(id,name,hostname,token_hash,context,color,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?)",
			)
			.run(m.id, m.name, m.hostname, m.tokenHash, m.context, color, m.now, m.now);
	}
	byTokenHash(hash: Buffer): MachineRow | undefined {
		return this.db.prepare("SELECT * FROM machines WHERE token_hash=?").get(hash) as MachineRow | undefined;
	}
	get(id: string): MachineRow | undefined {
		return this.db.prepare("SELECT * FROM machines WHERE id=?").get(id) as MachineRow | undefined;
	}
	list(includeRevoked = false): MachineRow[] {
		return this.db
			.prepare(`SELECT * FROM machines ${includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY created_at`)
			.all() as MachineRow[];
	}
	touch(id: string, now: number): void {
		this.db.prepare("UPDATE machines SET last_seen_at=? WHERE id=?").run(now, id);
	}
	revoke(id: string, now: number): boolean {
		return (
			this.db.prepare("UPDATE machines SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now, id).changes > 0
		);
	}
	patch(id: string, p: MachinePatchRow): boolean {
		const sets: string[] = [];
		const vals: unknown[] = [];
		const add = (col: string, v: unknown) => {
			sets.push(`${col}=?`);
			vals.push(v);
		};
		if (p.name !== undefined) add("name", p.name);
		if (p.context !== undefined) add("context", p.context);
		if (p.color !== undefined) add("color", p.color);
		if (p.icon !== undefined) add("icon", p.icon);
		if (p.quietHours !== undefined) add("quiet_hours", p.quietHours === null ? null : JSON.stringify(p.quietHours));
		if (sets.length === 0) return this.get(id) !== undefined;
		return (
			this.db.prepare(`UPDATE machines SET ${sets.join(", ")} WHERE id=? AND revoked_at IS NULL`).run(...vals, id)
				.changes > 0
		);
	}
	setHostInfo(id: string, info: unknown | null): void {
		this.db.prepare("UPDATE machines SET host_info=? WHERE id=?").run(info === null ? null : JSON.stringify(info), id);
	}
}
