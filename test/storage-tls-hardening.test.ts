import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupNow, listBackups, pruneBackups, restoreBackup, verifyDb } from "../src/backup/index.js";
import { BlobStore } from "../src/blobs/store.js";
import { runDoctor } from "../src/cli/doctor.js";
import { parseConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { Repos } from "../src/db/repos/index.js";
import * as tlsMod from "../src/tls/index.js";
import { RelayError } from "../src/util/errors.js";
import { createLogger } from "../src/util/log.js";
import { cleanup, pairDevice, startRelay, type TestRelay } from "./helpers.js";

const acmeMockState = {
	csrKey: Buffer.from(""),
	autoHandler: async (): Promise<string> => {
		throw new Error("acme renewal failed");
	},
};

vi.mock("acme-client", () => ({
	default: {
		directory: { letsencrypt: { production: "https://acme.test/directory" } },
		crypto: {
			createPrivateKey: async () => Buffer.from("mock-account-key"),
			createCsr: async () => [acmeMockState.csrKey, Buffer.from("mock-csr")],
		},
		Client: class {
			async auto() {
				return acmeMockState.autoHandler();
			}
		},
	},
}));

const tempDirs: string[] = [];
const relays: TestRelay[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createRelayDb(dbFile: string): ReturnType<typeof openDb> {
	const db = openDb(dbFile);
	migrate(db);
	return db;
}

/**
 * Snapshot a live WAL database (main file + uncheckpointed `-wal`/`-shm`) into `destDbFile`
 * while the writer holds an uncheckpointed transaction/frame in the WAL.
 */
function createDbWithUncheckpointedWal(srcDir: string, destDir: string, markerKey: string, markerVal: string) {
	const srcFile = join(srcDir, "src.db");
	const db = createRelayDb(srcFile);
	const backupDir = join(srcDir, "backups");
	const backupFile = backupNow(db, backupDir);

	// Disable auto-checkpoint so subsequent writes stay exclusively in -wal
	db.pragma("wal_autocheckpoint = 0");
	db.prepare("INSERT OR REPLACE INTO relay_meta(key, value) VALUES (?, ?)").run(markerKey, markerVal);

	const destFile = join(destDir, "relay.db");
	copyFileSync(srcFile, destFile);
	copyFileSync(`${srcFile}-wal`, `${destFile}-wal`);
	if (existsSync(`${srcFile}-shm`)) {
		copyFileSync(`${srcFile}-shm`, `${destFile}-shm`);
	}
	db.close();

	expect(existsSync(`${destFile}-wal`)).toBe(true);
	expect(statSync(`${destFile}-wal`).size).toBeGreaterThan(0);
	return { destFile, backupFile };
}

function generateSelfSignedCert(dir: string, name: string): { certPath: string; keyPath: string } | null {
	const keyPath = join(dir, `${name}.key`);
	const certPath = join(dir, `${name}.crt`);
	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				keyPath,
				"-out",
				certPath,
				"-days",
				"90",
				"-subj",
				"/CN=localhost",
			],
			{ stdio: "ignore" },
		);
		return { certPath, keyPath };
	} catch {
		return null;
	}
}

