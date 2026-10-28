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
	"events",
	"snapshots",
	"prompts",
	"blobs",
	"blob_grants",
	"push_outbox",
	"comms",
] as const;

describe("migration 0005_agent_archive", () => {
	let dir: string;
	let db: Database.Database;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rp-mig0005-"));
		db = new Database(join(dir, "relay.db"));
		db.pragma("journal_mode = WAL");
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("upgrades schema 0004 without changing existing rows and adds the archive index", () => {
		const schema0004 = join(dir, "migrations-v0004");
		mkdirSync(schema0004);
		for (const migration of readMigrations(MIGRATIONS_DIR).filter((item) => item.version <= 4)) {
			writeFileSync(join(schema0004, migration.name), migration.sql);
		}
		expect(migrate(db, { dir: schema0004 })).toEqual([1, 2, 3, 4]);

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

		const rowBefore = db.prepare("SELECT * FROM agents WHERE id='m-1:a-1'").get() as Record<string, unknown>;
		const countsBefore = Object.fromEntries(
			PRESERVED_TABLES.map((table) => [
				table,
				(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
			]),
		);

		expect(migrate(db, { dir: MIGRATIONS_DIR })).toEqual([5]);
		expect(migrate(db, { dir: MIGRATIONS_DIR })).toEqual([]);

		const rowAfter = db.prepare("SELECT * FROM agents WHERE id='m-1:a-1'").get() as Record<string, unknown>;
		const { archived_at: archivedAt, ...existingFields } = rowAfter;
		expect(archivedAt).toBeNull();
		expect(existingFields).toEqual(rowBefore);
		for (const table of PRESERVED_TABLES) {
			expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(countsBefore[table]);
		}

		const columns = db.prepare("PRAGMA table_info(agents)").all() as { name: string; type: string }[];
		expect(columns).toContainEqual(expect.objectContaining({ name: "archived_at", type: "INTEGER" }));
		const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='agents_archived_at'").get() as
			| { sql: string }
			| undefined;
		expect(index?.sql).toMatch(/where\s+archived_at\s+is\s+not\s+null/i);
	});
});
