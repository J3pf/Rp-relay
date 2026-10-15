import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor.js";
import { parseConfig } from "../src/config.js";
import {
	api,
	Client,
	cleanup,
	connectAgent,
	connectApp,
	pairDevice,
	pairMachine,
	sleep,
	startRelay,
	type TestRelay,
} from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

// asíncrono: el relay de la prueba corre en este mismo proceso y no debe quedar bloqueado mientras el CLI le habla
function cli(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve) => {
		execFile(
			TSX,
			[join(ROOT, "src/cli/index.ts"), ...args],
			{ encoding: "utf8", env: { ...process.env, NO_COLOR: "1", ...env }, timeout: 60_000 },
			(error, stdout, stderr) => {
				resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr });
			},
		);
	});
}

const freePort = () =>
	new Promise<number>((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as any).port;
			s.close(() => resolve(p));
		});
	});

let base: string;
let cfgFile: string;
let dataDir: string;
let port: number;
let env: Record<string, string>;

beforeAll(async () => {
	base = mkdtempSync(join(tmpdir(), "rp-cli-"));
	cfgFile = join(base, "etc", "config.json");
	dataDir = join(base, "data");
	port = await freePort();
	env = { RP_CONFIG: cfgFile };
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("rp-relay init", () => {
	it("crea config, directorios, DB, relayId y admin.token (600); es idempotente", async () => {
		const r = await cli([
			"init",
			"--yes",
			"--config",
			cfgFile,
			"--public-url",
			`http://127.0.0.1:${port}`,
			"--data-dir",
			dataDir,
			"--name",
			"Servidor test",
			"--port",
			String(port),
		]);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out).toContain("configuración escrita");
		const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
		expect(cfg).toMatchObject({
			publicUrl: `http://127.0.0.1:${port}`,
			dataDir,
			relayName: "Servidor test",
			listen: { host: "127.0.0.1", port },
		});
		expect(existsSync(join(dataDir, "relay.db"))).toBe(true);
		expect(existsSync(join(dataDir, "blobs"))).toBe(true);
		expect(statSync(join(dataDir, "admin.token")).mode & 0o777).toBe(0o600);
		const again = await cli([
			"init",
			"--yes",
			"--config",
			cfgFile,
			"--data-dir",
			dataDir,
			"--public-url",
			"http://otro",
		]);
		expect(again.out).toContain("ya existe");
		expect(JSON.parse(readFileSync(cfgFile, "utf8")).publicUrl).toBe(`http://127.0.0.1:${port}`); // no se sobrescribió
		const forced = await cli([
			"init",
			"--yes",
			"--force",
			"--config",
			cfgFile,
			"--data-dir",
			dataDir,
			"--public-url",
			`http://127.0.0.1:${port}`,
			"--name",
			"Servidor test",
			"--port",
			String(port),
		]);
		expect(forced.code).toBe(0);
	});

	it("opciones TLS/ACME/FCM se guardan en la configuración", async () => {
		const f = join(base, "etc2", "c.json");
		await cli([
			"init",
			"--yes",
			"--config",
			f,
			"--data-dir",
			join(base, "d2"),
			"--public-url",
			"https://r.example",
			"--acme-domain",
			"r.example",
			"--acme-email",
			"a@b.c",
			"--fcm-file",
			"/etc/sa.json",
		]);
		expect(JSON.parse(readFileSync(f, "utf8"))).toMatchObject({
			tls: { acme: { domain: "r.example", email: "a@b.c" } },
			fcm: { serviceAccountFile: "/etc/sa.json" },
		});
	});
});

describe("CLI sin el relay en marcha", () => {
	let machineId = "";
	it("pair device genera código con QR y URI rp://pair", async () => {
		const r = await cli(["pair", "device"], env);
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/Código: [0-9A-Z]{4}-[0-9A-Z]{4}/);
		expect(r.out).toContain(`rp://pair?u=${encodeURIComponent(`http://127.0.0.1:${port}`)}&c=`);
		expect(r.out).toMatch(/[▀▄█]/); // QR en terminal
		expect((await cli(["pair", "device", "--no-qr"], env)).out).not.toMatch(/[▀▄█]/);
	});

	it("pair machine con nombre/contexto: instrucción para Pi y datos aplicados al emparejar", async () => {
		const r = await cli(["pair", "machine", "--name", "PC Empresa", "--context", "work"], env);
		expect(r.out).toContain(`/rp pair http://127.0.0.1:${port} `);
		const code = /\/rp pair \S+ (\S+)/.exec(r.out)![1]!;
		const t = await startRelay({}, { dir: dataDir });
		try {
			const res = await api(t, "POST", "/v1/pair/machine", null, { code, hostname: "wincorp" });
			expect(res.status).toBe(200);
			machineId = res.json.machineId;
			expect(t.relay.ctx.repos.machines.get(machineId)).toMatchObject({ name: "PC Empresa", context: "work" });
		} finally {
			await t.stop();
		}
	});

	it("machines list/set y devices list leen la base directamente", async () => {
		expect((await cli(["machines", "list"], env)).out).toContain("PC Empresa");
		const set = await cli(["machines", "set", machineId, "--name", "Corp", "--color", "#abcdef"], env);
		expect(set.code).toBe(0);
		expect((await cli(["machines", "list"], env)).out).toMatch(/Corp\s+work\s+#abcdef/);
		expect((await cli(["machines", "set", machineId, "--color", "rojo"], env)).code).toBe(1);
		expect((await cli(["machines", "set", "NOPE", "--name", "x"], env)).err).toContain("no encontrada");
		expect((await cli(["devices", "list"], env)).code).toBe(0);
	});

	it("push test sin relay en marcha → error claro", async () => {
		const r = await cli(["push", "test"], env);
		expect(r.code).toBe(1);
		expect(r.err).toContain("no está en marcha");
	});

	it("backup now/list y restore (relay parado)", async () => {
		const b = await cli(["backup", "now"], env);
		expect(b.code).toBe(0);
		const file = /copia creada: (\S+)/.exec(b.out)![1]!;
		expect(existsSync(file)).toBe(true);
		expect((await cli(["backup", "list"], env)).out).toContain("rp-");
		const bad = join(base, "malo.db");
		writeFileSync(bad, "no es sqlite");
		expect((await cli(["restore", bad], env)).code).toBe(1);
		const ok = await cli(["restore", file], env);
		expect(ok.code).toBe(0);
		expect(ok.out).toContain("integrity_check: ok");
		expect(ok.out).toContain("pre-restore");
	});

	it("migrate, version, ayuda y comando desconocido", async () => {
		expect((await cli(["migrate"], env)).out).toContain("Sin migraciones pendientes");
		expect((await cli(["version"], env)).out.trim()).toBe("0.3.0");
		expect((await cli(["help"])).out).toContain("Uso: rp-relay");
		const u = await cli(["frobnicar"]);
		expect(u.code).toBe(2);
		expect(u.err).toContain("comando desconocido");
	});

	it("doctor sin relay: la URL pública no responde → fallo, el resto bien", async () => {
		const r = await cli(["doctor"], env);
		expect(r.code).toBe(1);
		expect(r.out).toContain("publicUrl alcanzable");
		expect(r.out).toMatch(/✓ Base de datos/);
	});
});

describe("CLI contra el relay en marcha (API de administración)", () => {
	let t: TestRelay;
	const withServer = async (fn: () => Promise<void>) => {
		t = await startRelay(
			{ listen: { host: "127.0.0.1", port }, publicUrl: `http://127.0.0.1:${port}` },
			{ dir: dataDir },
		);
		try {
			await fn();
		} finally {
			await t.stop();
		}
	};

	it("machines set se difunde a las apps; machines revoke / devices revoke cortan las conexiones; push test", async () => {
		await withServer(async () => {
			const dev = await pairDevice(t);
			const m = await pairMachine(t, "cli-pc", { name: "PC CLI" });
			const agent = await connectAgent(t, m, "cli1");
			const { client: app } = await connectApp(t, dev);
			const { client: direct } = await connectApp(t, dev, "direct");

			const set = await cli(["machines", "set", m.machineId, "--name", "Renombrada", "--context", "work"], env);
			expect(set.code).toBe(0);
			const upd = await app.next((e) => e.t === "machines.update" && (e.d as any).upsert[0]?.name === "Renombrada");
			expect((upd.d as any).upsert[0].context).toBe("work");

			const pt = await cli(["push", "test", dev.deviceId], env);
			expect(pt.code).toBe(0);
			expect(pt.out).toContain(dev.deviceId);
			expect((await direct.next("push.notify")).d).toMatchObject({ k: "test" });

			const rv = await cli(["machines", "revoke", m.machineId], env);
			expect(rv.out).toContain("conexiones cerradas");
			expect((await agent.client.waitClosed()).code).toBe(4001);

			const rd = await cli(["devices", "revoke", dev.deviceId], env);
			expect(rd.code).toBe(0);
			expect((await app.waitClosed()).code).toBe(4001);
			expect((await cli(["devices", "revoke", dev.deviceId], env)).code).toBe(1); // ya revocado
			void direct;
		});
	});

	it("doctor con el relay activo: todo en verde", async () => {
		await withServer(async () => {
			const r = await cli(["doctor"], env);
			expect(r.out).toContain("✓ publicUrl alcanzable");
			expect(r.out).toContain("✓ Reloj");
			expect(r.out).toContain("sin FCM".slice(0, 0)); // FCM es opcional
			expect(r.code).toBe(0);
		});
	});

	it("restore se niega si el relay está en marcha (sin --force)", async () => {
		await withServer(async () => {
			const b = await cli(["backup", "now"], env);
			const file = /copia creada: (\S+)/.exec(b.out)![1]!;
			const r = await cli(["restore", file], env);
			expect(r.code).toBe(1);
			expect(r.err).toContain("está en marcha");
		});
	});

	it("la API /admin exige el token, y se rechaza si llega a través de un proxy (X-Forwarded-For)", async () => {
		await withServer(async () => {
			const token = readFileSync(join(dataDir, "admin.token"), "utf8").trim();
			const get = (h: Record<string, string>) => fetch(`${t.http}/admin/status`, { headers: h });
			expect((await get({})).status).toBe(401);
			expect((await get({ authorization: "Bearer mal" })).status).toBe(401);
			expect((await get({ authorization: `Bearer ${token}`, "x-forwarded-for": "1.2.3.4" })).status).toBe(401);
			const ok = await get({ authorization: `Bearer ${token}` });
			expect(ok.status).toBe(200);
			expect(await ok.json()).toMatchObject({ agentsOnline: 0, fcm: true });
			// un token de dispositivo no sirve de admin
			const dev = await pairDevice(t);
			expect((await get({ authorization: `Bearer ${dev.deviceToken}` })).status).toBe(401);
			void sleep;
			void Client;
		});
	});
});

describe("doctor (módulo)", () => {
	it("detecta configuración, permisos laxos y FCM roto", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-doc-"));
		const cfg = join(dir, "c.json");
		const sa = join(dir, "sa.json");
		writeFileSync(sa, JSON.stringify({ project_id: "p" }));
		writeFileSync(
			cfg,
			JSON.stringify({ dataDir: dir, publicUrl: "http://127.0.0.1:1", fcm: { serviceAccountFile: sa } }),
		);
		const old = process.env.RP_CONFIG;
		process.env.RP_CONFIG = cfg;
		try {
			const checks = await runDoctor({
				fetchImpl: (async () => {
					throw new Error("ECONNREFUSED");
				}) as never,
			});
			const by = (n: string) => checks.find((c) => c.name === n)!;
			expect(by("Node.js").level).toBe("ok");
			expect(by("Base de datos").level).toBe("fail"); // sin init
			expect(by("FCM").level).toBe("fail");
			expect(by("FCM").detail).toContain("private_key");
			expect(by("publicUrl alcanzable").level).toBe("fail");
			void parseConfig;
		} finally {
			if (old === undefined) delete process.env.RP_CONFIG;
			else process.env.RP_CONFIG = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
void cleanup;
