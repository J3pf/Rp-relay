import { readFileSync } from "node:fs";
import { CloseCode } from "@j3pf/rp-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { hashToken, newPairingCode, normalizeCode } from "../src/auth/tokens.js";
import { parseConfig } from "../src/config.js";
import { MAX_ACTIVE_PAIRING_CODES } from "../src/db/repos/pairing.js";
import { buildHttp } from "../src/http/server.js";
import { createLogger } from "../src/util/log.js";
import { LongPollRegistry } from "../src/ws/agentGateway.js";
import { api, cleanup, newCode, pairDevice, pairMachine, startRelay, type TestRelay } from "./helpers.js";

let t: TestRelay;
beforeAll(async () => {
	t = await startRelay();
});
afterAll(async () => {
	await t.stop();
	cleanup(t);
});

describe("tokens", () => {
	it("códigos de 8 caracteres base32 y normalización tolerante", () => {
		const code = newPairingCode();
		expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
		expect(normalizeCode("abcd-ef0o")).toBe("ABCDEF00");
		expect(normalizeCode("il1l")).toBe("1111");
		expect(hashToken("x")).toHaveLength(32);
	});
});

describe("emparejamiento", () => {
	it("dispositivo: código de un solo uso", async () => {
		const code = newCode(t, "device");
		const ok = await api(t, "POST", "/v1/pair/device", null, {
			code: `${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`,
			name: "Pixel 9",
		});
		expect(ok.status).toBe(200);
		expect(ok.json.deviceToken).toMatch(/^rpd_/);
		expect(Buffer.from(ok.json.pushKey, "base64")).toHaveLength(32);
		expect(ok.json.relayName).toBe("Test");
		expect(ok.json.relayId).toBeTruthy();
		const again = await api(t, "POST", "/v1/pair/device", null, { code, name: "otro" });
		expect(again.status).toBe(401);
		expect(again.json.error.code).toBe("unauthorized");
	});

	it("el token sólo se guarda hasheado", async () => {
		const d = await pairDevice(t);
		const rows = t.relay.db.prepare("SELECT token_hash FROM devices WHERE id=?").get(d.deviceId) as {
			token_hash: Buffer;
		};
		expect(rows.token_hash.equals(hashToken(d.deviceToken))).toBe(true);
		expect(
			t.relay.db.prepare("SELECT COUNT(*) AS n FROM devices WHERE token_hash=?").get(Buffer.from(d.deviceToken)) as {
				n: number;
			},
		).toEqual({ n: 0 });
	});

	it("un código de máquina no sirve para dispositivo y viceversa", async () => {
		const mc = newCode(t, "machine");
		expect((await api(t, "POST", "/v1/pair/device", null, { code: mc, name: "x" })).status).toBe(401);
		const dc = newCode(t, "device");
		expect((await api(t, "POST", "/v1/pair/machine", null, { code: dc, hostname: "h" })).status).toBe(401);
	});

	it("código caducado", async () => {
		const { code } = t.relay.ctx.pairing.createCode("device", "t", undefined, -1000);
		expect((await api(t, "POST", "/v1/pair/device", null, { code, name: "x" })).status).toBe(401);
	});

	it("máquina: nombre/contexto desde el código o la petición", async () => {
		const m1 = await pairMachine(t, "pc-empresa", { name: "PC Empresa", context: "work" });
		const row = t.relay.ctx.repos.machines.get(m1.machineId)!;
		expect(row.name).toBe("PC Empresa");
		expect(row.context).toBe("work");
		const r = await api(t, "POST", "/v1/pair/machine", null, {
			code: newCode(t, "machine"),
			hostname: "portatil",
			name: "Portátil",
			context: "personal",
		});
		expect(r.json.machineToken).toMatch(/^rpm_/);
		expect(t.relay.ctx.repos.machines.get(r.json.machineId)!.name).toBe("Portátil");
	});

	it("la app puede crear códigos para emparejar una PC", async () => {
		const d = await pairDevice(t);
		const r = await api(t, "POST", "/v1/pair/codes", d.deviceToken, { name: "Servidor", context: "work" });
		expect(r.status).toBe(200);
		const m = await api(t, "POST", "/v1/pair/machine", null, { code: r.json.code, hostname: "srv" });
		expect(m.status).toBe(200);
		expect(t.relay.ctx.repos.machines.get(m.json.machineId)!.context).toBe("work");
		expect((await api(t, "POST", "/v1/pair/codes", null, {})).status).toBe(401);
	});

	it("validación del cuerpo → 400 bad_request", async () => {
		const r = await api(t, "POST", "/v1/pair/device", null, { code: "x" });
		expect(r.status).toBe(400);
		expect(r.json.error.code).toBe("bad_request");
	});

	it("límite de 5 intentos por minuto en el emparejamiento", async () => {
		const t2 = await startRelay({ limits: { pairAttemptsPerMinute: 5 } });
		try {
			const statuses: number[] = [];
			for (let i = 0; i < 8; i++)
				statuses.push((await api(t2, "POST", "/v1/pair/device", null, { code: "ZZZZZZZZ", name: "x" })).status);
			expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
			expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
		} finally {
			await t2.stop();
			cleanup(t2);
		}
	});
});

