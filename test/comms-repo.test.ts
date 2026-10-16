import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import type { CommInput } from "../src/db/repos/comms.js";
import { Repos } from "../src/db/repos/index.js";
import { DAY } from "../src/util/time.js";

const databases: ReturnType<typeof openDb>[] = [];

function setup() {
	const db = openDb(":memory:");
	databases.push(db);
	migrate(db);
	return { db, repos: new Repos(db) };
}

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function comm(overrides: Partial<CommInput> = {}): CommInput {
	return {
		agent_id: "agent-a",
		comm_id: "comm-1",
		machine_id: "machine-1",
		direction: "out",
		channel: "intercom",
		action: "send",
		peer_session_id: "session-b",
		peer_name: "Agent B",
		peer_cwd: "/work/b",
		peer_ref: "worker-b",
		peer_agent_id: "agent-b",
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

describe("CommsRepo", () => {
	it("applies the comms migration and creates the required indexes", () => {
		const { db } = setup();
		const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='comms'").get() as
			| { sql: string }
			| undefined;
		expect(table?.sql).toContain("PRIMARY KEY (agent_id, comm_id)");
		const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='comms'").all() as {
			name: string;
		}[];
		expect(indexes.map((index) => index.name)).toEqual(
			expect.arrayContaining(["comms_machine_at", "comms_message_id", "comms_at", "comms_peer_unresolved"]),
		);
		expect(migrate(db)).toEqual([]);
	});

	it("upserts by agent and comm id while filling later delivery details without erasing known values", () => {
		const { repos } = setup();
		const first = repos.comms.upsert(comm());
		expect(first).toMatchObject({
			agent_id: "agent-a",
			comm_id: "comm-1",
			peer_name: "Agent B",
			text: "hello",
			delivered: null,
			message_id: null,
		});

		const updated = repos.comms.upsert(
			comm({ delivered: true, message_id: "message-1", peer_name: null, text: null, at: first.at + 1 }),
		);
		expect(updated).toMatchObject({
			comm_id: "comm-1",
			delivered: 1,
			message_id: "message-1",
			peer_name: "Agent B",
			text: "hello",
			at: first.at + 1,
		});
		expect(repos.comms.listSince(0)).toHaveLength(1);
		expect(repos.comms.get("agent-a", "comm-1")).toEqual(updated);
	});

	it("lists conversations and agent comms in descending timestamp order", () => {
		const { repos } = setup();
		repos.comms.upsert(comm({ comm_id: "a-1", at: 100, peer_agent_id: "agent-b" }));
		repos.comms.upsert(
			comm({ agent_id: "agent-b", comm_id: "b-1", direction: "in", at: 200, peer_agent_id: "agent-a" }),
		);
		repos.comms.upsert(comm({ comm_id: "a-2", at: 300, peer_agent_id: "agent-b" }));
		repos.comms.upsert(comm({ comm_id: "other", agent_id: "agent-c", at: 400, peer_agent_id: "agent-d" }));

		expect(repos.comms.listConversation("agent-a", "agent-b").map((row) => row.comm_id)).toEqual(["a-2", "b-1", "a-1"]);
		expect(repos.comms.listConversation("agent-a", "agent-b", 300).map((row) => row.comm_id)).toEqual(["b-1", "a-1"]);
		expect(repos.comms.listConversation("agent-a", "agent-b", undefined, 2).map((row) => row.comm_id)).toEqual([
			"a-2",
			"b-1",
		]);
		expect(repos.comms.listByAgent("agent-a").map((row) => row.comm_id)).toEqual(["a-2", "b-1", "a-1"]);
		expect(repos.comms.listByAgent("agent-a", 2).map((row) => row.comm_id)).toEqual(["a-2", "b-1"]);
	});

	it("filters since by machine and exposes unresolved peers for later resolution", () => {
		const { repos } = setup();
		repos.comms.upsert(comm({ peer_agent_id: null, at: 100 }));
		repos.comms.upsert(comm({ comm_id: "comm-2", machine_id: "machine-2", at: 200 }));
		expect(repos.comms.listSince(150).map((row) => row.comm_id)).toEqual(["comm-2"]);
		expect(repos.comms.listSince(0, "machine-1").map((row) => row.comm_id)).toEqual(["comm-1"]);
		expect(repos.comms.listUnresolved().map((row) => row.comm_id)).toEqual(["comm-1"]);
		repos.comms.setPeerAgentId("agent-a", "comm-1", "agent-b");
		expect(repos.comms.listUnresolved()).toEqual([]);
	});

	it("prunes comms older than seven days and caps retained rows at maxRows", () => {
		const { repos } = setup();
		const now = 20 * DAY;
		repos.comms.upsert(comm({ comm_id: "old", at: now - 8 * DAY }));
		repos.comms.upsert(comm({ comm_id: "recent", at: now - DAY }));
		expect(repos.comms.prune(7, 20_000, now)).toBe(1);
		expect(repos.comms.get("agent-a", "old")).toBeUndefined();
		expect(repos.comms.get("agent-a", "recent")).toBeDefined();

		const capRepos = setup().repos;
		const capNow = Date.now();
		for (let i = 0; i < 20_001; i++) {
			capRepos.comms.upsert(comm({ comm_id: `cap-${i}`, at: capNow - 20_001 + i, peer_agent_id: null }));
		}
		expect(capRepos.comms.prune(7, 20_000, capNow)).toBe(1);
		expect(capRepos.comms.listSince(capNow - DAY)).toHaveLength(20_000);
		expect(capRepos.comms.get("agent-a", "cap-0")).toBeUndefined();
	});
});
