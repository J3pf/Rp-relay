import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate, readMigrations } from "../src/db/migrate.js";

const PRESERVED_TABLES = [
	"relay_meta",
	"devices",
	"machines",
	"pairing_codes",
	"agents",
	"events",
	"snapshots",
	"prompts",
	"blobs",
	"blob_grants",
	"push_outbox",
	"comms",
] as const;

describe("migration 0006_apns_push", () => {
	let dir: string;
	let db: Database.Database;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rp-mig0006-"));
		db = new Database(join(dir, "relay.db"));
		db.pragma("journal_mode = WAL");
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("adds nullable APNs fields with an environment check and preserves existing rows", () => {
		const schema0005 = join(dir, "migrations-v0005");
		mkdirSync(schema0005);
		for (const migration of readMigrations(MIGRATIONS_DIR).filter((item) => item.version <= 5)) {
			writeFileSync(join(schema0005, migration.name), migration.sql);
		}
		expect(migrate(db, { dir: schema0005 })).toEqual([1, 2, 3, 4, 5]);

		const now = Date.now();
		db.prepare("INSERT INTO relay_meta(key, value) VALUES ('relayId', 'relay-1')").run();
		db.prepare(
			"INSERT INTO devices(id, name, token_hash, push_key, created_at, last_seen_at) VALUES ('d-1', 'Phone', ?, ?, ?, ?)",
		).run(Buffer.alloc(32), Buffer.alloc(32), now, now);
		db.prepare(
			"INSERT INTO machines(id, name, token_hash, context, created_at, last_seen_at) VALUES ('m-1', 'Machine', ?, 'work', ?, ?)",
		).run(Buffer.alloc(32), now, now);
		db.prepare(
			"INSERT INTO pairing_codes(code_hash, kind, expires_at, created_by) VALUES (?, 'device', ?, 'test')",
		).run(Buffer.alloc(32, 1), now + 60_000);
		db.prepare(
			"INSERT INTO agents(id, machine_id, kind, instance, epoch, session_id, session_name, status, online, first_seen_at, last_seen_at) VALUES ('m-1:a-1', 'm-1', 'pi', 'instance-1', 'epoch-1', 'session-1', 'Agent 1', 'working', 1, ?, ?)",
		).run(now, now);
		db.prepare(
			"INSERT INTO events(agent_id, epoch, seq, ts, type, payload) VALUES ('m-1:a-1', 'epoch-1', 1, ?, 'message_end', '{}')",
		).run(now);
		db.prepare("INSERT INTO snapshots(agent_id, epoch, seq, payload) VALUES ('m-1:a-1', 'epoch-1', 1, '{}')").run();
		db.prepare(
			"INSERT INTO prompts(id, agent_id, kind, category, payload, state, created_at) VALUES ('p-1', 'm-1:a-1', 'confirm', 'permission', '{}', 'open', ?)",
		).run(now);
		db.prepare("INSERT INTO blobs(id, sha256, size, created_at, expires_at) VALUES ('b-1', 'hash', 1, ?, ?)").run(
			now,
			now + 60_000,
		);
		db.prepare("INSERT INTO blob_grants(blob_id, machine_id) VALUES ('b-1', 'm-1')").run();
		db.prepare(
			"INSERT INTO push_outbox(push_id, device_id, kind, ref_id, body, created_at, expires_at) VALUES ('push-1', 'd-1', 'settled', 'm-1:a-1', '{}', ?, ?)",
		).run(now, now + 60_000);
		db.prepare(
			"INSERT INTO comms(agent_id, comm_id, machine_id, direction, channel, action, at, created_at, updated_at) VALUES ('m-1:a-1', 'comm-1', 'm-1', 'out', 'intercom', 'send', ?, ?, ?)",
		).run(now, now, now);

		const rowsBefore = Object.fromEntries(
			PRESERVED_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]]),
		);

		expect(migrate(db, { dir: MIGRATIONS_DIR })).toEqual([6]);
		expect(migrate(db, { dir: MIGRATIONS_DIR })).toEqual([]);

		const columns = db.prepare("PRAGMA table_info(devices)").all() as {
			name: string;
			type: string;
			notnull: number;
			dflt_value: string | null;
		}[];
		for (const name of ["apns_token", "apns_env"]) {
			expect(columns).toContainEqual(expect.objectContaining({ name, type: "TEXT", notnull: 0, dflt_value: null }));
		}

		const device = db.prepare("SELECT apns_token, apns_env FROM devices WHERE id='d-1'").get();
		expect(device).toEqual({ apns_token: null, apns_env: null });

		for (const table of PRESERVED_TABLES) {
			const rowsAfter = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
			if (table === "devices") {
				expect(
					rowsAfter.map((row) =>
						Object.fromEntries(Object.entries(row).filter(([key]) => key !== "apns_token" && key !== "apns_env")),
					),
				).toEqual(rowsBefore[table]);
			} else {
				expect(rowsAfter).toEqual(rowsBefore[table]);
			}
		}

		for (const [index, environment] of (["sandbox", "production"] as const).entries()) {
			db.prepare(
				"INSERT INTO devices(id, name, token_hash, push_key, created_at, apns_env) VALUES (?, 'APNs Phone', ?, ?, ?, ?)",
			).run(`d-${environment}`, Buffer.alloc(32, index + 3), Buffer.alloc(32, index + 3), now, environment);
		}
		expect(
			db.prepare("SELECT apns_env FROM devices WHERE id IN ('d-sandbox', 'd-production') ORDER BY apns_env").all(),
		).toEqual([{ apns_env: "production" }, { apns_env: "sandbox" }]);

		const deviceCountBeforeRejectedInsert = (db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n;
		expect(() =>
			db
				.prepare(
					"INSERT INTO devices(id, name, token_hash, push_key, created_at, apns_env) VALUES ('d-invalid', 'Invalid', ?, ?, ?, 'bogus')",
				)
				.run(Buffer.alloc(32, 2), Buffer.alloc(32, 2), now),
		).toThrow();
		expect((db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n).toBe(
			deviceCountBeforeRejectedInsert,
		);
	});
});