describe("autenticación HTTP", () => {
	it("rutas protegidas exigen token válido", async () => {
		expect((await api(t, "GET", "/v1/agents")).status).toBe(401);
		expect((await api(t, "GET", "/v1/agents", "rpd_falso")).status).toBe(401);
		const d = await pairDevice(t);
		expect((await api(t, "GET", "/v1/agents", d.deviceToken)).status).toBe(200);
		const m = await pairMachine(t);
		// un token de máquina no vale para rutas de dispositivo
		expect((await api(t, "GET", "/v1/agents", m.machineToken)).status).toBe(401);
	});

	it("healthz", async () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
		const r = await api(t, "GET", "/healthz");
		expect(r.json).toMatchObject({ ok: true, version: pkg.version });
		expect(r.json.version).toBe(pkg.version);
	});

	it("ruta inexistente → 404 con formato de error", async () => {
		const r = await api(t, "GET", "/nada");
		expect(r.status).toBe(404);
		expect(r.json.error.code).toBe("not_found");
	});

	it("tokens Bearer rpd_/rpm_ falsos comparten el cubo de rate-limit por IP; los válidos tienen su propio cubo", async () => {
		const d = await pairDevice(t);
		const r1 = await fetch(`${t.http}/v1/agents`, {
			headers: { authorization: `Bearer rpd_fake_1_${"x".repeat(24)}` },
		});
		const r2 = await fetch(`${t.http}/v1/agents`, {
			headers: { authorization: `Bearer rpd_fake_2_${"y".repeat(24)}` },
		});
		const rem1 = Number(r1.headers.get("x-ratelimit-remaining"));
		const rem2 = Number(r2.headers.get("x-ratelimit-remaining"));
		expect(rem2).toBe(rem1 - 1);

		const rValid = await fetch(`${t.http}/v1/agents`, {
			headers: { authorization: `Bearer ${d.deviceToken}` },
		});
		expect(Number(rValid.headers.get("x-ratelimit-remaining"))).toBe(599);
	});
});

function attemptFailedWsUpgrade(
	url: string,
	headers: Record<string, string>,
): Promise<{ type: "closed"; code: number } | { type: "http"; status: number }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, { headers });
		let settled = false;
		ws.on("error", (err) => {
			if (!settled) {
				settled = true;
				reject(err);
			}
		});
		ws.once("unexpected-response", (_req, res) => {
			res.resume();
			if (!settled) {
				settled = true;
				resolve({ type: "http", status: res.statusCode ?? 0 });
			}
		});
		ws.once("close", (code) => {
			if (!settled) {
				settled = true;
				resolve({ type: "closed", code });
			}
		});
	});
}

