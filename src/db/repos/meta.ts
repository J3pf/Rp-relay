import { ulid } from "ulid";
import { type DB, stmt } from "../index.js";

export class MetaRepo {
	private cachedRelayId?: string;
	constructor(private db: DB) {}
	get(key: string): string | undefined {
		return (stmt(this.db, "SELECT value FROM relay_meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
	}
	set(key: string, value: string): void {
		stmt(
			this.db,
			"INSERT INTO relay_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
		).run(key, value);
		if (key === "relay_id") this.cachedRelayId = value;
	}
	/** `relayId` estable de esta instalación (las entidades lo llevan desde v1 para soportar varios relays). */
	relayId(): string {
		if (this.cachedRelayId) return this.cachedRelayId;
		let id = this.get("relay_id");
		if (!id) {
			id = ulid();
			this.set("relay_id", id);
		}
		this.cachedRelayId = id;
		return id;
	}
}
