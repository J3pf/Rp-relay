import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { ApnsError, BAD_DEVICE_TOKEN } from "../src/push/apns.js";
import { decryptPush, encryptPush } from "../src/push/crypto.js";
import { fitBody } from "../src/push/dispatcher.js";
import { FcmError } from "../src/push/fcm.js";
import { inQuietHours, shouldNotify } from "../src/push/prefs.js";
import {
	api,
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
	promptBody,
	sleep,
	startRelay,
	type TestRelay,
} from "./helpers.js";

describe("cifrado de push", () => {
	const vec = JSON.parse(
		readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "protocol", "fixtures", "push-vector.json"),
			"utf8",
		),
	);
	it("vector conocido compartido con la app (AES-256-GCM, AAD rp1)", () => {
		const key = Buffer.from(vec.key, "base64");
		const enc = encryptPush(key, vec.plaintext, Buffer.from(vec.nonce, "base64"));
		expect(enc.c).toBe(vec.ciphertext);
		expect(decryptPush(key, { n: vec.nonce, c: vec.ciphertext })).toBe(vec.plaintext);
	});
	it("nonce aleatorio distinto en cada mensaje; manipulación y AAD incorrectos fallan", () => {
		const key = Buffer.alloc(32, 7);
		const a = encryptPush(key, { x: 1 });
		const b = encryptPush(key, { x: 1 });
		expect(a.n).not.toBe(b.n);
		expect(JSON.parse(decryptPush(key, a))).toEqual({ x: 1 });
		const tampered = Buffer.from(a.c, "base64");
		tampered[0]! ^= 1;
		expect(() => decryptPush(key, { n: a.n, c: tampered.toString("base64") })).toThrow();
		expect(() => decryptPush(Buffer.alloc(32, 8), a)).toThrow();
		expect(() => encryptPush(Buffer.alloc(16), {})).toThrow();
	});
	it("fitBody recorta el mensaje para respetar el límite", () => {
		const body = fitBody({ title: "t", message: "x".repeat(10_000), options: [1, 2, 3, 4, 5] }, 1000);
		expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(1000);
		expect((body.message as string).endsWith("…")).toBe(true);
	});
});

describe("preferencias de notificación", () => {
	const base = { machineId: "M1", machineQuiet: null, now: Date.parse("2026-10-13T15:00:00Z") };
	it("por defecto todo activo", () => {
		for (const category of ["permission", "question", "settled", "error", "terminal_wait"] as const) {
			expect(shouldNotify({ ...base, prefs: {}, category })).toBe(true);
		}
	});
	it("categorías globales y override por PC", () => {
		const prefs = { categories: { settled: false }, machines: { M1: { categories: { settled: true, error: false } } } };
		expect(shouldNotify({ ...base, prefs, category: "settled" })).toBe(true);
		expect(shouldNotify({ ...base, prefs, category: "error" })).toBe(false);
		expect(shouldNotify({ ...base, machineId: "M2", prefs, category: "settled" })).toBe(false);
	});
	it("PC silenciada; 'autorizaciones críticas siempre' la ignora sólo para danger=high", () => {
		const prefs = { machines: { M1: { mute: true } } };
		expect(shouldNotify({ ...base, prefs, category: "permission", danger: "high" })).toBe(false);
		expect(
			shouldNotify({ ...base, prefs: { ...prefs, criticalAlways: true }, category: "permission", danger: "high" }),
		).toBe(true);
		expect(
			shouldNotify({ ...base, prefs: { ...prefs, criticalAlways: true }, category: "permission", danger: "low" }),
		).toBe(false);
		expect(
			shouldNotify({ ...base, prefs: { ...prefs, criticalAlways: true }, category: "question", danger: "high" }),
		).toBe(false);
	});
	it("horas silenciosas con zona horaria y cruce de medianoche", () => {
		const q = { from: "20:00", to: "08:00", tz: "America/Bogota" }; // UTC-5
		expect(inQuietHours(q, Date.parse("2026-10-13T15:00:00Z"))).toBe(false); // 10:00 Bogotá
		expect(inQuietHours(q, Date.parse("2026-10-14T02:00:00Z"))).toBe(true); // 21:00 Bogotá
		expect(inQuietHours(q, Date.parse("2026-10-13T12:30:00Z"))).toBe(true); // 07:30 Bogotá
		expect(inQuietHours({ from: "09:00", to: "17:00" }, Date.parse("2026-10-13T12:00:00Z"))).toBe(true);
		expect(inQuietHours({ from: "09:00", to: "17:00" }, Date.parse("2026-10-13T18:00:00Z"))).toBe(false);
		expect(inQuietHours({ from: "09:00", to: "09:00" }, Date.now())).toBe(false);
		expect(inQuietHours({ from: "00:00", to: "23:59", tz: "No/Existe" }, Date.now())).toBe(true); // tz inválida → UTC
		expect(inQuietHours(null, Date.now())).toBe(false);
	});
	it("horas silenciosas de la PC por defecto, sobrescritas por las del dispositivo", () => {
		const quiet = { from: "00:00", to: "23:59" };
		expect(shouldNotify({ ...base, machineQuiet: quiet, prefs: {}, category: "question" })).toBe(false);
		expect(
			shouldNotify({
				...base,
				machineQuiet: quiet,
				prefs: { machines: { M1: { quietHours: null } } },
				category: "question",
			}),
		).toBe(true);
	});
});

