import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken, newPairingCode, normalizeCode } from "../src/auth/tokens.js";
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
		const r = await api(t, "GET", "/healthz");
		expect(r.json).toMatchObject({ ok: true, version: "0.3.0" });
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
