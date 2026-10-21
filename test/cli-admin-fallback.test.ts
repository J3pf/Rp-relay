import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