const APNS_TEST_CONFIG = {
	apns: {
		keyId: "test-key-id",
		teamId: "test-team-id",
		keyFile: "/not-read-by-fake-apns.p8",
		bundleId: "com.example.rp",
		env: "production",
	},
};

let t: TestRelay;
beforeEach(async () => {
	t = await startRelay(APNS_TEST_CONFIG);
});
afterEach(async () => {
	await t.stop();
	cleanup(t);
});

async function enableFcm(dev: { deviceToken: string }, token = "fcm-token-1", direct = false) {
	const r = await api(t, "PUT", "/v1/devices/me/push", dev.deviceToken, { fcmToken: token, direct });
	expect(r.status).toBe(200);
}

async function enableApns(
	dev: { deviceToken: string },
	token = "apns-token-1",
	environment: "sandbox" | "production" = "production",
	direct = false,
) {
	const r = await api(t, "PUT", "/v1/devices/me/push", dev.deviceToken, {
		apnsToken: token,
		apnsEnvironment: environment,
		direct,
	});
	expect(r.status).toBe(200);
}

describe("canal FCM", () => {
	it("prompt → data-only cifrado con la clave del dispositivo, prioridad alta, collapse_key=promptId; cancel al resolver", async () => {
		const dev = await pairDevice(t);
		await enableFcm(dev);
		const m = await pairMachine(t, "devbox", { name: "PC Empresa", context: "work" });
		const agent = await connectAgent(t, m, "f1");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		await sleep(150);
		const msg = t.fcm.sent.find((x) => x.data.k === "prompt")!;
		expect(msg.token).toBe("fcm-token-1");
		expect(msg.android).toMatchObject({ priority: "high", ttl: 3_600_000, collapseKey: p.promptId });
		expect(Object.keys(msg.data).sort()).toEqual(["c", "k", "n", "v"]);
		expect(msg.data.v).toBe("1");
		const body = JSON.parse(decryptPush(dev.pushKey, { n: msg.data.n!, c: msg.data.c! }));
		expect(body).toMatchObject({
			promptId: p.promptId,
			agentId: agent.agentId,
			agentLabel: "refactor auth",
			machineName: "PC Empresa",
			machineContext: "work",
			kind: "confirm",
			category: "permission",
			danger: "high",
			allowFreeText: false,
		});
		expect(body.options).toEqual([
			{ id: "0", label: "Permitir" },
			{ id: "1", label: "Denegar" },
		]);
		expect(JSON.stringify(msg)).not.toContain("rm -rf"); // Google no ve el contenido

		agent.client.send("prompt.resolved", { promptId: p.promptId, by: "local" });
		await sleep(150);
		const cancel = t.fcm.sent.find((x) => x.data.k === "cancel")!;
		expect(JSON.parse(decryptPush(dev.pushKey, { n: cancel.data.n!, c: cancel.data.c! }))).toMatchObject({
			promptId: p.promptId,
		});
		expect(cancel.android.priority).toBe("normal");
		agent.client.close();
	});

	it("'terminado' (settled): normal; no se envía si el dispositivo está viendo ese agente", async () => {
		const dev = await pairDevice(t);
		await enableFcm(dev);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "f2");
		agent.event({ type: "message_end", message: { role: "assistant", content: "Todo listo" } });
		agent.event({ type: "agent_settled", aborted: false });
		await sleep(150);
		const settled = t.fcm.sent.filter((x) => x.data.k === "settled");
		expect(settled).toHaveLength(1);
		expect(settled[0]!.android.priority).toBe("normal");
		expect(JSON.parse(decryptPush(dev.pushKey, { n: settled[0]!.data.n!, c: settled[0]!.data.c! }))).toMatchObject({
			agentId: agent.agentId,
			preview: "Todo listo",
		});

		// ahora el usuario mira el agente → no se notifica
		const { client: app } = await connectApp(t, dev);
		app.send("agent.subscribe", { agentId: agent.agentId, sinceSeq: null, epoch: null });
		await app.next("agent.history");
		agent.event({ type: "agent_settled", aborted: false });
		await sleep(150);
		expect(t.fcm.sent.filter((x) => x.data.k === "settled")).toHaveLength(1);
		// abortado → tampoco
		app.close();
		await sleep(50);
		agent.event({ type: "agent_settled", aborted: true });
		await sleep(100);
		expect(t.fcm.sent.filter((x) => x.data.k === "settled")).toHaveLength(1);
		agent.client.close();
	});

	it("error de agente y terminal_wait generan notificaciones", async () => {
		const dev = await pairDevice(t);
		await enableFcm(dev);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "f3");
		agent.client.send("agent.status", { status: "error", detail: "rate limit" });
		agent.event({ type: "terminal_wait", kind: "custom", title: "Elige tema", active: true });
		agent.event({ type: "terminal_wait", kind: "custom", title: "Elige tema", active: false });
		await sleep(200);
		expect(t.fcm.sent.filter((x) => x.data.k === "error")).toHaveLength(1);
		expect(t.fcm.sent.filter((x) => x.data.k === "terminal_wait")).toHaveLength(1); // sólo al activarse
		agent.client.close();
	});

	it("prefs por PC: silenciar la PC de empresa no afecta a la personal", async () => {
		const dev = await pairDevice(t);
		await enableFcm(dev);
		const work = await pairMachine(t, "empresa", { name: "Empresa", context: "work" });
		const home = await pairMachine(t, "casa", { name: "Casa", context: "personal" });
		const r = await api(t, "PUT", "/v1/devices/me/prefs", dev.deviceToken, {
			machines: { [work.machineId]: { mute: true } },
		});
		expect(r.status).toBe(200);
		expect((await api(t, "GET", "/v1/devices/me/prefs", dev.deviceToken)).json.machines[work.machineId].mute).toBe(
			true,
		);
		const a1 = await connectAgent(t, work, "w1");
		const a2 = await connectAgent(t, home, "h1");
		a1.client.send("prompt.open", promptBody(a1.agentId, { danger: "low" }));
		a2.client.send("prompt.open", promptBody(a2.agentId, { danger: "low" }));
		await sleep(200);
		const prompts = t.fcm.sent.filter((x) => x.data.k === "prompt");
		expect(prompts).toHaveLength(1);
		expect(JSON.parse(decryptPush(dev.pushKey, { n: prompts[0]!.data.n!, c: prompts[0]!.data.c! })).machineName).toBe(
			"Casa",
		);
		a1.client.close();
		a2.client.close();
	});

	it("horas silenciosas de la PC (PATCH quietHours) bloquean salvo críticas con la preferencia", async () => {
		const dev = await pairDevice(t);
		await enableFcm(dev);
		const m = await pairMachine(t);
		await api(t, "PATCH", `/v1/machines/${m.machineId}`, dev.deviceToken, {
			quietHours: { from: "00:00", to: "23:59", tz: "UTC" },
		});
		const agent = await connectAgent(t, m, "q1");
		agent.client.send("prompt.open", promptBody(agent.agentId, { danger: "high" }));
		await sleep(150);
		expect(t.fcm.sent.filter((x) => x.data.k === "prompt")).toHaveLength(0);
		await api(t, "PUT", "/v1/devices/me/prefs", dev.deviceToken, { criticalAlways: true });
		agent.client.send("prompt.open", promptBody(agent.agentId, { danger: "high" }));
		await sleep(150);
		expect(t.fcm.sent.filter((x) => x.data.k === "prompt")).toHaveLength(1);
		agent.client.close();
	});

	it("token no registrado → se borra; otros errores no", async () => {
		const dev = await pairDevice(t);
		await enableFcm(dev);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "e1");
		t.fcm.fail = new FcmError("messaging/internal-error", "boom");
		agent.client.send("prompt.open", promptBody(agent.agentId));
		await sleep(150);
		expect(t.relay.ctx.repos.devices.get(dev.deviceId)!.fcm_token).toBe("fcm-token-1");
		t.fcm.fail = new FcmError("messaging/registration-token-not-registered", "gone");
		agent.client.send("prompt.open", promptBody(agent.agentId));
		await sleep(150);
		expect(t.relay.ctx.repos.devices.get(dev.deviceId)!.fcm_token).toBeNull();
		agent.client.close();
	});

	it("sin FCM configurado el relay funciona sólo con el canal directo", async () => {
		await t.stop();
		cleanup(t);
		t = await startRelay({}, { fcm: null });
		expect(t.relay.ctx.dispatcher.fcmEnabled).toBe(false);
		const dev = await pairDevice(t);
		await enableFcm(dev, "fcm-token-1", true); // aunque la app registre token, no hay emisor
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "n1");
		const { client: direct } = await connectApp(t, dev, "direct");
		agent.client.send("prompt.open", promptBody(agent.agentId));
		expect((await direct.next("push.notify")).d).toMatchObject({ k: "prompt" });
		agent.client.close();
		direct.close();
	});
});

