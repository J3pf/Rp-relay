import { type DB, stmt } from "../index.js";

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
		stmt(
			this.db,
			"INSERT INTO devices(id,name,token_hash,push_key,fcm_token,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)",
		).run(d.id, d.name, d.tokenHash, d.pushKey, d.fcmToken ?? null, d.now, d.now);
	}
	byTokenHash(hash: Buffer): DeviceRow | undefined {
		return stmt(this.db, "SELECT * FROM devices WHERE token_hash=?").get(hash) as DeviceRow | undefined;
	}
	get(id: string): DeviceRow | undefined {
		return stmt(this.db, "SELECT * FROM devices WHERE id=?").get(id) as DeviceRow | undefined;
	}
	list(includeRevoked = false): DeviceRow[] {
		return stmt(
			this.db,
			`SELECT * FROM devices ${includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY created_at`,
		).all() as DeviceRow[];
	}
	active(): DeviceRow[] {
		return this.list(false);
	}
	touch(id: string, now: number): void {
		stmt(this.db, "UPDATE devices SET last_seen_at=? WHERE id=?").run(now, id);
	}
	revoke(id: string, now: number): boolean {
		return stmt(this.db, "UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now, id).changes > 0;
	}
	setPush(id: string, fcmToken: string | null | undefined, direct: boolean): void {
		if (fcmToken === undefined) stmt(this.db, "UPDATE devices SET direct_enabled=? WHERE id=?").run(direct ? 1 : 0, id);
		else stmt(this.db, "UPDATE devices SET fcm_token=?, direct_enabled=? WHERE id=?").run(fcmToken, direct ? 1 : 0, id);
	}
	clearFcm(id: string): void {
		stmt(this.db, "UPDATE devices SET fcm_token=NULL WHERE id=?").run(id);
	}
	setPrefs(id: string, prefs: unknown): void {
		stmt(this.db, "UPDATE devices SET notify_prefs=? WHERE id=?").run(JSON.stringify(prefs), id);
	}
}
