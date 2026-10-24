import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { adminTokenPath, type Config, dbPath, loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { Repos } from "../db/repos/index.js";

export const c = {
	green: (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
	red: (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
	yellow: (s: string) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
	dim: (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
	bold: (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};

export function open(): { config: Config; repos: Repos; close(): void } {
	const config = loadConfig();
	const db = openDb(dbPath(config));
	migrate(db);
	return { config, repos: new Repos(db), close: () => db.close() };
}

export function fmtTime(ms: number | null): string {
	return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "—";
}

export function table(rows: string[][], header: string[]): string {
	const all = [header, ...rows];
	const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
	const line = (r: string[]) => r.map((v, i) => (v ?? "").padEnd(widths[i]!)).join("  ");
	return [c.bold(line(header)), ...rows.map(line)].join("\n");
}

export function localBase(config: Config): { proto: "http" | "https"; host: string; port: number } {
	const h = config.listen.host;
	return {
		proto: config.tls ? "https" : "http",
		host: h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h,
		port: config.listen.port,
	};
}

/** Llama a la API de administración del relay en marcha; `null` si no responde (relay parado). */
export async function adminCall<T = unknown>(
	config: Config,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
	timeoutMs?: number,
): Promise<{ status: number; data: T } | null> {
	let token: string;
	try {
		token = readFileSync(adminTokenPath(config), "utf8").trim();
	} catch {
		return null;
	}
	const { proto, host, port } = localBase(config);
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const envTimeout = process.env.RP_ADMIN_TIMEOUT_MS ? Number(process.env.RP_ADMIN_TIMEOUT_MS) : undefined;
	const timeout = timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout! > 0 ? envTimeout! : 15_000);

	return new Promise((resolve, reject) => {
		const req = (proto === "https" ? httpsRequest : httpRequest)(
			{
				host,
				port,
				path,
				method,
				timeout,
				headers: {
					authorization: `Bearer ${token}`,
					...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
				},
				// el certificado es del dominio público, no de 127.0.0.1; sólo desactivar validación en loopback
				...(proto === "https" && (host === "127.0.0.1" || host === "::1" || host === "localhost")
					? { rejectUnauthorized: false }
					: {}),
			},
			(res) => {
				const chunks: Buffer[] = [];
				let totalBytes = 0;
				res.on("data", (d: Buffer) => {
					totalBytes += d.length;
					if (totalBytes > 1024 * 1024) {
						req.destroy(new Error("respuesta administrativa demasiado grande"));
						return;
					}
					chunks.push(d);
				});
				res.on("end", () => {
					let data: unknown = null;
					try {
						data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					} catch {
						// respuesta no JSON
					}
					resolve({ status: res.statusCode ?? 0, data: data as T });
				});
			},
		);
		req.on("error", (e: NodeJS.ErrnoException) => (e.code === "ECONNREFUSED" ? resolve(null) : reject(e)));
		req.on("timeout", () => {
			req.destroy(new Error("tiempo de espera agotado"));
		});
		if (payload) req.write(payload);
		req.end();
	});
}
