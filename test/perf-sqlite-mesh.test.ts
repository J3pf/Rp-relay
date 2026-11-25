import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupNowAsync, listBackups, pruneBackupsAsync, restoreBackup, verifyDb } from "../src/backup/index.js";
import { openDb } from "../src/db/index.js";
import { MIGRATIONS_DIR, migrate, readMigrations } from "../src/db/migrate.js";
import type { CommInput } from "../src/db/repos/comms.js";
import { Repos } from "../src/db/repos/index.js";
import { DAY, HOUR } from "../src/util/time.js";
import {
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
	promptBody,
	startRelay,
	type TestRelay,
} from "./helpers.js";

const tempDirs: string[] = [];
const relays: TestRelay[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function makeRelay(over: Record<string, unknown> = {}): Promise<TestRelay> {
	const t = await startRelay(over);
	relays.push(t);
	return t;
}

afterEach(async () => {
	for (const t of relays.splice(0)) {
		await t.stop();
		cleanup(t);
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function commInput(overrides: Partial<CommInput> = {}): CommInput {
	return {
		agent_id: "m-1:a-1",
		comm_id: "c-1",
		machine_id: "m-1",
		direction: "out",
		channel: "intercom",
		action: "send",
		peer_session_id: "s-2",
		peer_name: "Worker 2",
		peer_cwd: "/work/2",
		peer_ref: null,
		peer_agent_id: "m-1:a-2",
		message_id: null,
		reply_to: null,
		expects_reply: false,
		text: "hello",
		truncated: false,
		delivered: null,
		at: Date.now(),
		...overrides,
	};
}

describe("RLY-PERF-02: non-blocking backupNowAsync & pruneBackupsAsync", () => {
	it("creates an atomic, 0o600, verifiable and restorable backup asynchronously", async () => {
		const dir = makeTempDir("rp-perf-bk-");
		const dbFile = join(dir, "relay.db");
		const bkDir = join(dir, "backups");
		const db = openDb(dbFile);
		try {
			migrate(db);
			db.prepare("INSERT INTO relay_meta(key, value) VALUES ('marker', 'async-backup-ok')").run();

			const fixedDate = new Date("2026-05-01T12:00:00Z");
			const out1 = await backupNowAsync(db, bkDir, fixedDate);
			const out2 = await backupNowAsync(db, bkDir, fixedDate);

			expect(out1).not.toBe(out2);
			expect(existsSync(out1)).toBe(true);
			expect(existsSync(out2)).toBe(true);
			expect(verifyDb(out1)).toEqual({ ok: true, detail: "ok" });
			expect(verifyDb(out2)).toEqual({ ok: true, detail: "ok" });
			expect(statSync(out1).mode & 0o777).toBe(0o600);
			const files = readdirSync(bkDir);
			expect(files).toHaveLength(2);
			expect(files.some((f) => f.includes(".tmp"))).toBe(false);

			// Restore into a fresh target and confirm data survived
			const restoredPath = join(dir, "restored.db");
			restoreBackup(out1, restoredPath);
			const restored = openDb(restoredPath, { readonly: true });
			try {
				const row = restored.prepare("SELECT value FROM relay_meta WHERE key='marker'").get() as
					| { value: string }
					| undefined;
				expect(row?.value).toBe("async-backup-ok");
			} finally {
				restored.close();
			}
		} finally {
			db.close();
		}
	});

	it("pruneBackupsAsync removes expired backups while retaining the newest valid backup", async () => {
		const dir = makeTempDir("rp-perf-prune-");
		const dbFile = join(dir, "relay.db");
		const bkDir = join(dir, "backups");
		expect(await pruneBackupsAsync(bkDir, 7)).toBe(0);

		const db = openDb(dbFile);
		try {
			migrate(db);
			const b1 = await backupNowAsync(db, bkDir, new Date("2026-01-01T00:00:00Z"));
			const b2 = await backupNowAsync(db, bkDir, new Date("2026-01-02T00:00:00Z"));
			const b3 = await backupNowAsync(db, bkDir, new Date("2026-01-03T00:00:00Z"));
			const now = Date.now();
			utimesSync(b1, new Date(now - 30 * DAY), new Date(now - 30 * DAY));
			utimesSync(b2, new Date(now - 20 * DAY), new Date(now - 20 * DAY));
			utimesSync(b3, new Date(now - 10 * DAY), new Date(now - 10 * DAY));

			const removed = await pruneBackupsAsync(bkDir, 7, now);
			expect(removed).toBe(2);
			const remaining = listBackups(bkDir);
			expect(remaining).toHaveLength(1);
			expect(remaining[0]!.path).toBe(b3);
			expect(verifyDb(remaining[0]!.path).ok).toBe(true);
		} finally {
			db.close();
		}
	});
});

describe("RLY-PERF-05 & RLY-PERF-08: migration 0008, WAL limit, indexed outbox purge & comms RETURNING", () => {
	it("applies migration 0008_perf_indexes cleanly and SQLite uses both partial indexes", () => {
		const dir = makeTempDir("rp-mig0008-");
		const dbFile = join(dir, "relay.db");
		const db = openDb(dbFile);
		try {
			// Verify WAL journal_size_limit pragma (64 MB)
			const limit = db.pragma("journal_size_limit", { simple: true }) as number;
			expect(limit).toBe(67_108_864);

			// Upgrade from schema 0007
			const schema0007 = join(dir, "migrations-v0007");
			mkdirSync(schema0007);
			for (const m of readMigrations(MIGRATIONS_DIR).filter((item) => item.version <= 7)) {
				writeFileSync(join(schema0007, m.name), m.sql);
			}
			expect(migrate(db, { dir: schema0007 })).toEqual([1, 2, 3, 4, 5, 6, 7]);
			expect(migrate(db, { dir: MIGRATIONS_DIR })).toEqual([8]);
			expect(migrate(db, { dir: MIGRATIONS_DIR })).toEqual([]);

			const indexes = (
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('push_outbox_acked','comms_peer_unresolved_at')",
					)
					.all() as { name: string }[]
			).map((r) => r.name);
			expect(indexes).toEqual(expect.arrayContaining(["push_outbox_acked", "comms_peer_unresolved_at"]));

			// Verify EXPLAIN QUERY PLAN uses push_outbox_acked and push_outbox_expires
			const planExpired = db
				.prepare("EXPLAIN QUERY PLAN DELETE FROM push_outbox WHERE expires_at<?")
				.all(Date.now()) as { detail: string }[];
			expect(planExpired.map((r) => r.detail).join(" ")).toContain("push_outbox_expires");

			const planAcked = db
				.prepare("EXPLAIN QUERY PLAN DELETE FROM push_outbox WHERE acked_at IS NOT NULL AND acked_at<?")
				.all(Date.now() - HOUR) as { detail: string }[];
			expect(planAcked.map((r) => r.detail).join(" ")).toContain("push_outbox_acked");

			// Verify EXPLAIN QUERY PLAN for CommsRepo.listUnresolved uses comms_peer_unresolved_at without temp B-tree sort
			const planUnresolved = db
				.prepare(
					`EXPLAIN QUERY PLAN SELECT * FROM comms
					 WHERE peer_agent_id IS NULL
					   AND at >= ?
					   AND agent_id NOT IN (SELECT id FROM agents WHERE archived_at IS NOT NULL)
					 ORDER BY at DESC, comm_id DESC
					 LIMIT ?`,
				)
				.all(0, 500) as { detail: string }[];
			const unresolvedDetail = planUnresolved.map((r) => r.detail).join(" ");
			expect(unresolvedDetail).toContain("comms_peer_unresolved_at");
			expect(unresolvedDetail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		} finally {
			db.close();
		}
	});

	it("OutboxRepo.purge splits deletes accurately without removing active or recently acked rows", () => {
		const db = openDb(":memory:");
		try {
			migrate(db);
			const repos = new Repos(db);
			const now = 1_000_000_000;
			db.prepare("INSERT INTO devices(id, name, token_hash, push_key, created_at) VALUES ('d1', 'Phone', ?, ?, ?)").run(
				Buffer.alloc(32, 1),
				Buffer.alloc(32, 2),
				now,
			);

			// 1. Expired unacked -> deleted
			repos.outbox.insert({
				push_id: "p-expired",
				device_id: "d1",
				kind: "prompt",
				ref_id: "r1",
				body: "{}",
				created_at: now - 2 * HOUR,
				expires_at: now - 1,
			});
			// 2. Active unacked -> kept
			repos.outbox.insert({
				push_id: "p-active",
				device_id: "d1",
				kind: "prompt",
				ref_id: "r2",
				body: "{}",
				created_at: now - 1000,
				expires_at: now + HOUR,
			});
			// 3. Old acked (> 1h ago) -> deleted
			repos.outbox.insert({
				push_id: "p-acked-old",
				device_id: "d1",
				kind: "prompt",
				ref_id: "r3",
				body: "{}",
				created_at: now - 3 * HOUR,
				expires_at: now + HOUR,
			});
			repos.outbox.ack("p-acked-old", "d1", now - HOUR - 10);
			// 4. Recent acked (< 1h ago) -> kept
			repos.outbox.insert({
				push_id: "p-acked-recent",
				device_id: "d1",
				kind: "prompt",
				ref_id: "r4",
				body: "{}",
				created_at: now - 1000,
				expires_at: now + HOUR,
			});
			repos.outbox.ack("p-acked-recent", "d1", now - 100);

			const removed = repos.outbox.purge(now);
			expect(removed).toBe(2);
			const remaining = (
				db.prepare("SELECT push_id FROM push_outbox ORDER BY push_id").all() as { push_id: string }[]
			).map((r) => r.push_id);
			expect(remaining).toEqual(["p-acked-recent", "p-active"]);
		} finally {
			db.close();
		}
	});

	it("CommsRepo.upsert returns row via RETURNING * without issuing a secondary SELECT get()", () => {
		const db = openDb(":memory:");
		try {
			migrate(db);
			const repos = new Repos(db);
			const getSpy = vi.spyOn(repos.comms, "get");

			const first = repos.comms.upsert(commInput({ text: "first", delivered: null }));
			expect(first.text).toBe("first");
			expect(first.delivered).toBeNull();

			const updated = repos.comms.upsert(commInput({ text: null, delivered: true, message_id: "msg-1" }));
			expect(updated.text).toBe("first");
			expect(updated.delivered).toBe(1);
			expect(updated.message_id).toBe("msg-1");
			expect(getSpy).not.toHaveBeenCalled();
		} finally {
			db.close();
		}
	});
});

describe("RLY-PERF-04: HistoryService.build() lazy snapshot & streaming byte budget", () => {
	it("skips full snapshot load on valid resume and streams newest events stopping at FRAME_BUDGET", async () => {
		const t = await makeRelay({ limits: { eventsPerAgent: 500 } });
		const machine = await pairMachine(t, "hist-perf-box");
		const agent = await connectAgent(t, machine, "hist-perf-sess");

		// Insert a large snapshot at seq 0
		agent.client.send("agent.snapshot", {
			epoch: agent.hello.epoch,
			seq: 0,
			entries: [{ eid: "snap-1", kind: "user", at: 1, msg: { role: "user", content: "s".repeat(100_000) } }],
			truncated: false,
		});
		await expect.poll(() => t.relay.ctx.repos.events.snapshotMeta(agent.agentId, agent.hello.epoch)?.seq).toBe(0);

		// Insert 20 large persisted events (~120 KB each => 2.4 MB total, well over 900 KB FRAME_BUDGET)
		const bigText = "x".repeat(120_000);
		for (let i = 1; i <= 20; i++) {
			t.relay.ctx.repos.events.insert(agent.agentId, agent.hello.epoch, i, Date.now() + i, "message_end", {
				type: "message_end",
				message: { role: "assistant", content: `${i}:${bigText}` },
			});
		}
		t.relay.ctx.repos.agents.setSeq(agent.agentId, 20);

		// 1. Valid resume (sinceSeq = 18): must NOT call repos.events.snapshot()
		const snapSpy = vi.spyOn(t.relay.ctx.repos.events, "snapshot");
		const resumed = t.relay.ctx.history.build(agent.agentId, 18, agent.hello.epoch);
		expect(snapSpy).not.toHaveBeenCalled();
		expect(resumed.entries).toEqual([]);
		expect(resumed.events.map((e) => e.seq)).toEqual([19, 20]);
		expect(resumed.truncated).toBeUndefined();
		expect(resumed.liveFromSeq).toBe(20);
		expect(resumed.needsResync).toBe(false);

		// 2. Full load (sinceSeq = null): streams via iterateLatest, stops early when 900 KB budget is reached,
		//    returns newest events in ascending order, and skips loading snapshot because rows exceeded budget.
		snapSpy.mockClear();
		const origIterate = t.relay.ctx.repos.events.iterateLatest.bind(t.relay.ctx.repos.events);
		let yieldedRows = 0;
		const iterSpy = vi
			.spyOn(t.relay.ctx.repos.events, "iterateLatest")
			.mockImplementation((aid, ep, afterSeq, limit) => {
				const inner = origIterate(aid, ep, afterSeq, limit);
				return {
					[Symbol.iterator]() {
						return this;
					},
					next() {
						const res = inner.next();
						if (!res.done) yieldedRows++;
						return res;
					},
					return() {
						return inner.return?.() ?? { done: true, value: undefined };
					},
				} as IterableIterator<any>;
			});

		const full = t.relay.ctx.history.build(agent.agentId, null, null);
		expect(full.truncated).toBe(true);
		expect(full.entries).toEqual([]);
		// At ~120 KB per row, at most 7 rows fit in 900 KB -> iterator must stop on the 8th row, NOT read all 20!
		expect(full.events.length).toBeGreaterThanOrEqual(6);
		expect(full.events.length).toBeLessThanOrEqual(8);
		expect(yieldedRows).toBe(full.events.length + 1);
		// Must be the newest events in strictly ascending seq order ending at 20
		expect(full.events[full.events.length - 1]!.seq).toBe(20);
		for (let i = 1; i < full.events.length; i++) {
			expect(full.events[i]!.seq).toBe(full.events[i - 1]!.seq + 1);
		}
		// Snapshot blob should NOT have been loaded when rows alone exceeded FRAME_BUDGET
		expect(snapSpy).not.toHaveBeenCalled();

		iterSpy.mockRestore();
		snapSpy.mockRestore();
		agent.client.close();
		await agent.client.waitClosed();
	});
});

describe("RLY-PERF-03: MeshService incremental materialization & throttle preservation", () => {
	it("materializes todo_update and subagent_update incrementally without re-querying events on rebuilds", async () => {
		const t = await makeRelay();
		const machine = await pairMachine(t, "mesh-mat-box");
		const agent = await connectAgent(t, machine, "mesh-mat-agent");

		// Initial snapshot hydrates cache once
		const snap0 = t.relay.ctx.mesh.getSnapshot(null);
		expect(snap0.nodes.find((n) => n.agentId === agent.agentId)?.todos).toBeNull();

		const listByTypesSpy = vi.spyOn(t.relay.ctx.repos.events, "listByTypes");
		const latestByTypeSpy = vi.spyOn(t.relay.ctx.repos.events, "latestByType");

		// Emit todo_update and subagent_update through AgentService
		agent.event({
			type: "todo_update",
			tasks: [
				{ id: "t1", title: "Done task", status: "done" },
				{ id: "t2", title: "Active task", status: "in_progress" },
			],
		});
		agent.event({
			type: "subagent_update",
			taskId: "sub-1",
			agent: "worker",
			label: "Worker 1",
			status: "running",
		});
		agent.event({
			type: "subagent_update",
			taskId: "sub-2",
			agent: "reviewer",
			label: "Reviewer",
			status: "done",
		});
		await expect.poll(() => t.relay.ctx.repos.agents.get(agent.agentId)?.last_seq).toBe(3);

		// Rebuild snapshot after invalidation -> must NOT query SQLite for todo/subagent events again!
		t.relay.ctx.mesh.invalidate();
		const snap1 = t.relay.ctx.mesh.getSnapshot(null);
		expect(listByTypesSpy).not.toHaveBeenCalled();
		expect(latestByTypeSpy).not.toHaveBeenCalled();

		const node = snap1.nodes.find((n) => n.agentId === agent.agentId)!;
		expect(node.todos).toEqual({
			total: 2,
			done: 1,
			inProgress: 1,
			blocked: 0,
			pending: 0,
			current: "Active task",
		});
		expect(node.subagents.map((s) => ({ taskId: s.taskId, status: s.status }))).toEqual([
			{ taskId: "sub-1", status: "running" },
			{ taskId: "sub-2", status: "done" },
		]);

		// Updating sub-1 to done updates in-place in memory
		agent.event({
			type: "subagent_update",
			taskId: "sub-1",
			agent: "worker",
			label: "Worker 1",
			status: "done",
		});
		await expect.poll(() => t.relay.ctx.repos.agents.get(agent.agentId)?.last_seq).toBe(4);
		t.relay.ctx.mesh.invalidate();
		const snap2 = t.relay.ctx.mesh.getSnapshot(null);
		expect(listByTypesSpy).not.toHaveBeenCalled();
		expect(latestByTypeSpy).not.toHaveBeenCalled();
		const node2 = snap2.nodes.find((n) => n.agentId === agent.agentId)!;
		expect(node2.subagents.map((s) => ({ taskId: s.taskId, status: s.status }))).toEqual([
			{ taskId: "sub-1", status: "done" },
			{ taskId: "sub-2", status: "done" },
		]);

		listByTypesSpy.mockRestore();
		latestByTypeSpy.mockRestore();
		agent.client.close();
		await agent.client.waitClosed();
	});

	it("does NOT trigger synchronous getSnapshot(null) during a burst of invalidate() + onComm()", async () => {
		const t = await makeRelay();
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "mesh-burst-box");
		const sender = await connectAgent(t, machine, "burst-sender", {
			session: { id: "burst-sender", file: null, name: "BurstSender" },
		});
		const receiver = await connectAgent(t, machine, "burst-receiver", {
			session: { id: "burst-receiver", file: null, name: "BurstReceiver" },
		});
		const { client: app } = await connectApp(t, device);
		app.send("mesh.subscribe", { machineId: null });
		await app.next("mesh.snapshot");

		const getSnapshotSpy = vi.spyOn(t.relay.ctx.mesh, "getSnapshot");
		const now = Date.now();
		for (let i = 0; i < 15; i++) {
			sender.event({
				type: "comm",
				commId: `burst-comm-${i}`,
				direction: "out",
				channel: "intercom",
				action: "send",
				peer: { sessionId: "burst-receiver", name: "BurstReceiver", cwd: "/home/u/api", ref: null },
				messageId: `burst-msg-${i}`,
				replyTo: null,
				expectsReply: false,
				text: `Burst message ${i}`,
				truncated: false,
				delivered: true,
				at: now + i,
			});
		}

		// Receive all 15 live mesh.comm frames
		for (let i = 0; i < 15; i++) {
			const live = await app.next("mesh.comm");
			expect((live.d as any).comm.fromName).toBe("BurstSender");
			expect((live.d as any).comm.toName).toBe("BurstReceiver");
			expect((live.d as any).comm.groupId).toBe(sender.agentId);
		}
		// Must NOT have triggered 15 synchronous getSnapshot() rebuilds!
		expect(getSnapshotSpy).toHaveBeenCalledTimes(0);

		// Wait for the coalesced 500ms mesh.update
		const update = await app.next("mesh.update");
		expect((update.d as any).edges[0].count).toBe(15);
		expect(getSnapshotSpy).toHaveBeenCalledTimes(1);

		getSnapshotSpy.mockRestore();
		sender.client.close();
		receiver.client.close();
		app.close();
		await Promise.all([sender.client.waitClosed(), receiver.client.waitClosed(), app.waitClosed()]);
	});

	it("passes machineId to repos.comms.listSince when scoped to a machine", async () => {
		const t = await makeRelay();
		const machine = await pairMachine(t, "scoped-comms-box");
		await connectAgent(t, machine, "scoped-agent");

		const listSinceSpy = vi.spyOn(t.relay.ctx.repos.comms, "listSince");
		t.relay.ctx.mesh.invalidate();
		t.relay.ctx.mesh.getSnapshot(machine.machineId);

		expect(listSinceSpy).toHaveBeenCalledWith(expect.any(Number), machine.machineId);
		listSinceSpy.mockRestore();
	});

	it("does not clear mesh cache when activeExpiryTimer fires", async () => {
		const t = await makeRelay();
		const device = await pairDevice(t);
		const machine = await pairMachine(t, "expiry-cache-box");
		const sender = await connectAgent(t, machine, "exp-sender");
		const receiver = await connectAgent(t, machine, "exp-receiver");
		const { client: app } = await connectApp(t, device);
		app.send("mesh.subscribe", { machineId: null });
		await app.next("mesh.snapshot");

		const at = Date.now() - 18_500;
		sender.event({
			type: "comm",
			commId: "exp-comm-1",
			direction: "out",
			channel: "intercom",
			action: "send",
			peer: { sessionId: "exp-receiver", name: "Receiver", cwd: "/home/u/api", ref: null },
			messageId: "exp-msg-1",
			replyTo: null,
			expectsReply: false,
			text: "Expiring edge",
			truncated: false,
			delivered: true,
			at,
		});

		await app.next("mesh.comm");
		await app.next(
			(m) => m.t === "mesh.update" && (m.d as any).edges.some((e: any) => e.lastAt === at && e.active === true),
		);

		// Once active snapshot is cached, expiry refresh must NOT rebuild via repos.comms.listSince
		const listSinceSpy = vi.spyOn(t.relay.ctx.repos.comms, "listSince");
		const inactive = await app.next(
			(m) => m.t === "mesh.update" && (m.d as any).edges.some((e: any) => e.lastAt === at && e.active === false),
			5_000,
		);
		expect((inactive.d as any).edges.find((e: any) => e.lastAt === at)?.active).toBe(false);
		expect(listSinceSpy).not.toHaveBeenCalled();

		listSinceSpy.mockRestore();
		sender.client.close();
		receiver.client.close();
		app.close();
		await Promise.all([sender.client.waitClosed(), receiver.client.waitClosed(), app.waitClosed()]);
	});
});

describe("RLY-PERF-06: Summaries.archived() & Summaries.allMachines() batched queries", () => {
	it("computes archived messageCount with a single batched countsByAgent query", async () => {
		const t = await makeRelay();
		const machine = await pairMachine(t, "arch-batch-box");
		const a1 = await connectAgent(t, machine, "arch-1");
		const a2 = await connectAgent(t, machine, "arch-2");
		const a3 = await connectAgent(t, machine, "arch-3");

		for (let i = 0; i < 3; i++) a1.event({ type: "message_end", message: { role: "assistant", content: `a1-${i}` } });
		a2.event({ type: "message_end", message: { role: "assistant", content: "a2-0" } });
		await expect.poll(() => t.relay.ctx.repos.agents.get(a1.agentId)?.last_seq).toBe(3);
		await expect.poll(() => t.relay.ctx.repos.agents.get(a2.agentId)?.last_seq).toBe(1);

		a1.client.close();
		a2.client.close();
		a3.client.close();
		await Promise.all([a1.client.waitClosed(), a2.client.waitClosed(), a3.client.waitClosed()]);

		t.relay.ctx.agents.archive(a1.agentId);
		t.relay.ctx.agents.archive(a2.agentId);
		t.relay.ctx.agents.archive(a3.agentId);

		const singleCountSpy = vi.spyOn(t.relay.ctx.repos.events, "count");
		const batchedSpy = vi.spyOn(t.relay.ctx.repos.events, "countsByAgent");
		const { agents } = t.relay.ctx.agents.listArchived({ limit: 50 });

		expect(singleCountSpy).not.toHaveBeenCalled();
		expect(batchedSpy).toHaveBeenCalledTimes(1);
		const byId = new Map(agents.map((a) => [a.agentId, a.messageCount]));
		expect(byId.get(a1.agentId)).toBe(3);
		expect(byId.get(a2.agentId)).toBe(1);
		expect(byId.get(a3.agentId)).toBe(0);

		singleCountSpy.mockRestore();
		batchedSpy.mockRestore();
	});

	it("computes allMachines() openPromptCount with a single countOpenByMachine query (no byMachine N+1)", async () => {
		const t = await makeRelay();
		const m1 = await pairMachine(t, "sum-m1");
		const m2 = await pairMachine(t, "sum-m2");
		const m3 = await pairMachine(t, "sum-m3");
		const a1 = await connectAgent(t, m1, "sum-a1");
		const a2 = await connectAgent(t, m1, "sum-a2");
		const a3 = await connectAgent(t, m2, "sum-a3");

		// Open 2 prompts on m1 (1 open, 1 answered), 1 open on m2, 0 on m3
		const p1 = promptBody(a1.agentId, { promptId: "sum-p1" });
		const p2 = promptBody(a2.agentId, { promptId: "sum-p2" });
		const p3 = promptBody(a3.agentId, { promptId: "sum-p3" });
		const now = Date.now();
		t.relay.ctx.repos.prompts.insert(a1.agentId, p1 as never, now);
		t.relay.ctx.repos.prompts.insert(a2.agentId, p2 as never, now);
		t.relay.ctx.repos.prompts.answer("sum-p2", { confirmed: true }, null, now + 1);
		t.relay.ctx.repos.prompts.insert(a3.agentId, p3 as never, now);

		const byMachineSpy = vi.spyOn(t.relay.ctx.repos.agents, "byMachine");
		const countByMachineSpy = vi.spyOn(t.relay.ctx.repos.prompts, "countOpenByMachine");
		const machines = t.relay.ctx.summaries.allMachines();

		expect(byMachineSpy).not.toHaveBeenCalled();
		expect(countByMachineSpy).toHaveBeenCalledTimes(1);

		const openById = new Map(machines.map((m) => [m.machineId, m.openPromptCount]));
		expect(openById.get(m1.machineId)).toBe(2);
		expect(openById.get(m2.machineId)).toBe(1);
		expect(openById.get(m3.machineId)).toBe(0);

		byMachineSpy.mockRestore();
		countByMachineSpy.mockRestore();
		a1.client.close();
		a2.client.close();
		a3.client.close();
		await Promise.all([a1.client.waitClosed(), a2.client.waitClosed(), a3.client.waitClosed()]);
	});
});
