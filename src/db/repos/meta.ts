import { ulid } from "ulid";
import type { DB } from "../index.js";

export class MetaRepo {
	constructor(private db: DB) {}
	get(key: string): string | undefined {
		return (this.db.prepare("SELECT value FROM relay_meta WHERE key=?").get(key) as { value: string } | undefined)
			?.value;
	}
	set(key: string, value: string): void {
		this.db
			.prepare("INSERT INTO relay_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
			.run(key, value);
	}
	/** `relayId` estable de esta instalación (las entidades lo llevan desde v1 para soportar varios relays). */
	relayId(): string {
		let id = this.get("relay_id");
		if (!id) {
			id = ulid();
			this.set("relay_id", id);
		}
		return id;
	}
}