afterEach(async () => {
	for (const r of relays.splice(0)) {
		await r.stop().catch(() => {});
		cleanup(r);
	}
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

describe("C-03: backup/restore WAL integrity & atomic backups", () => {
	it("backupNow() writes atomically with 0o600 permissions and leaves no temp files", () => {
		const dir = makeTempDir("rp-bk-atomic-");
		const dbFile = join(dir, "relay.db");
		const db = createRelayDb(dbFile);
		try {
			const bkDir = join(dir, "backups");
			const out = backupNow(db, bkDir);
			expect(existsSync(out)).toBe(true);
			expect(verifyDb(out)).toEqual({ ok: true, detail: "ok" });
			expect(statSync(out).mode & 0o777).toBe(0o600);
			const files = readdirSync(bkDir);
			expect(files).toHaveLength(1);
			expect(files.some((f) => f.includes(".tmp"))).toBe(false);
		} finally {
			db.close();
		}
	});

	it("pruneBackups() retains at least the newest valid backup even when all backups exceed keepDays", () => {
		const dir = makeTempDir("rp-bk-prune-");
		const dbFile = join(dir, "relay.db");
		const db = createRelayDb(dbFile);
		const bkDir = join(dir, "backups");
		try {
			const b1 = backupNow(db, bkDir, new Date("2026-01-01T00:00:00Z"));
			const b2 = backupNow(db, bkDir, new Date("2026-01-02T00:00:00Z"));
			const b3 = backupNow(db, bkDir, new Date("2026-01-03T00:00:00Z"));
			const now = Date.now();
			const old1 = new Date(now - 30 * 86_400_000);
			const old2 = new Date(now - 20 * 86_400_000);
			const old3 = new Date(now - 10 * 86_400_000);
			utimesSync(b1, old1, old1);
			utimesSync(b2, old2, old2);
			utimesSync(b3, old3, old3);

			const removed = pruneBackups(bkDir, 7, now);
			expect(removed).toBe(2);
			const remaining = listBackups(bkDir);
			expect(remaining).toHaveLength(1);
			expect(remaining[0]!.path).toBe(b3);
			expect(verifyDb(remaining[0]!.path).ok).toBe(true);
		} finally {
			db.close();
		}
	});

	it("restoreBackup() preserves uncheckpointed WAL data when staging copy fails", () => {
		const srcDir = makeTempDir("rp-wal-fail-src-");
		const destDir = makeTempDir("rp-wal-fail-dest-");
		const { destFile, backupFile } = createDbWithUncheckpointedWal(srcDir, destDir, "wal_marker", "must_survive");

		// Force copyFileSync(backupFile, tmpFile) to fail with EISDIR by pre-creating tmpFile as a directory
		const tmpObstacle = `${destFile}.restore-${process.pid}.tmp`;
		mkdirSync(tmpObstacle);

		expect(() => restoreBackup(backupFile, destFile)).toThrow();

		// Clean up the artificial obstacle and verify the live DB still has the uncheckpointed WAL data
		rmSync(tmpObstacle, { recursive: true, force: true });
		expect(existsSync(destFile)).toBe(true);
		expect(existsSync(`${destFile}-wal`)).toBe(true);
		const checkDb = openDb(destFile);
		try {
			const row = checkDb.prepare("SELECT value FROM relay_meta WHERE key = ?").get("wal_marker") as
				| { value: string }
				| undefined;
			expect(row?.value).toBe("must_survive");
		} finally {
			checkDb.close();
		}
	});

	it("restoreBackup() preserves -wal alongside .pre-restore-* on successful restore", () => {
		const srcDir = makeTempDir("rp-wal-ok-src-");
		const destDir = makeTempDir("rp-wal-ok-dest-");
		const { destFile, backupFile } = createDbWithUncheckpointedWal(srcDir, destDir, "pre_restore_key", "wal_value");

		const { previous } = restoreBackup(backupFile, destFile);
		expect(previous).toBeTruthy();
		expect(existsSync(previous!)).toBe(true);
		expect(existsSync(`${previous!}-wal`)).toBe(true);

		// Restored live DB has the backup state (without the post-backup marker)
		const liveDb = openDb(destFile);
		try {
			const liveRow = liveDb.prepare("SELECT value FROM relay_meta WHERE key = ?").get("pre_restore_key");
			expect(liveRow).toBeUndefined();
		} finally {
			liveDb.close();
		}

		// Opening the pre-restore copy recovers the uncheckpointed WAL data
		const prevDb = openDb(previous!);
		try {
			const prevRow = prevDb.prepare("SELECT value FROM relay_meta WHERE key = ?").get("pre_restore_key") as
				| { value: string }
				| undefined;
			expect(prevRow?.value).toBe("wal_value");
		} finally {
			prevDb.close();
		}
	});
});

describe("C-04 & W-05: TLS pair validation & AcmeChallengeServer shutdown", () => {
	it("validateTlsPair() accepts matching key/cert and rejects mismatched pair", () => {
		const dir = makeTempDir("rp-tls-pair-");
		const pairA = generateSelfSignedCert(dir, "a");
		const pairB = generateSelfSignedCert(dir, "b");
		if (!pairA || !pairB) return;

		const validateTlsPair = (tlsMod as { validateTlsPair?: (k: Buffer, c: Buffer) => boolean }).validateTlsPair;
		expect(typeof validateTlsPair).toBe("function");
		expect(validateTlsPair!(readFileSync(pairA.keyPath), readFileSync(pairA.certPath))).toBe(true);
		expect(validateTlsPair!(readFileSync(pairA.keyPath), readFileSync(pairB.certPath))).toBe(false);
		expect(validateTlsPair!(Buffer.from("not-a-key"), readFileSync(pairA.certPath))).toBe(false);
	});

	it("ensureAcmeCert() does not reuse a mismatched cached cert/key pair on startup or fallback, and writes valid renewals atomically", async () => {
		const dir = makeTempDir("rp-acme-mismatch-");
		const pairA = generateSelfSignedCert(dir, "a");
		const pairB = generateSelfSignedCert(dir, "b");
		if (!pairA || !pairB) return;

		const certA = readFileSync(pairA.certPath);
		const keyA = readFileSync(pairA.keyPath);
		const certB = readFileSync(pairB.certPath);
		const keyB = readFileSync(pairB.keyPath);

		const acmeDir = join(dir, "acme");
		mkdirSync(acmeDir, { recursive: true });
		// Write cert from A and key from B (unexpired cert, but mismatched key)
		writeFileSync(join(acmeDir, "fullchain.pem"), certA, { mode: 0o600 });
		writeFileSync(join(acmeDir, "domain.key"), keyB, { mode: 0o600 });

		const config = parseConfig(
			{
				dataDir: dir,
				publicUrl: "https://relay.example",
				tls: { acme: { domain: "relay.example", email: "ops@relay.example" } },
			},
			{},
		);
		const challenge = new tlsMod.AcmeChallengeServer(config.publicUrl, createLogger("silent"));

		// 1. When renewal fails, ensureAcmeCert must NOT return the mismatched cached pair on startup or fallback
		acmeMockState.csrKey = keyA;
		acmeMockState.autoHandler = async () => {
			throw new Error("acme renewal failed");
		};
		await expect(tlsMod.ensureAcmeCert(config, challenge, createLogger("silent"))).rejects.toThrow(
			"acme renewal failed",
		);

		// 2. When renewal returns a mismatched cert/key, ensureAcmeCert rejects without leaving .tmp files
		acmeMockState.csrKey = keyB;
		acmeMockState.autoHandler = async () => certA.toString("utf8");
		await expect(tlsMod.ensureAcmeCert(config, challenge, createLogger("silent"))).rejects.toThrow(/no coinciden/);
		expect(readdirSync(acmeDir).some((f) => f.endsWith(".tmp"))).toBe(false);

		// 3. When renewal returns a valid matching pair, ensureAcmeCert writes atomically with 0o600 and succeeds
		acmeMockState.csrKey = keyB;
		acmeMockState.autoHandler = async () => certB.toString("utf8");
		const renewed = await tlsMod.ensureAcmeCert(config, challenge, createLogger("silent"));
		expect(tlsMod.validateTlsPair(renewed.key, renewed.cert)).toBe(true);
		expect(statSync(join(acmeDir, "fullchain.pem")).mode & 0o777).toBe(0o600);
		expect(statSync(join(acmeDir, "domain.key")).mode & 0o777).toBe(0o600);
		expect(readdirSync(acmeDir).some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	it("AcmeChallengeServer.close() resolves promptly even with an active HTTP keep-alive connection", async () => {
		const s = new tlsMod.AcmeChallengeServer("https://relay.example", createLogger("silent"));
		const port = await s.listen(0, "127.0.0.1");

		// Open a raw HTTP/1.1 keep-alive connection and begin a second in-flight request so the socket stays active
		const sock = createConnection({ host: "127.0.0.1", port });
		await new Promise<void>((resolve, reject) => {
			sock.once("error", reject);
			sock.once("connect", () => {
				sock.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
			});
			sock.once("data", () => {
				sock.write("GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n");
				setTimeout(resolve, 20);
			});
		});

		const t0 = Date.now();
		await Promise.race([
			s.close(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("AcmeChallengeServer.close() hung on keep-alive socket")), 1000),
			),
		]);
		expect(Date.now() - t0).toBeLessThan(1000);
		sock.destroy();
	});
});

describe("W-07: SQLite busy_timeout configuration", () => {
	it("openDb() configures busy_timeout = 5000 in both read-write and readonly modes", () => {
		const dir = makeTempDir("rp-db-busy-");
		const dbFile = join(dir, "relay.db");
		const rw = openDb(dbFile);
		try {
			expect(rw.pragma("busy_timeout")).toEqual([{ timeout: 5000 }]);
			expect(rw.pragma("journal_mode")).toEqual([{ journal_mode: "wal" }]);
		} finally {
			rw.close();
		}
		const ro = openDb(dbFile, { readonly: true });
		try {
			expect(ro.pragma("busy_timeout")).toEqual([{ timeout: 5000 }]);
		} finally {
			ro.close();
		}
	});
});

describe("W-02: BlobStore cumulative quota & route rate limit", () => {
	it("enforces blobTotalMaxBytes quota, runs gc() before rejecting with too_large, and cleans up disk", async () => {
		const dir = makeTempDir("rp-blob-quota-");
		const db = createRelayDb(join(dir, "relay.db"));
		try {
			const repos = new Repos(db);
			const store = new BlobStore(join(dir, "blobs"), repos, {
				blobMaxBytes: 1024,
				blobTotalMaxBytes: 1500,
				blobTtlDays: 7,
			});

			const first = await store.save(Readable.from([Buffer.alloc(1000, 1)]), {
				name: "a.bin",
				mime: "application/octet-stream",
				uploadedBy: "dev1",
			});
			expect(first.size).toBe(1000);
			expect(repos.blobs.totalActiveBytes(Date.now())).toBe(1000);

			const gcSpy = vi.spyOn(store, "gc");
			await expect(
				store.save(Readable.from([Buffer.alloc(600, 2)]), {
					name: "b.bin",
					mime: "application/octet-stream",
					uploadedBy: "dev1",
				}),
			).rejects.toSatisfy((err: unknown) => err instanceof RelayError && err.code === "too_large");
			expect(gcSpy).toHaveBeenCalledTimes(1);
			// No leftover .part or second blob file on disk
			expect(readdirSync(join(dir, "blobs"))).toEqual([first.id]);

			// Expire the first blob; next upload runs gc() / sees active bytes = 0 and succeeds
			db.prepare("UPDATE blobs SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, first.id);
			const second = await store.save(Readable.from([Buffer.alloc(600, 3)]), {
				name: "c.bin",
				mime: "application/octet-stream",
				uploadedBy: "dev1",
			});
			expect(second.size).toBe(600);
		} finally {
			db.close();
		}
	});

	it("tracks inFlightBytes across concurrent uploads and decrements in finally", async () => {
		const dir = makeTempDir("rp-blob-inflight-");
		const db = createRelayDb(join(dir, "relay.db"));
		try {
			const repos = new Repos(db);
			const store = new BlobStore(join(dir, "blobs"), repos, {
				blobMaxBytes: 1024,
				blobTotalMaxBytes: 1000,
				blobTtlDays: 7,
			});

			const s1 = new PassThrough();
			const s2 = new PassThrough();
			const p1 = store.save(s1, { name: "1.bin", mime: "application/octet-stream", uploadedBy: "dev1" });
			const p2 = store.save(s2, { name: "2.bin", mime: "application/octet-stream", uploadedBy: "dev1" });

			// Stream 600 bytes into both concurrently (total 1200 > 1000)
			s1.write(Buffer.alloc(600, 1));
			s2.write(Buffer.alloc(600, 2));
			s1.end();
			s2.end();

			const results = await Promise.allSettled([p1, p2]);
			const fulfilled = results.filter((r) => r.status === "fulfilled");
			const rejected = results.filter((r) => r.status === "rejected");
			expect(fulfilled.length).toBeLessThanOrEqual(1);
			expect(rejected.length).toBeGreaterThanOrEqual(1);
			expect(repos.blobs.totalActiveBytes(Date.now())).toBeLessThanOrEqual(1000);

			// After concurrent rejection, inFlightBytes must be back to 0 so a fitting upload succeeds
			const used = repos.blobs.totalActiveBytes(Date.now());
			const fittingSize = 1000 - used;
			if (fittingSize > 0) {
				const ok = await store.save(Readable.from([Buffer.alloc(fittingSize, 4)]), {
					name: "fit.bin",
					mime: "application/octet-stream",
					uploadedBy: "dev1",
				});
				expect(ok.size).toBe(fittingSize);
			}
		} finally {
			db.close();
		}
	});

	it("POST /v1/blobs applies per-route rate limit (max 60/min) and returns 413 on total quota breach", async () => {
		const t = await startRelay({ limits: { blobMaxBytes: 1024, blobTotalMaxBytes: 1024 } });
		relays.push(t);
		const dev = await pairDevice(t);

		const upload = async (bytes: number) => {
			const fd = new FormData();
			fd.append(
				"file",
				new Blob([new Uint8Array(Buffer.alloc(bytes, 7))], { type: "application/octet-stream" }),
				"f.bin",
			);
			return fetch(`${t.http}/v1/blobs`, {
				method: "POST",
				headers: { authorization: `Bearer ${dev.deviceToken}` },
				body: fd,
			});
		};

		const r1 = await upload(800);
		expect(r1.status).toBe(201);
		expect(r1.headers.get("x-ratelimit-limit")).toBe("60");

		const r2 = await upload(400);
		expect(r2.status).toBe(413);
		expect(((await r2.json()) as { error: { code: string } }).error.code).toBe("too_large");
	});
});

describe("S-02 & R2-10: doctor loopback detection and permission checks", () => {
	async function runDoctorWithConfig(cfgObj: Record<string, unknown>) {
		const cfgDir = makeTempDir("rp-doc-cfg-");
		const cfgFile = join(cfgDir, "config.json");
		writeFileSync(cfgFile, JSON.stringify(cfgObj));
		const prev = process.env.RP_CONFIG;
		process.env.RP_CONFIG = cfgFile;
		try {
			return await runDoctor({
				fetchImpl: (async () =>
					new Response(JSON.stringify({ ok: true, version: "0.8.2" }), {
						status: 200,
						headers: { "content-type": "application/json", date: new Date().toUTCString() },
					})) as typeof fetch,
			});
		} finally {
			if (prev === undefined) delete process.env.RP_CONFIG;
			else process.env.RP_CONFIG = prev;
		}
	}

	it("does not emit false TLS warning for ::1 or localhost, but warns for 0.0.0.0", async () => {
		const dataDir = makeTempDir("rp-doc-loop-");
		chmodSync(dataDir, 0o700);
		const db = createRelayDb(join(dataDir, "relay.db"));
		db.close();
		chmodSync(join(dataDir, "relay.db"), 0o600);

		for (const host of ["127.0.0.1", "::1", "localhost"]) {
			const checks = await runDoctorWithConfig({
				dataDir,
				listen: { host, port: 8787 },
				publicUrl: "https://relay.example",
			});
			expect(checks.find((c) => c.name === "TLS")).toBeUndefined();
		}

		const nonLoopback = await runDoctorWithConfig({
			dataDir,
			listen: { host: "0.0.0.0", port: 8787 },
			publicUrl: "https://relay.example",
		});
		expect(nonLoopback.find((c) => c.name === "TLS")?.level).toBe("warn");
	});

	it("checks permissions on dataDir, relay.db/-wal, and configured tls.key", async () => {
		const dataDir = makeTempDir("rp-doc-perms-");
		chmodSync(dataDir, 0o755);
		const dbFile = join(dataDir, "relay.db");
		const db = createRelayDb(dbFile);
		db.close();
		chmodSync(dbFile, 0o644);
		writeFileSync(`${dbFile}-wal`, "");
		chmodSync(`${dbFile}-wal`, 0o644);

		const pair = generateSelfSignedCert(dataDir, "srv");
		if (pair) chmodSync(pair.keyPath, 0o644);

		const laxChecks = await runDoctorWithConfig({
			dataDir,
			listen: { host: "127.0.0.1", port: 8787 },
			publicUrl: "https://relay.example",
			...(pair ? { tls: { cert: pair.certPath, key: pair.keyPath } } : {}),
		});
		expect(laxChecks.find((c) => c.name === "Directorio de datos")?.level).toBe("warn");
		expect(laxChecks.find((c) => c.name === "Permisos de BD")?.level).toBe("warn");
		expect(laxChecks.find((c) => c.name === "Permisos de BD")?.detail).toContain("relay.db");
		expect(laxChecks.find((c) => c.name === "Permisos de BD")?.detail).toContain("relay.db-wal");
		if (pair) {
			expect(laxChecks.find((c) => c.name === "TLS (clave)")?.level).toBe("warn");
		}

		// Tighten permissions to 700 / 600 and confirm checks pass as ok
		chmodSync(dataDir, 0o700);
		chmodSync(dbFile, 0o600);
		chmodSync(`${dbFile}-wal`, 0o600);
		if (existsSync(`${dbFile}-shm`)) chmodSync(`${dbFile}-shm`, 0o600);
		if (pair) chmodSync(pair.keyPath, 0o600);

		const tightChecks = await runDoctorWithConfig({
			dataDir,
			listen: { host: "127.0.0.1", port: 8787 },
			publicUrl: "https://relay.example",
			...(pair ? { tls: { cert: pair.certPath, key: pair.keyPath } } : {}),
		});
		expect(tightChecks.find((c) => c.name === "Directorio de datos")?.level).toBe("ok");
		expect(tightChecks.find((c) => c.name === "Permisos de BD")?.level).toBe("ok");
		if (pair) {
			expect(tightChecks.find((c) => c.name === "TLS (clave)")?.level).toBe("ok");
		}
	});
});
