import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate, readMigrations } from "../src/db/migrate.js";

describe("migration 0004_perf_indexes", () => {
	let dir: string;
	let dbPath: string;
	let db: Database.Database;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rp-mig0004-"));
		dbPath = join(dir, "relay.db");
		db = new Database(dbPath);
		db.pragma("journal_mode = WAL");
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("migrates a database created at v0.5.3 with existing data and activates composite indexes", () => {
		// 1. Stage only migrations 1..3 in a temporary migrations directory (representing v0.5.3 schema)
		const v053Dir = join(dir, "migrations-v053");
		mkdirSync(v053Dir);
		const allMigrations = readMigrations(MIGRATIONS_DIR);
		for (const m of allMigrations.filter((m) => m.version <= 3)) {
			writeFileSync(join(v053Dir, m.name), m.sql);
		}

		// Apply migrations 1..3
		const initialApplied = migrate(db, { dir: v053Dir });
		expect(initialApplied).toEqual([1, 2, 3]);

		// 2. Insert realistic production-like data into v0.5.3 tables
		const now = Date.now();
		db.prepare(`
			INSERT INTO machines (id, name, token_hash, context, color, created_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run("m-1", "Server 1", Buffer.alloc(32), "work", "#4F7DF3", now, now);

		const insertAgent = db.prepare(`
			INSERT INTO agents (id, machine_id, kind, instance, epoch, session_id, session_name, status, online, first_seen_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		insertAgent.run("m-1:agent-a", "m-1", "pi", "inst-a", "epoch-1", "sess-a", "Worker A", "working", 1, now, now);
		insertAgent.run("m-1:agent-b", "m-1", "pi", "inst-b", "epoch-1", "sess-b", "Worker B", "working", 1, now, now);

		const insertEvent = db.prepare(`
			INSERT INTO events (agent_id, epoch, seq, ts, type, payload)
			VALUES (?, ?, ?, ?, ?, ?)
		`);
		insertEvent.run("m-1:agent-a", "epoch-1", 1, now - 2000, "todo_update", '{"type":"todo_update","tasks":[]}');
		insertEvent.run("m-1:agent-a", "epoch-1", 2, now - 1000, "subagent_update", '{"type":"subagent_update"}');
		insertEvent.run("m-1:agent-b", "epoch-1", 1, now - 1500, "todo_update", '{"type":"todo_update","tasks":[]}');

		const insertComm = db.prepare(`
			INSERT INTO comms (comm_id, agent_id, machine_id, direction, channel, action, peer_agent_id, at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		insertComm.run("comm-1", "m-1:agent-a", "m-1", "out", "intercom", "send", "m-1:agent-b", now - 1000, now, now);
		insertComm.run("comm-2", "m-1:agent-b", "m-1", "in", "intercom", "send", "m-1:agent-a", now - 1000, now, now);

		// 3. Apply migration 0004 from canonical migrations directory
		const upgradeApplied = migrate(db, { dir: MIGRATIONS_DIR });
		expect(upgradeApplied).toEqual([4]);

		// Idempotency: re-running migrate() applies nothing
		expect(migrate(db, { dir: MIGRATIONS_DIR })).toEqual([]);

		// 4. Verify that all four composite indexes exist in sqlite_master
		const indexes = (
			db
				.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'events_%' OR name LIKE 'comms_%'")
				.all() as { name: string }[]
		).map((r) => r.name);

		expect(indexes).toContain("events_agent_epoch_type_seq");
		expect(indexes).toContain("comms_agent_at");
		expect(indexes).toContain("comms_peer_at");
		expect(indexes).toContain("comms_pair_at");

		// 5. Verify EXPLAIN QUERY PLAN demonstrates SQLite uses the new indexes for target mesh queries

		// Query A: Events query by agent_id, epoch, and exact type (single type query)
		const explainEvents = db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT * FROM events WHERE agent_id=? AND epoch=? AND type=? ORDER BY seq DESC LIMIT 1000",
			)
			.all("m-1:agent-a", "epoch-1", "todo_update") as { detail: string }[];
		const eventsDetail = explainEvents.map((r) => r.detail).join(" ");
		expect(eventsDetail).toContain("events_agent_epoch_type_seq");

		// Query B: CommsRepo.listByAgent (agent_id scan)
		const explainCommsAgent = db
			.prepare("EXPLAIN QUERY PLAN SELECT * FROM comms WHERE agent_id=? ORDER BY at DESC, comm_id DESC LIMIT 50")
			.all("m-1:agent-a") as { detail: string }[];
		const commsAgentDetail = explainCommsAgent.map((r) => r.detail).join(" ");
		expect(commsAgentDetail).toContain("comms_agent_at");

		// Query C: CommsRepo lookups by peer_agent_id
		const explainCommsPeer = db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT * FROM comms WHERE peer_agent_id=? ORDER BY at DESC, comm_id DESC LIMIT 50",
			)
			.all("m-1:agent-b") as { detail: string }[];
		const commsPeerDetail = explainCommsPeer.map((r) => r.detail).join(" ");
		expect(commsPeerDetail).toContain("comms_peer_at");

		// Query D: CommsRepo.listConversation paired lookup
		const explainCommsPair = db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT * FROM comms WHERE agent_id=? AND peer_agent_id=? ORDER BY at DESC, comm_id DESC LIMIT 50",
			)
			.all("m-1:agent-a", "m-1:agent-b") as { detail: string }[];
		const commsPairDetail = explainCommsPair.map((r) => r.detail).join(" ");
		expect(commsPairDetail).toContain("comms_pair_at");
	});
});
