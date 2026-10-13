import { createHash } from "node:crypto";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sanitizeName } from "../src/blobs/store.js";
import {
	api,
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
	sleep,
	startRelay,
	type TestRelay,
} from "./helpers.js";

let t: TestRelay;
beforeEach(async () => {
	t = await startRelay({ limits: { blobMaxBytes: 2048 } });
});
afterEach(async () => {
	await t.stop();
	cleanup(t);
});

async function upload(token: string, content: Buffer | string, name = "nota.txt", mime = "text/plain") {
	const fd = new FormData();
	fd.append("file", new Blob([new Uint8Array(Buffer.from(content))], { type: mime }), name);
	const res = await fetch(`${t.http}/v1/blobs`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: fd,
	});
	return { status: res.status, json: (await res.json()) as any };
}

describe("adjuntos (blobs)", () => {
	it("subida → sha256, tamaño y mime; descarga idéntica por el dispositivo", async () => {
		const dev = await pairDevice(t);
		const content = Buffer.from("contenido del adjunto ✓");
		const up = await upload(dev.deviceToken, content, "informe final.txt", "text/plain");
		expect(up.status).toBe(201);
		expect(up.json).toMatchObject({
			size: content.length,
			mime: "text/plain",
			sha256: createHash("sha256").update(content).digest("hex"),
		});
		const res = await fetch(`${t.http}/v1/blobs/${up.json.blobId}`, {
			headers: { authorization: `Bearer ${dev.deviceToken}` },
		});
		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer()).equals(content)).toBe(true);
		expect(res.headers.get("content-type")).toBe("text/plain");
		expect(res.headers.get("content-disposition")).toContain("informe%20final.txt");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("etag")).toBe(`"${up.json.sha256}"`);
	});

	it("exige autenticación y rechaza peticiones sin archivo", async () => {
		const fd = new FormData();
		fd.append("file", new Blob(["x"]), "a.txt");
		expect((await fetch(`${t.http}/v1/blobs`, { method: "POST", body: fd })).status).toBe(401);
		const dev = await pairDevice(t);
		const r = await fetch(`${t.http}/v1/blobs`, {
			method: "POST",
			headers: { authorization: `Bearer ${dev.deviceToken}`, "content-type": "multipart/form-data; boundary=x" },
			body: "--x--\r\n",
		});
		expect(r.status).toBeGreaterThanOrEqual(400);
		expect(
			(await fetch(`${t.http}/v1/blobs/NOPE`, { headers: { authorization: `Bearer ${dev.deviceToken}` } })).status,
		).toBe(404);
	});

	it("límite de tamaño → 413 too_large y no queda basura en disco", async () => {
		const dev = await pairDevice(t);
		const up = await upload(dev.deviceToken, Buffer.alloc(5000, 1), "grande.bin", "application/octet-stream");
		expect(up.status).toBe(413);
		expect(up.json.error.code).toBe("too_large");
		const { readdirSync } = await import("node:fs");
		expect(readdirSync(join(t.dir, "blobs"))).toEqual([]);
	});

	it("una PC sólo descarga adjuntos referenciados por mensajes enrutados a sus agentes", async () => {
		const dev = await pairDevice(t);
		const m1 = await pairMachine(t);
		const m2 = await pairMachine(t);
		const agent = await connectAgent(t, m1, "b1");
		const { client: app } = await connectApp(t, dev);
		const up = await upload(dev.deviceToken, "secreto", "s.txt");
		const dl = (token: string) =>
			fetch(`${t.http}/v1/blobs/${up.json.blobId}`, { headers: { authorization: `Bearer ${token}` } });
		expect((await dl(m1.machineToken)).status).toBe(404); // aún no enviado
		const att = { blobId: up.json.blobId, name: "s.txt", mime: "text/plain", size: 7 };
		app.send("user.message", { agentId: agent.agentId, clientMsgId: "B1", text: "mira esto", attachments: [att] });
		const fwd = await agent.client.next("user.message");
		expect((fwd.d as any).attachments).toEqual([att]);
		expect((await dl(m1.machineToken)).status).toBe(200);
		expect(await (await dl(m1.machineToken)).text()).toBe("secreto");
		expect((await dl(m2.machineToken)).status).toBe(404); // otra PC no
		expect((await dl("rpm_falso")).status).toBe(401);
		agent.client.send("user.message.ack", { clientMsgId: "B1", disposition: "sent", method: "api" });
		await app.next("user.message.ack");
		agent.client.close();
		app.close();
	});

	it("mensaje con adjunto inexistente → not_found", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "b2");
		const { client: app } = await connectApp(t, dev);
		app.send("user.message", {
			agentId: agent.agentId,
			clientMsgId: "B2",
			text: "x",
			attachments: [{ blobId: "FANTASMA", name: "a", mime: "text/plain", size: 1 }],
		});
		expect((await app.next("error")).d).toMatchObject({ code: "not_found" });
		agent.client.close();
		app.close();
	});

	it("GC: borra caducados (archivo + fila), .part viejos y huérfanos", async () => {
		const dev = await pairDevice(t);
		const up = await upload(dev.deviceToken, "viejo");
		const file = join(t.dir, "blobs", up.json.blobId);
		expect(existsSync(file)).toBe(true);
		const orphan = join(t.dir, "blobs", "HUERFANO");
		writeFileSync(orphan, "x");
		const part = join(t.dir, "blobs", "X.part");
		writeFileSync(part, "x");
		const old = new Date(Date.now() - 2 * 3_600_000);
		utimesSync(orphan, old, old);
		utimesSync(part, old, old);
		const store = t.relay.ctx.blobs;
		expect(await store.gc(Date.now())).toBe(2); // huérfano y .part; el blob vigente se conserva
		expect(existsSync(file)).toBe(true);
		const removed = await store.gc(Date.now() + 8 * 86_400_000); // 8 días después
		expect(removed).toBeGreaterThanOrEqual(1);
		expect(existsSync(file)).toBe(false);
		expect(t.relay.ctx.repos.blobs.get(up.json.blobId)).toBeUndefined();
		expect(
			(await fetch(`${t.http}/v1/blobs/${up.json.blobId}`, { headers: { authorization: `Bearer ${dev.deviceToken}` } }))
				.status,
		).toBe(404);
		await sleep(1);
	});

	it("un blob caducado no se descarga aunque el GC no haya corrido", async () => {
		const dev = await pairDevice(t);
		const up = await upload(dev.deviceToken, "caduca");
		t.relay.db.prepare("UPDATE blobs SET expires_at=? WHERE id=?").run(Date.now() - 1, up.json.blobId);
		expect(
			(await fetch(`${t.http}/v1/blobs/${up.json.blobId}`, { headers: { authorization: `Bearer ${dev.deviceToken}` } }))
				.status,
		).toBe(404);
	});

	it("sanitizeName elimina rutas y caracteres de control", () => {
		expect(sanitizeName("../../etc/passwd")).toBe("passwd");
		expect(sanitizeName("C:\\Users\\x\\foto.png")).toBe("foto.png");
		expect(sanitizeName('a"b\u0000c.txt')).toBe("abc.txt");
		expect(sanitizeName(undefined)).toBe("archivo");
		expect(sanitizeName("x".repeat(500)).length).toBe(200);
	});
});
void api;