describe("canal APNs", () => {
	it("prompt → sobre cifrado opaco con alerta genérica, NSE mutable, collapse-id y prioridad alta", async () => {
		const dev = await pairDevice(t);
		await enableApns(dev);
		const m = await pairMachine(t, "devbox", { name: "PC Empresa", context: "work" });
		const agent = await connectAgent(t, m, "apns-prompt");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		await sleep(150);

		const msg = t.apns!.sent.find((x) => x.payload.k === "prompt")!;
		expect(msg.token).toBe("apns-token-1");
		expect(msg.host).toBe("api.push.apple.com");
		expect(Object.keys(msg.payload).sort()).toEqual(["aps", "c", "k", "n", "v"]);
		expect(msg.payload).toMatchObject({ v: "1", k: "prompt", n: expect.any(String), c: expect.any(String) });
		const aps = msg.payload.aps as { [key: string]: unknown; alert: { title: string; body: string } };
		expect(aps["mutable-content"]).toBe(1);
		expect(aps.alert.title).not.toContain(p.title);
		expect(aps.alert.body).not.toContain(p.title);
		expect(msg.headers).toEqual({
			topic: "com.example.rp",
			collapseId: p.promptId,
			pushType: "alert",
			priority: 10,
		});
		const body = JSON.parse(decryptPush(dev.pushKey, { n: msg.payload.n as string, c: msg.payload.c as string }));
		expect(body).toMatchObject({ promptId: p.promptId, title: p.title, message: p.message, agentId: agent.agentId });
		agent.client.close();
	});

	it("cancel, settled, error y terminal_wait usan el mismo sobre cifrado y prioridad 5", async () => {
		const dev = await pairDevice(t);
		await enableApns(dev);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "apns-events");
		const p = promptBody(agent.agentId);
		agent.client.send("prompt.open", p);
		await sleep(100);
		agent.client.send("prompt.resolved", { promptId: p.promptId, by: "local" });
		agent.event({ type: "message_end", message: { role: "assistant", content: "Todo listo" } });
		agent.event({ type: "agent_settled", aborted: false });
		agent.client.send("agent.status", { status: "error", detail: "rate limit" });
		agent.event({ type: "terminal_wait", kind: "custom", title: "Elige tema", active: true });
		agent.event({ type: "terminal_wait", kind: "custom", title: "Elige tema", active: false });
		await sleep(300);

		const kinds = ["cancel", "settled", "error", "terminal_wait"];
		for (const kind of kinds) {
			const messages = t.apns!.sent.filter((x) => x.payload.k === kind);
			expect(messages).toHaveLength(1);
			const msg = messages[0]!;
			expect(msg.headers.priority).toBe(5);
			expect(Object.keys(msg.payload).sort()).toEqual(["aps", "c", "k", "n", "v"]);
			expect(msg.payload).toMatchObject({ v: "1", k: kind, n: expect.any(String), c: expect.any(String) });
			expect(
				JSON.parse(decryptPush(dev.pushKey, { n: msg.payload.n as string, c: msg.payload.c as string })),
			).toBeTypeOf("object");
		}
		agent.client.close();
	});

	it("dirige sandbox y production a sus hosts APNs respectivos", async () => {
		const sandbox = await pairDevice(t, "iPhone Sandbox");
		const production = await pairDevice(t, "iPhone Production");
		await enableApns(sandbox, "sandbox-token", "sandbox");
		await enableApns(production, "production-token", "production");
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "apns-hosts");
		agent.client.send("prompt.open", promptBody(agent.agentId));
		await sleep(150);

		expect(t.apns!.sent).toHaveLength(2);
		expect(t.apns!.sent.find((x) => x.token === "sandbox-token")?.host).toBe("api.development.push.apple.com");
		expect(t.apns!.sent.find((x) => x.token === "production-token")?.host).toBe("api.push.apple.com");
		agent.client.close();
	});

	it("BAD_DEVICE_TOKEN borra token y entorno; un 5xx conserva el registro", async () => {
		const dev = await pairDevice(t);
		await enableApns(dev);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "apns-cleanup");
		t.apns!.fail = new ApnsError(BAD_DEVICE_TOKEN, 410, "Unregistered");
		agent.client.send("prompt.open", promptBody(agent.agentId));
		await sleep(150);
		expect(t.relay.ctx.repos.devices.get(dev.deviceId)).toMatchObject({ apns_token: null, apns_env: null });

		await enableApns(dev);
		t.apns!.fail = new ApnsError("InternalServerError", 500, "boom");
		agent.client.send("prompt.open", promptBody(agent.agentId));
		await sleep(150);
		expect(t.relay.ctx.repos.devices.get(dev.deviceId)).toMatchObject({
			apns_token: "apns-token-1",
			apns_env: "production",
		});
		agent.client.close();
	});

	it("push-test informa APNs enviado y considera exitoso el canal APNs", async () => {
		const dev = await pairDevice(t);
		await enableApns(dev);
		const r = await api(t, "POST", "/v1/devices/me/push-test", dev.deviceToken);
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ ok: true, results: [{ deviceId: dev.deviceId, apns: "sent" }] });
		expect(t.apns!.sent.at(-1)!.payload.k).toBe("test");
		expect(t.apns!.sent.at(-1)!.headers.priority).toBe(10);
	});

	it("sin sender APNs configurado devuelve apns=off", async () => {
		await t.stop();
		cleanup(t);
		t = await startRelay({}, { apns: null });
		const dev = await pairDevice(t);
		await enableApns(dev);
		const r = await api(t, "POST", "/v1/devices/me/push-test", dev.deviceToken);
		expect(r.status).toBe(200);
		expect(r.json.results[0]).toMatchObject({ deviceId: dev.deviceId, apns: "off" });
	});

	it("RP_APNS_* configura la autenticación y el topic por entorno", () => {
		const config = parseConfig(
			{},
			{
				RP_APNS_KEY_ID: "env-key-id",
				RP_APNS_TEAM_ID: "env-team-id",
				RP_APNS_KEY_FILE: "/keys/apns.p8",
				RP_APNS_BUNDLE_ID: "com.example.env",
				RP_APNS_ENV: "sandbox",
			},
		);
		expect(config.apns).toEqual({
			keyId: "env-key-id",
			teamId: "env-team-id",
			keyFile: "/keys/apns.p8",
			bundleId: "com.example.env",
			env: "sandbox",
		});
	});
});

