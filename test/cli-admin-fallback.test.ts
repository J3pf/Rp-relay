import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupNow, restoreBackup, verifyDb } from "../src/backup/index.js";
import { openDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { Repos } from "../src/db/repos/index.js";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const DIST_CLI = join(ROOT, "dist/cli/index.js");
const USE_DIST = existsSync(DIST_CLI);

function cli(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve) => {
		const bin = USE_DIST ? process.execPath : TSX;
		const cmdArgs = USE_DIST ? [DIST_CLI, ...args] : [join(ROOT, "src/cli/index.ts"), ...args];
		execFile(
			bin,
			cmdArgs,
			{ encoding: "utf8", env: { ...process.env, NO_COLOR: "1", ...env }, timeout: 30_000 },
			(error, stdout, stderr) => {
				resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr });
			},
		);
	});
}

describe("CLI adminCall security semantics & DB fallback", () => {
	let base: string;
	let cfgFile: string;
	let dataDir: string;
	let env: Record<string, string>;

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "rp-cli-fallback-"));
		cfgFile = join(base, "etc", "config.json");
		dataDir = join(base, "data");
		env = { RP_CONFIG: cfgFile };
	});

	afterAll(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("(a) relay alive + slow admin endpoint: revoke does NOT fall back to DB and reports error", async () => {
		// Start slow mock HTTP server that takes 5 seconds to reply
		const slowServer = createServer((_req, res) => {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}, 5000);
		});

		await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", () => resolve()));
		const slowPort = (slowServer.address() as any).port;

		try {
			// Write config pointing to slowPort
			await cli([
				"init",
				"--yes",
				"--config",
				cfgFile,
				"--data-dir",
				dataDir,
				"--port",
				String(slowPort),
				"--public-url",
				`http://127.0.0.1:${slowPort}`,
			]);

			// Insert a test device directly in SQLite
			const db = openDb(join(dataDir, "relay.db"));
			migrate(db);
			const repos = new Repos(db);
			const deviceId = "dev-slow-1";
			repos.devices.insert({
				id: deviceId,
				name: "Phone 1",
				tokenHash: Buffer.from("hash1"),
				pushKey: Buffer.alloc(32),
				fcmToken: null,
				now: Date.now(),
			});
			db.close();

			// Run revoke with short test timeout via RP_ADMIN_TIMEOUT_MS
			const r = await cli(["devices", "revoke", deviceId], {
				...env,
				RP_ADMIN_TIMEOUT_MS: "300",
			});

			// Must report error (tiempo de espera agotado) and exit with code 1
			expect(r.code).toBe(1);
			expect(r.err).toContain("tiempo de espera agotado");
			expect(r.out).not.toContain("el relay no estaba en marcha");

			// CRITICAL: DB must remain untouched (revoked_at MUST be null)
			const dbCheck = openDb(join(dataDir, "relay.db"), { readonly: true });
			const row = new Repos(dbCheck).devices.get(deviceId);
			dbCheck.close();
			expect(row).toBeDefined();
			expect(row!.revoked_at).toBeNull();
		} finally {
			slowServer.close();
		}
	});

	it("(b) 401 unauthorized: surfaces error and DB remains untouched", async () => {
		// Mock server that returns 401 Unauthorized
		const unauthorizedServer = createServer((_req, res) => {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "token invalido" } }));
		});

		await new Promise<void>((resolve) => unauthorizedServer.listen(0, "127.0.0.1", () => resolve()));
		const authPort = (unauthorizedServer.address() as any).port;

		try {
			const db = openDb(join(dataDir, "relay.db"));
			const repos = new Repos(db);
			const deviceId = "dev-unauth-1";
			repos.devices.insert({
				id: deviceId,
				name: "Phone 2",
				tokenHash: Buffer.from("hash2"),
				pushKey: Buffer.alloc(32),
				fcmToken: null,
				now: Date.now(),
			});
			db.close();

			const r = await cli(["devices", "revoke", deviceId], {
				...env,
				RP_LISTEN_PORT: String(authPort),
			});

			// Must exit with error and report 401 or token invalido
			expect(r.code).toBe(1);
			expect(r.err).toMatch(/token invalido|HTTP 401/);
			expect(r.out).not.toContain("el relay no estaba en marcha");

			// DB must remain untouched
			const dbCheck = openDb(join(dataDir, "relay.db"), { readonly: true });
			const row = new Repos(dbCheck).devices.get(deviceId);
			dbCheck.close();
			expect(row).toBeDefined();
			expect(row!.revoked_at).toBeNull();
		} finally {
			unauthorizedServer.close();
		}
	});

	it("(c) ECONNREFUSED: relay is provably not listening so DB fallback works", async () => {
		// Find a closed port
		const s = createServer();
		const closedPort = await new Promise<number>((resolve) => {
			s.listen(0, "127.0.0.1", () => {
				const p = (s.address() as any).port;
				s.close(() => resolve(p));
			});
		});

		const db = openDb(join(dataDir, "relay.db"));
		const repos = new Repos(db);
		const deviceId = "dev-refused-1";
		repos.devices.insert({
			id: deviceId,
			name: "Phone 3",
			tokenHash: Buffer.from("hash3"),
			pushKey: Buffer.alloc(32),
			fcmToken: null,
			now: Date.now(),
		});
		db.close();

		const r = await cli(["devices", "revoke", deviceId], {
			...env,
			RP_LISTEN_PORT: String(closedPort),
		});

		// Must succeed via DB fallback
		expect(r.code).toBe(0);
		expect(r.out).toContain("revocado");
		expect(r.out).toContain("el relay no estaba en marcha");

		// DB must be updated
		const dbCheck = openDb(join(dataDir, "relay.db"), { readonly: true });
		const row = new Repos(dbCheck).devices.get(deviceId);
		dbCheck.close();
		expect(row).toBeDefined();
		expect(row!.revoked_at).toBeTypeOf("number");
	});
});

