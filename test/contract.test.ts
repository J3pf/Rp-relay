import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AgentCommsRes,
	CHANNELS,
	type Channel,
	type CommEvent,
	knownTypes,
	MeshConversationRes,
	parseFrame,
	validateMessage,
	validateSchema,
} from "@j3pf/rp-protocol";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import type { CommInput } from "../src/db/repos/comms.js";
import { Repos } from "../src/db/repos/index.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "protocol", "fixtures");
const files = readdirSync(dir).filter((f) => /\.(valid|invalid)\.json$/.test(f));

describe("contrato: fixtures", () => {
	it("hay fixtures", () => expect(files.length).toBeGreaterThan(50));

	for (const f of files) {
		const valid = f.endsWith(".valid.json");
		const [channel, t] = f.split("__");
		it(`${f} → ${valid ? "válido" : "inválido"}`, () => {
			const raw = readFileSync(join(dir, f), "utf8");
			const parsed = parseFrame(raw);
			if (channel === "envelope") {
				expect(parsed.ok).toBe(valid);
				return;
			}
			expect(parsed.ok, "el sobre de un fixture del canal debe parsear").toBe(true);
			if (!parsed.ok) return;
			expect(CHANNELS).toContain(channel);
			const res = validateMessage(channel as Channel, parsed.env);
			expect(res.ok, res.ok ? "" : res.message).toBe(valid);
			expect(parsed.env.t).toBe(t);
		});
	}

	it("cada tipo conocido de cada canal tiene al menos un fixture válido", () => {
		const covered = new Set(
			files.filter((f) => f.endsWith(".valid.json")).map((f) => f.split("__").slice(0, 2).join("__")),
		);
		const missing: string[] = [];
		for (const ch of CHANNELS)
			for (const t of knownTypes(ch)) if (!covered.has(`${ch}__${t}`)) missing.push(`${ch}/${t}`);
		expect(missing).toEqual([]);
	});

	it("valida las respuestas HTTP del mesh contra sus esquemas", () => {
		const conversation = JSON.parse(readFileSync(join(dir, "mesh-conversation-response.json"), "utf8")) as unknown;
		const comms = JSON.parse(readFileSync(join(dir, "mesh-agent-comms-response.json"), "utf8")) as unknown;
		const conversationResult = validateSchema(MeshConversationRes, conversation);
		const commsResult = validateSchema(AgentCommsRes, comms);

		expect(conversationResult.ok, conversationResult.ok ? "" : conversationResult.message).toBe(true);
		expect(commsResult.ok, commsResult.ok ? "" : commsResult.message).toBe(true);
	});

	it("consolida los eventos de inicio y fin de una comunicación por agente y commId", () => {
		const db = openDb(":memory:");
		try {
			migrate(db);
			const repos = new Repos(db);
			const agentId = "machine-a:agent-a";
			const toInput = (file: string): CommInput => {
				const parsed = parseFrame(readFileSync(join(dir, file), "utf8"));
				expect(parsed.ok).toBe(true);
				if (!parsed.ok) throw new Error(`fixture ${file} no parseable`);
				const validation = validateMessage("up", parsed.env);
				expect(validation.ok, validation.ok ? "" : validation.message).toBe(true);
				if (!validation.ok) throw new Error(`fixture ${file} inválido: ${validation.message}`);
				const event = (parsed.env.d as { e: CommEvent }).e;
				return {
					agent_id: agentId,
					comm_id: event.commId,
					machine_id: "machine-a",
					direction: event.direction,
					channel: event.channel,
					action: event.action,
					peer_session_id: event.peer.sessionId,
					peer_name: event.peer.name,
					peer_cwd: event.peer.cwd,
					peer_ref: event.peer.ref,
					message_id: event.messageId,
					reply_to: event.replyTo,
					expects_reply: event.expectsReply,
					text: event.text,
					truncated: event.truncated,
					delivered: event.delivered ?? null,
					at: event.at,
				};
			};

			repos.comms.upsert(toInput("up__agent.event__comm_out_start.valid.json"));
			repos.comms.upsert(toInput("up__agent.event__comm_out_end.valid.json"));

			const records = repos.comms.listSince(0);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				agent_id: agentId,
				comm_id: "comm-001",
				delivered: 1,
				message_id: "msg-001",
			});
		} finally {
			db.close();
		}
	});

	it("rechaza tipos desconocidos y JSON roto", () => {
		const p = parseFrame('{"v":1,"t":"no.existe"}');
		expect(p.ok).toBe(true);
		if (p.ok) {
			const r = validateMessage("up", p.env);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.unknown).toBe(true);
		}
		expect(parseFrame("{no json").ok).toBe(false);
		expect(parseFrame("x".repeat(2_000_000)).ok).toBe(false);
	});
});