describe("canal directo", () => {
	it("pendientes: si el dispositivo no está conectado, se entrega al reconectar (prompts ya resueltos se descartan)", async () => {
		const dev = await pairDevice(t);
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "d1");
		const p1 = promptBody(agent.agentId, { promptId: "PEND1" });
		const p2 = promptBody(agent.agentId, { promptId: "PEND2" });
		agent.client.send("prompt.open", p1);
		agent.client.send("prompt.open", p2);
		await sleep(100);
		agent.client.send("prompt.resolved", { promptId: "PEND2", by: "local" });
		await sleep(100);
		const { client: direct } = await connectApp(t, dev, "direct");
		const first = await direct.next("push.notify");
		expect(first.d as any).toMatchObject({ k: "prompt", body: { promptId: "PEND1" } });
		await sleep(150);
		// PEND2 ya no está abierto: sólo llega su cancel pendiente (si no se acusó), nunca el prompt
		expect(
			direct.msgs.filter(
				(e) => e.t === "push.notify" && (e.d as any).k === "prompt" && (e.d as any).body.promptId === "PEND2",
			),
		).toHaveLength(0);
		// tras push.ack no se reenvía en la siguiente reconexión
		direct.send("push.ack", { pushId: (first.d as any).pushId });
		await sleep(50);
		direct.close();
		await sleep(50);
		const { client: again } = await connectApp(t, dev, "direct");
		await sleep(150);
		expect(again.msgs.filter((e) => e.t === "push.notify" && (e.d as any).body?.promptId === "PEND1")).toHaveLength(0);
		agent.client.close();
		again.close();
	});

	it("dispositivo con direct=false no recibe por el canal directo", async () => {
		const dev = await pairDevice(t);
		await api(t, "PUT", "/v1/devices/me/push", dev.deviceToken, { direct: false });
		const m = await pairMachine(t);
		const agent = await connectAgent(t, m, "d2");
		const { client: direct } = await connectApp(t, dev, "direct");
		agent.client.send("prompt.open", promptBody(agent.agentId));
		await direct.never("push.notify", 300);
		// pero la app en primer plano sí recibe prompt.opened por WS
		agent.client.close();
		direct.close();
	});

	it("push-test: envía por ambos canales y devuelve el resultado", async () => {
		const dev = await pairDevice(t);
		await enableFcm(dev, "tok", true);
		const { client: direct } = await connectApp(t, dev, "direct");
		const r = await api(t, "POST", "/v1/devices/me/push-test", dev.deviceToken);
		expect(r.status).toBe(200);
		expect(r.json.results[0]).toMatchObject({ deviceId: dev.deviceId, direct: "sent", fcm: "sent" });
		expect((await direct.next("push.notify")).d).toMatchObject({ k: "test" });
		expect(t.fcm.sent.at(-1)!.data.k).toBe("test");
		direct.close();
	});
});