describe("rp-relay restore & restoreBackup (C-06)", () => {
	let workDir: string;
	let cfgFile: string;
	let dataDir: string;
	let backupFile: string;
	let env: Record<string, string>;

	beforeAll(async () => {
		workDir = mkdtempSync(join(tmpdir(), "rp-cli-restore-"));
		cfgFile = join(workDir, "etc", "config.json");
		dataDir = join(workDir, "data");
		env = { RP_CONFIG: cfgFile };

		await cli([
			"init",
			"--yes",
			"--config",
			cfgFile,
			"--data-dir",
			dataDir,
			"--port",
			"18787",
			"--public-url",
			"http://127.0.0.1:18787",
		]);

		// Seed a device in the DB, take a backup, then replace DB state with a different device
		const dbPath = join(dataDir, "relay.db");
		const db = openDb(dbPath);
		migrate(db);
		new Repos(db).devices.insert({
			id: "dev-from-backup",
			name: "Backup Phone",
			tokenHash: Buffer.from("hash-backup"),
			pushKey: Buffer.alloc(32),
			fcmToken: null,
			now: Date.now(),
		});
		backupFile = backupNow(db, join(workDir, "backups"));
		db.close();

		const dbLive = openDb(dbPath);
		new Repos(dbLive).devices.insert({
			id: "dev-live-only",
			name: "Live Phone",
			tokenHash: Buffer.from("hash-live"),
			pushKey: Buffer.alloc(32),
			fcmToken: null,
			now: Date.now(),
		});
		dbLive.close();
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("non-ECONNREFUSED admin probe error fails restore unless --force is passed", async () => {
		const hangingServer = createServer((_req, _res) => {
			// Intentionally hold connection open to trigger adminCall timeout
		});
		await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", () => resolve()));
		const port = (hangingServer.address() as any).port;

		try {
			const failed = await cli(["restore", backupFile], {
				...env,
				RP_LISTEN_PORT: String(port),
				RP_ADMIN_TIMEOUT_MS: "200",
			});
			expect(failed.code).toBe(1);
			expect(failed.err).toContain("no se pudo verificar si el relay está detenido");
			expect(failed.err).toContain("--force");

			// DB must remain untouched (dev-live-only still present)
			const dbBeforeForce = openDb(join(dataDir, "relay.db"), { readonly: true });
			expect(new Repos(dbBeforeForce).devices.get("dev-live-only")).toBeDefined();
			dbBeforeForce.close();

			// With --force, restore proceeds despite the probe error
			const forced = await cli(["restore", backupFile, "--force"], {
				...env,
				RP_LISTEN_PORT: String(port),
				RP_ADMIN_TIMEOUT_MS: "200",
			});
			expect(forced.code).toBe(0);
			expect(forced.out).toContain("base restaurada");

			const dbAfterForce = openDb(join(dataDir, "relay.db"), { readonly: true });
			const reposAfter = new Repos(dbAfterForce);
			expect(reposAfter.devices.get("dev-from-backup")).toBeDefined();
			expect(reposAfter.devices.get("dev-live-only")).toBeUndefined();
			dbAfterForce.close();
		} finally {
			hangingServer.closeAllConnections();
			hangingServer.close();
		}
	});

	it("restoreBackup copies atomically via temp file with 0o600 mode, cleans WAL/SHM, and renames cleanly", () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-restore-atomic-"));
		try {
			const srcDb = join(dir, "source.db");
			const sdb = openDb(srcDb);
			migrate(sdb);
			new Repos(sdb).devices.insert({
				id: "dev-atomic-backup",
				name: "Atomic Backup",
				tokenHash: Buffer.from("hash-atomic-b"),
				pushKey: Buffer.alloc(32),
				fcmToken: null,
				now: Date.now(),
			});
			const bkp = backupNow(sdb, join(dir, "bkp"));
			sdb.close();
			chmodSync(bkp, 0o644);

			const targetDb = join(dir, "target.db");
			const tdb = openDb(targetDb);
			migrate(tdb);
			new Repos(tdb).devices.insert({
				id: "dev-atomic-prev",
				name: "Previous",
				tokenHash: Buffer.from("hash-atomic-p"),
				pushKey: Buffer.alloc(32),
				fcmToken: null,
				now: Date.now(),
			});
			tdb.close();
			writeFileSync(`${targetDb}-wal`, "stale-wal");
			writeFileSync(`${targetDb}-shm`, "stale-shm");

			const { previous } = restoreBackup(bkp, targetDb);
			expect(previous).toBeTruthy();
			expect(existsSync(previous!)).toBe(true);
			expect(existsSync(`${targetDb}-wal`)).toBe(false);
			expect(existsSync(`${targetDb}-shm`)).toBe(false);
			expect(statSync(targetDb).mode & 0o777).toBe(0o600);
			expect(verifyDb(targetDb)).toEqual({ ok: true, detail: "ok" });
			expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

			const restored = openDb(targetDb, { readonly: true });
			const repos = new Repos(restored);
			expect(repos.devices.get("dev-atomic-backup")).toBeDefined();
			expect(repos.devices.get("dev-atomic-prev")).toBeUndefined();
			restored.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
