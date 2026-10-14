import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { DAY } from "../util/time.js";

export interface TlsMaterial {
	key: Buffer;
	cert: Buffer;
}

export const RENEW_BEFORE_DAYS = 30;

export function certExpiry(certPem: string | Buffer): number {
	return new X509Certificate(certPem).validToDate.getTime();
}

export function needsRenewal(certPem: string | Buffer | null, now = Date.now()): boolean {
	if (!certPem) return true;
	try {
		return certExpiry(certPem) - now < RENEW_BEFORE_DAYS * DAY;
	} catch {
		return true;
	}
}

type TlsConfig = NonNullable<Config["tls"]>;
export const isFileTls = (t: TlsConfig): t is { cert: string; key: string } => "cert" in t;

/** Servidor HTTP-01 de ACME en el puerto 80; el resto de peticiones se redirige a HTTPS. */
export class AcmeChallengeServer {
	private tokens = new Map<string, string>();
	private server: Server | null = null;
	constructor(
		private publicUrl: string,
		private log: Logger,
	) {}
	set(token: string, keyAuth: string): void {
		this.tokens.set(token, keyAuth);
	}
	remove(token: string): void {
		this.tokens.delete(token);
	}
	async listen(port: number, host = "0.0.0.0"): Promise<number> {
		this.server = createServer((req, res) => {
			const m = /^\/\.well-known\/acme-challenge\/([\w-]+)$/.exec(req.url ?? "");
			const ka = m ? this.tokens.get(m[1]!) : undefined;
			if (ka) {
				res.writeHead(200, { "Content-Type": "text/plain" }).end(ka);
				return;
			}
			const parsed = new URL(this.publicUrl);
			const safePath = (req.url ?? "/").replace(/^\/+/, "/");
			parsed.pathname = safePath;
			res.writeHead(301, { Location: parsed.toString() }).end();
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(port, host, () => resolve());
		});
		const addr = this.server.address();
		const p = typeof addr === "object" && addr ? addr.port : port;
		this.log.info({ port: p }, "servidor HTTP-01 de ACME escuchando");
		return p;
	}
	async close(): Promise<void> {
		const s = this.server;
		this.server = null;
		if (s) await new Promise<void>((r) => s.close(() => r()));
	}
}

/** Obtiene (o renueva) el certificado con `acme-client` (dependencia opcional). */
export async function ensureAcmeCert(
	config: Config,
	challenge: AcmeChallengeServer,
	log: Logger,
	force = false,
): Promise<TlsMaterial> {
	const tls = config.tls;
	if (!tls || isFileTls(tls)) throw new Error("ACME no configurado");
	const dir = join(config.dataDir, "acme");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const certFile = join(dir, "fullchain.pem");
	const keyFile = join(dir, "domain.key");
	if (!force && existsSync(certFile) && existsSync(keyFile)) {
		const cert = readFileSync(certFile);
		if (!needsRenewal(cert)) return { key: readFileSync(keyFile), cert };
	}
	let mod: any;
	try {
		mod = await import("acme-client");
	} catch (e) {
		throw new Error(`acme-client no está instalado (${(e as Error).message})`);
	}
	const acme = mod.default ?? mod;
	const accountFile = join(dir, "account.key");
	const accountKey: Buffer = existsSync(accountFile) ? readFileSync(accountFile) : await acme.crypto.createPrivateKey();
	if (!existsSync(accountFile)) writeFileSync(accountFile, accountKey, { mode: 0o600 });
	const client = new acme.Client({
		directoryUrl: tls.acme.directoryUrl ?? acme.directory.letsencrypt.production,
		accountKey,
	});
	const [key, csr] = await acme.crypto.createCsr({ commonName: tls.acme.domain });
	let cert: string;
	try {
		cert = await client.auto({
			csr,
			email: tls.acme.email,
			termsOfServiceAgreed: true,
			challengePriority: ["http-01"],
			challengeCreateFn: async (_a: unknown, c: { token: string }, keyAuth: string) => challenge.set(c.token, keyAuth),
			challengeRemoveFn: async (_a: unknown, c: { token: string }) => challenge.remove(c.token),
		});
		writeFileSync(certFile, cert, { mode: 0o600 });
		writeFileSync(keyFile, key, { mode: 0o600 });
	} catch (e) {
		if (existsSync(certFile) && existsSync(keyFile)) {
			const existingCert = readFileSync(certFile);
			try {
				if (certExpiry(existingCert) > Date.now()) {
					log.warn({ err: (e as Error).message }, "renovación ACME falló; utilizando certificado existente aún válido");
					return { key: readFileSync(keyFile), cert: existingCert };
				}
			} catch {
				// Certificado existente inválido, relanzar error original
			}
		}
		throw e;
	}
	return { key: Buffer.from(key), cert: Buffer.from(cert) };
}

export function loadFileTls(t: { cert: string; key: string }): TlsMaterial {
	return { key: readFileSync(t.key), cert: readFileSync(t.cert) };
}
