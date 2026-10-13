import type { DB } from "../index.js";

export interface DeviceRow {
	id: string;
	name: string;
	token_hash: Buffer;
	push_key: Buffer;
	fcm_token: string | null;
	direct_enabled: number;
	notify_prefs: string;
	created_at: number;
	last_seen_at: number | null;
	revoked_at: number | null;
}

export class DevicesRepo {
	constructor(private db: DB) {}
	insert(d: {
		id: string;
		name: string;
		tokenHash: Buffer;
		pushKey: Buffer;
		fcmToken?: string | null;
		now: number;
	}): void {
		this.db
			.prepare(
				"INSERT INTO devices(id,name,token_hash,push_key,fcm_token,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)",
			)
			.run(d.id, d.name, d.tokenHash, d.pushKey, d.fcmToken ?? null, d.now, d.now);
	}
	byTokenHash(hash: Buffer): DeviceRow | undefined {
		return this.db.prepare("SELECT * FROM devices WHERE token_hash=?").get(hash) as DeviceRow | undefined;
	}
	get(id: string): DeviceRow | undefined {
		return this.db.prepare("SELECT * FROM devices WHERE id=?").get(id) as DeviceRow | undefined;
	}
	list(includeRevoked = false): DeviceRow[] {
		return this.db
			.prepare(`SELECT * FROM devices ${includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY created_at`)
			.all() as DeviceRow[];
	}
	active(): DeviceRow[] {
		return this.list(false);
	}
	touch(id: string, now: number): void {
		this.db.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").run(now, id);
	}
	revoke(id: string, now: number): boolean {
		return (
			this.db.prepare("UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now, id).changes > 0
		);
	}
	setPush(id: string, fcmToken: string | null | undefined, direct: boolean): void {
		if (fcmToken === undefined)
			this.db.prepare("UPDATE devices SET direct_enabled=? WHERE id=?").run(direct ? 1 : 0, id);
		else
			this.db.prepare("UPDATE devices SET fcm_token=?, direct_enabled=? WHERE id=?").run(fcmToken, direct ? 1 : 0, id);
	}
	clearFcm(id: string): void {
		this.db.prepare("UPDATE devices SET fcm_token=NULL WHERE id=?").run(id);
	}
	setPrefs(id: string, prefs: unknown): void {
		this.db.prepare("UPDATE devices SET notify_prefs=? WHERE id=?").run(JSON.stringify(prefs), id);
	}
}
