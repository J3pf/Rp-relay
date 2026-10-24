import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { currentVersion, migrate, pendingMigrations, readMigrations } from "../src/db/migrate.js";
import { Repos } from "../src/db/repos/index.js";
import { runRetention } from "../src/retention.js";
import { watchdogIntervalMs } from "../src/util/sd.js";
import { DAY } from "../src/util/time.js";
import {
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
	promptBody,
	sleep,
	startRelay,
} from "./helpers.js";

describe("configuración", () => {
	it("aplica valores por defecto del plan", () => {
		const c = parseConfig({}, {});
		expect(c.listen).toEqual({ host: "127.0.0.1", port: 8787 });
		expect(c.dataDir).toBe("/var/lib/rp-relay");
		expect(c.limits).toMatchObject({
			blobMaxBytes: 26_214_400,
			blobTtlDays: 7,
			eventRetentionDays: 7,
			eventsPerAgent: 5000,
			promptGraceSeconds: 120,
		});
		expect(c.backup).toEqual({ enabled: true, intervalMinutes: 60, keepDays: 7 });
	});
	it("el JSON del plan es válido y las variables RP_* tienen prioridad", () => {
		const c = parseConfig(
			{
				listen: { host: "127.0.0.1", port: 8787 },
				publicUrl: "https://relay.midominio.com",
				dataDir: "/var/lib/rp-relay",
				fcm: { serviceAccountFile: "/etc/rp-relay/firebase-sa.json" },
				limits: { blobMaxBytes: 26214400, blobTtlDays: 7, eventRetentionDays: 7 },
				relayName: "Servidor casa",
			},
			{
				RP_LISTEN_PORT: "9000",
				RP_PUBLIC_URL: "https://otro.example",
				RP_DATA_DIR: "/data",
				LOG_LEVEL: "debug",
				RP_TLS_CERT: "/c",
				RP_TLS_KEY: "/k",
			},
		);
		expect(c.listen.port).toBe(9000);
		expect(c.publicUrl).toBe("https://otro.example");
		expect(c.dataDir).toBe("/data");
		expect(c.logLevel).toBe("debug");
		expect(c.fcm?.serviceAccountFile).toBe("/etc/rp-relay/firebase-sa.json");
		expect(c.tls).toEqual({ cert: "/c", key: "/k" });
		expect(parseConfig({}, { RP_ACME_DOMAIN: "r.example", RP_ACME_EMAIL: "a@b.c" }).tls).toEqual({
			acme: { domain: "r.example", email: "a@b.c" },
		});
	});
	it("rechaza valores inválidos con un mensaje claro", () => {
		expect(() => parseConfig({ listen: { port: 99999 } }, {})).toThrow(/configuración inválida/);
		expect(() => parseConfig({ limits: { blobMaxBytes: 1 } }, {})).toThrow(/limits/);
	});
});

