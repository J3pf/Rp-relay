import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AcmeChallengeServer, certExpiry, needsRenewal } from "../src/tls/index.js";
import { createLogger } from "../src/util/log.js";
import { cleanup, pairMachine, startRelay } from "./helpers.js";

let dir: string;
let hasOpenssl = true;
const mkcert = (name: string, days: number) => {
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			join(dir, `${name}.key`),
			"-out",
			join(dir, `${name}.crt`),
			"-days",
			String(days),
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ stdio: "ignore" },
	);
};
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "rp-tls-"));
	try {
		mkcert("long", 90);
		mkcert("short", 10);
	} catch {
		hasOpenssl = false;
	}
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("TLS integrado", () => {
	it("renovación: a 30 días de la caducidad o sin certificado", () => {
		if (!hasOpenssl) return;
		expect(needsRenewal(readFileSync(join(dir, "long.crt")))).toBe(false);
		expect(needsRenewal(readFileSync(join(dir, "short.crt")))).toBe(true);
		expect(needsRenewal(null)).toBe(true);
		expect(needsRenewal("basura")).toBe(true);
		expect(certExpiry(readFileSync(join(dir, "long.crt")))).toBeGreaterThan(Date.now() + 80 * 86_400_000);
	});

	it("el relay sirve HTTPS y WSS con cert/key propios", async () => {
		if (!hasOpenssl) return;
		const t = await startRelay({ tls: { cert: join(dir, "long.crt"), key: join(dir, "long.key") } });
		try {
			expect(t.http.startsWith("https://")).toBe(true);
			const body = await new Promise<string>((resolve, reject) => {
				request(`${t.http}/healthz`, { ca: readFileSync(join(dir, "long.crt")) }, (res) => {
					let s = "";
					res.on("data", (d) => (s += d));
					res.on("end", () => resolve(s));
				})
					.on("error", reject)
					.end();
			});
			expect(JSON.parse(body)).toMatchObject({ ok: true });
			const m = await pairMachine(t).catch(() => null);
			void m;
			const closed = await new Promise<number>((resolve, reject) => {
				const ws = new WebSocket(`${t.ws}/ws/agent`, {
					ca: readFileSync(join(dir, "long.crt")),
					headers: { authorization: "Bearer rpm_x" },
				});
				ws.on("close", (c) => resolve(c));
				ws.on("error", reject);
			});
			expect(closed).toBe(4001);
		} finally {
			await t.stop();
			cleanup(t);
		}
	});
});

describe("servidor de desafío ACME HTTP-01", () => {
	it("responde el keyAuthorization del token y redirige el resto a HTTPS", async () => {
		const s = new AcmeChallengeServer("https://relay.midominio.com", createLogger("silent"));
		const port = await s.listen(0, "127.0.0.1");
		s.set("tok-123", "tok-123.thumbprint");
		const ok = await fetch(`http://127.0.0.1:${port}/.well-known/acme-challenge/tok-123`);
		expect(await ok.text()).toBe("tok-123.thumbprint");
		s.remove("tok-123");
		const gone = await fetch(`http://127.0.0.1:${port}/.well-known/acme-challenge/tok-123`, { redirect: "manual" });
		expect(gone.status).toBe(301);
		const redir = await fetch(`http://127.0.0.1:${port}/v1/agents?state=open&limit=5`, { redirect: "manual" });
		expect(redir.headers.get("location")).toBe("https://relay.midominio.com/v1/agents?state=open&limit=5");
		await s.close();
	});
});