describe("pairing, proxy, admin, and WS auth rate-limiting (W-01)", () => {
	it("POST /v1/pair/codes enforces pairAttemptsPerMinute rate limit", async () => {
		const t2 = await startRelay({ limits: { pairAttemptsPerMinute: 5 } });
		try {
			const dev = await pairDevice(t2);
			const responses = [];
			for (let i = 0; i < 8; i++) {
				responses.push(await api(t2, "POST", "/v1/pair/codes", dev.deviceToken, { name: `PC-${i}` }));
			}
			expect(responses.slice(0, 5).every((r) => r.status === 200)).toBe(true);
			expect(responses.slice(5).every((r) => r.status === 429 && r.json?.error?.code === "rate_limited")).toBe(true);
		} finally {
			await t2.stop();
			cleanup(t2);
		}
	});

	it("active pairing code cap (50) evicts oldest active codes scoped by kind without touching other kind or used codes", async () => {
		const t2 = await startRelay();
		try {
			const { repos } = t2.relay.ctx;
			const baseExp = Date.now() + 600_000;

			// Seed 3 active machine codes and 2 already-used device codes
			for (let i = 0; i < 3; i++) {
				repos.pairing.insert({
					codeHash: hashToken(`M-KEEP-${i}`),
					kind: "machine",
					expiresAt: baseExp + i,
					createdBy: "test",
				});
			}
			for (let i = 0; i < 2; i++) {
				const hash = hashToken(`D-USED-${i}`);
				repos.pairing.insert({
					codeHash: hash,
					kind: "device",
					expiresAt: baseExp + i,
					createdBy: "test",
				});
				expect(repos.pairing.consume(hash, "device", Date.now())).toBeDefined();
			}

			// Insert MAX_ACTIVE_PAIRING_CODES + 5 active device codes with staggered expiresAt
			const totalDevice = MAX_ACTIVE_PAIRING_CODES + 5;
			for (let i = 0; i < totalDevice; i++) {
				repos.pairing.insert({
					codeHash: hashToken(`D-ACT-${i}`),
					kind: "device",
					expiresAt: baseExp + 100 + i,
					createdBy: "test",
				});
			}

			const countActive = (kind: "device" | "machine") =>
				(
					t2.relay.db.prepare("SELECT COUNT(*) AS n FROM pairing_codes WHERE used_at IS NULL AND kind=?").get(kind) as {
						n: number;
					}
				).n;
			const countUsed = (kind: "device" | "machine") =>
				(
					t2.relay.db
						.prepare("SELECT COUNT(*) AS n FROM pairing_codes WHERE used_at IS NOT NULL AND kind=?")
						.get(kind) as { n: number }
				).n;

			expect(countActive("device")).toBe(MAX_ACTIVE_PAIRING_CODES);
			expect(countActive("machine")).toBe(3);
			expect(countUsed("device")).toBe(2);

			// Oldest 5 active device codes were evicted; newest 50 remain consumable
			for (let i = 0; i < 5; i++) {
				expect(repos.pairing.consume(hashToken(`D-ACT-${i}`), "device", Date.now())).toBeUndefined();
			}
			expect(repos.pairing.consume(hashToken("D-ACT-5"), "device", Date.now())).toBeDefined();

			// Now overflow machine codes too and confirm active device codes are unaffected
			const remainingActiveDevices = countActive("device");
			for (let i = 0; i < MAX_ACTIVE_PAIRING_CODES + 5; i++) {
				repos.pairing.insert({
					codeHash: hashToken(`M-ACT-${i}`),
					kind: "machine",
					expiresAt: baseExp + 1_000 + i,
					createdBy: "test",
				});
			}
			expect(countActive("machine")).toBe(MAX_ACTIVE_PAIRING_CODES);
			expect(countActive("device")).toBe(remainingActiveDevices);
		} finally {
			await t2.stop();
			cleanup(t2);
		}
	});

	it("admin guard fails closed for non-loopback remoteAddress, proxy headers, and rate-limits failed auth attempts", async () => {
		const token = readFileSync(`${t.dir}/admin.token`, "utf8").trim();
		const longPoll = new LongPollRegistry(() => t.relay.ctx);
		const app = await buildHttp({
			config: t.config,
			log: createLogger("silent"),
			c: () => t.relay.ctx,
			longPoll,
		});
		try {
			// Non-loopback remoteAddress is rejected even with valid admin token
			const nonLoopback = await app.inject({
				method: "GET",
				url: "/admin/status",
				remoteAddress: "10.0.0.5",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(nonLoopback.statusCode).toBe(401);
			expect(nonLoopback.json()).toMatchObject({ error: { code: "unauthorized" } });

			// Proxy headers are rejected even from loopback with valid admin token
			for (const headerName of ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "true-client-ip"]) {
				const proxied = await app.inject({
					method: "GET",
					url: "/admin/status",
					remoteAddress: "127.0.0.1",
					headers: { authorization: `Bearer ${token}`, [headerName]: "203.0.113.9" },
				});
				expect(proxied.statusCode).toBe(401);
				expect(proxied.json()).toMatchObject({ error: { code: "unauthorized" } });
			}

			// 10 invalid admin attempts trigger rate_limited (429) on the 11th attempt even with valid token
			for (let i = 0; i < 10; i++) {
				const bad = await app.inject({
					method: "GET",
					url: "/admin/status",
					remoteAddress: "127.0.0.1",
					headers: { authorization: "Bearer wrong-admin-token" },
				});
				expect(bad.statusCode).toBe(401);
			}
			const lockedOut = await app.inject({
				method: "GET",
				url: "/admin/status",
				remoteAddress: "127.0.0.1",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(lockedOut.statusCode).toBe(429);
			expect(lockedOut.json()).toMatchObject({ error: { code: "rate_limited" } });
		} finally {
			longPoll.dispose();
			await app.close();
		}
	});

	it("non-loopback listen.host defaults trustProxy=false and ignores spoofed x-forwarded-for for HTTP rate limits", async () => {
		const nonLocalConfig = parseConfig(
			{
				dataDir: t.dir,
				listen: { host: "0.0.0.0", port: 0 },
				publicUrl: "https://relay.example.com",
				logLevel: "silent",
			},
			{},
		);
		const longPoll = new LongPollRegistry(() => t.relay.ctx);
		const app = await buildHttp({
			config: nonLocalConfig,
			log: createLogger("silent"),
			c: () => t.relay.ctx,
			longPoll,
		});
		try {
			const r1 = await app.inject({
				method: "GET",
				url: "/v1/agents",
				remoteAddress: "198.51.100.1",
				headers: { "x-forwarded-for": "1.1.1.1" },
			});
			const r2 = await app.inject({
				method: "GET",
				url: "/v1/agents",
				remoteAddress: "198.51.100.1",
				headers: { "x-forwarded-for": "2.2.2.2" },
			});
			const rem1 = Number(r1.headers["x-ratelimit-remaining"]);
			const rem2 = Number(r2.headers["x-ratelimit-remaining"]);
			expect(rem2).toBe(rem1 - 1);
		} finally {
			longPoll.dispose();
			await app.close();
		}
	});

	it("WS upgrade rate-limits failed auth attempts after 30 failures per minute per IP", async () => {
		const attackerHeaders = { authorization: "Bearer rpd_invalid", "x-forwarded-for": "198.51.100.77" };
		for (let i = 0; i < 30; i++) {
			const res = await attemptFailedWsUpgrade(`${t.ws}/ws/app`, attackerHeaders);
			expect(res).toEqual({ type: "closed", code: CloseCode.Unauthorized });
		}
		const blocked = await attemptFailedWsUpgrade(`${t.ws}/ws/app`, attackerHeaders);
		expect(blocked).toEqual({ type: "http", status: 429 });

		// A different IP is not affected by the attacker's bucket
		const other = await attemptFailedWsUpgrade(`${t.ws}/ws/app`, {
			authorization: "Bearer rpd_invalid",
			"x-forwarded-for": "198.51.100.78",
		});
		expect(other).toEqual({ type: "closed", code: CloseCode.Unauthorized });
	});
});