describe("migraciones", () => {
	it("se aplican en orden, una sola vez, y registran la versión", () => {
		const db = openDb(":memory:");
		expect(currentVersion(db)).toBe(0);
		expect(pendingMigrations(db).length).toBe(readMigrations().length);
		const applied = migrate(db);
		expect(applied).toEqual(readMigrations().map((m) => m.version));
		expect(migrate(db)).toEqual([]);
		expect(currentVersion(db)).toBe(Math.max(...applied));
		const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
			(r) => r.name,
		);
		for (const tbl of [
			"devices",
			"machines",
			"pairing_codes",
			"agents",
			"events",
			"snapshots",
			"prompts",
			"blobs",
			"push_outbox",
			"relay_meta",
		])
			expect(tables).toContain(tbl);
		db.close();
	});
	it("una migración que falla no deja el esquema a medias", () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-mig-"));
		writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (x);");
		writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (x); CREATE TABLE b (y);");
		const db = openDb(":memory:");
		expect(() => migrate(db, { dir })).toThrow();
		expect(currentVersion(db)).toBe(1);
		expect(db.prepare("SELECT name FROM sqlite_master WHERE name='b'").get()).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
	it("relayId estable y currentVersion funciona en modo readonly", () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-ro-"));
		const file = join(dir, "ro.db");
		const dbRw = openDb(file);
		dbRw.close();
		const dbRo0 = openDb(file, { readonly: true });
		expect(currentVersion(dbRo0)).toBe(0);
		dbRo0.close();

		const db = openDb(file);
		migrate(db);
		const r = new Repos(db);
		expect(r.meta.relayId()).toBe(r.meta.relayId());
		db.close();

		const dbRo1 = openDb(file, { readonly: true });
		expect(currentVersion(dbRo1)).toBeGreaterThan(0);
		dbRo1.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("repositorios", () => {
	it("prompts: transición open→answered atómica", () => {
		const db = openDb(":memory:");
		migrate(db);
		const r = new Repos(db);
		r.prompts.insert("a:b", { promptId: "P", kind: "confirm", category: "permission", title: "t" } as never, 1);
		expect(r.prompts.answer("P", { confirmed: true }, "d1", 2)).toBe(true);
		expect(r.prompts.answer("P", { confirmed: false }, "d2", 3)).toBe(false);
		expect(r.prompts.get("P")).toMatchObject({ state: "answered", answered_by_device: "d1" });
		expect(r.prompts.close("P", "resolved", "remote", null, 4)).toBeTruthy();
		expect(r.prompts.close("P", "resolved", "local", null, 5)).toBeUndefined();
	});
	it("códigos de emparejamiento: consumo atómico y caducidad", () => {
		const db = openDb(":memory:");
		migrate(db);
		const r = new Repos(db);
		const h = Buffer.from("h");
		r.pairing.insert({ codeHash: h, kind: "device", expiresAt: 1000, createdBy: null });
		expect(r.pairing.consume(h, "device", 2000)).toBeUndefined(); // caducado
		r.pairing.insert({ codeHash: Buffer.from("h2"), kind: "device", expiresAt: 5000, createdBy: null });
		expect(r.pairing.consume(Buffer.from("h2"), "device", 2000)).toBeTruthy();
		expect(r.pairing.consume(Buffer.from("h2"), "device", 2000)).toBeUndefined();
	});
});

describe("retención", () => {
	it("elimina eventos viejos y excedentes, agentes offline > 7 d, prompts cerrados > 30 d, adjuntos caducados", async () => {
		const t = await startRelay({ limits: { eventsPerAgent: 10 } });
		try {
			await pairDevice(t);
			const m = await pairMachine(t);
			const agent = await connectAgent(t, m, "ret");
			for (let i = 0; i < 25; i++)
				agent.event({ type: "message_end", message: { role: "assistant", content: `m${i}` } });
			await sleep(150);
			const ctx = t.relay.ctx;
			ctx.repos.comms.upsert({
				agent_id: agent.agentId,
				comm_id: "retention-comm",
				machine_id: m.machineId,
				direction: "out",
				channel: "intercom",
				action: "message",
				peer_session_id: null,
				peer_name: null,
				peer_cwd: null,
				peer_ref: null,
				message_id: null,
				reply_to: null,
				expects_reply: false,
				text: "retention",
				truncated: false,
				delivered: null,
				at: Date.now(),
			});
			expect(ctx.repos.events.count(agent.agentId)).toBe(25);
			let s = await runRetention(ctx);
			expect(s.events).toBe(15);
			expect(ctx.repos.events.count(agent.agentId)).toBe(10);
			const kept = t.relay.db.prepare("SELECT MIN(seq) AS a, MAX(seq) AS b FROM events").get();
			expect(kept).toEqual({ a: 16, b: 25 }); // se conservan los más recientes

			// por antigüedad
			s = await runRetention(ctx, Date.now() + 8 * DAY);
			expect(s.events).toBe(10);
			expect(s.comms).toBe(1);
			expect(ctx.repos.comms.get(agent.agentId, "retention-comm")).toBeUndefined();

			// prompt cerrado antiguo
			agent.client.send("prompt.open", promptBody(agent.agentId, { promptId: "OLDP" }));
			await sleep(50);
			agent.client.send("prompt.resolved", { promptId: "OLDP", by: "local" });
			await sleep(50);
			s = await runRetention(ctx, Date.now() + 31 * DAY);
			expect(s.prompts).toBe(1);
			expect(ctx.repos.prompts.get("OLDP")).toBeUndefined();

			// agente conectado no se purga; offline > 7 días sí (con sus eventos)
			s = await runRetention(ctx, Date.now() + 9 * DAY);
			expect(s.agents).toBe(0);
			agent.client.close();
			await sleep(100);
			s = await runRetention(ctx, Date.now() + 9 * DAY);
			expect(s.agents).toBe(1);
			expect(ctx.repos.agents.get(agent.agentId)).toBeUndefined();
		} finally {
			await t.stop();
			cleanup(t);
		}
	});

	it("no purga agentes con prompts abiertos... y expira respuestas 'answered' abandonadas notificando a las apps", async () => {
		const t = await startRelay();
		try {
			const m = await pairMachine(t);
			const agent = await connectAgent(t, m, "ret2");
			agent.client.send("prompt.open", promptBody(agent.agentId, { promptId: "ABAND" }));
			await sleep(50);
			const dev = await pairDevice(t);
			const { client: app } = await connectApp(t, dev);
			t.relay.ctx.prompts.answer("ABAND", { confirmed: true }, dev.deviceId);
			agent.client.close();
			await sleep(50);
			const s = await runRetention(t.relay.ctx, Date.now() + 2 * DAY);
			expect(s.staleAnswered).toBe(1);
			expect(s.agents).toBe(0); // tenía una respuesta pendiente: no se purga en esta pasada
			expect(t.relay.ctx.repos.prompts.get("ABAND")!.state).toBe("expired");
			const resolved = await app.next((e) => e.t === "prompt.resolved" && (e.d as any).promptId === "ABAND");
			expect(resolved.d).toMatchObject({ promptId: "ABAND", by: "timeout" });
			expect((await runRetention(t.relay.ctx, Date.now() + 9 * DAY)).agents).toBe(1); // ya sin prompts abiertos, sí
			app.close();
		} finally {
			await t.stop();
			cleanup(t);
		}
	});
});

describe("systemd", () => {
	it("el intervalo del watchdog es 10 s por defecto y la mitad de WATCHDOG_USEC si está definido", () => {
		expect(watchdogIntervalMs({})).toBeNull();
		expect(watchdogIntervalMs({ NOTIFY_SOCKET: "/run/systemd/notify" })).toBe(10_000);
		expect(watchdogIntervalMs({ NOTIFY_SOCKET: "/x", WATCHDOG_USEC: "30000000" })).toBe(15_000);
	});
});
