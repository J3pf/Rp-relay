import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:http2";
import { MINUTE } from "../util/time.js";

export interface ApnsMessage {
	host: "api.push.apple.com" | "api.development.push.apple.com";
	token: string;
	payload: Record<string, unknown>;
	headers: {
		topic: string;
		collapseId: string;
		pushType: string;
		priority: 10 | 5;
	};
}

export interface ApnsSender {
	send(msg: ApnsMessage): Promise<void>;
	close?(): void;
}

export interface ApnsHttp2Stream {
	on(event: "data", listener: (chunk: Buffer | string) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	once(event: "response", listener: (headers: { ":status"?: number | string }) => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "end" | "close", listener: () => void): this;
	end(body?: string): void;
	close(): void;
}

export interface ApnsHttp2Client {
	request(headers: Record<string, string>): ApnsHttp2Stream;
	on(event: "error", listener: (error: Error) => void): this;
	off(event: "error", listener: (error: Error) => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "close" | "goaway", listener: () => void): this;
	setTimeout?(msecs: number, callback: () => void): void;
	destroy?(error?: Error): void;
	closed?: boolean;
	destroyed?: boolean;
	close(): void;
}

export interface ApnsSenderOptions {
	now?: () => number;
	clientFactory?: (authority: string) => ApnsHttp2Client;
	timeoutMs?: number;
	idleTimeoutMs?: number;
}

export interface ApnsConfig {
	keyId: string;
	teamId: string;
	keyFile: string;
	bundleId: string;
	env: "sandbox" | "production";
}

export const APNS_BAD_TOKEN = "Unregistered";
export const BAD_DEVICE_TOKEN = "BadDeviceToken";
const APNS_TIMEOUT_MS = 10_000;
const APNS_IDLE_TIMEOUT_MS = 5 * MINUTE;

/** Prefix-truncates at a Unicode code-point boundary, with an absolute 64-byte APNs header limit. */
export function fitApnsCollapseId(value: string): string {
	let result = "";
	let bytes = 0;
	for (const char of value) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (bytes + charBytes > 64) break;
		result += char;
		bytes += charBytes;
	}
	return result;
}

export class ApnsError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApnsError";
	}
}

const APNS_PROVIDER_TOKEN_TTL_MS = 40 * MINUTE;

function providerToken(config: ApnsConfig, privateKey: string, now: number): string {
	const encode = (value: string | Buffer) => Buffer.from(value).toString("base64url");
	const input = `${encode(JSON.stringify({ alg: "ES256", kid: config.keyId }))}.${encode(
		JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }),
	)}`;
	const signer = createSign("SHA256");
	signer.update(input);
	signer.end();
	const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
	return `${input}.${signature}`;
}

/** Envío APNs HTTP/2; la clave privada sólo se lee cuando esta fábrica se configura. */
export function createApnsSender(config: ApnsConfig, options: ApnsSenderOptions = {}): ApnsSender {
	const privateKey = readFileSync(config.keyFile, "utf8");
	const now = options.now ?? Date.now;
	// Validate the ES256 private key at startup so invalid PEM files fail fast.
	providerToken(config, privateKey, now());
	const clientFactory = options.clientFactory ?? ((authority) => connect(authority) as unknown as ApnsHttp2Client);
	const timeoutMs = options.timeoutMs ?? APNS_TIMEOUT_MS;
	const idleTimeoutMs = options.idleTimeoutMs ?? APNS_IDLE_TIMEOUT_MS;
	const sessions = new Map<string, ApnsHttp2Client>();
	const destroySession = (session: ApnsHttp2Client): void => {
		try {
			if (typeof session.destroy === "function") session.destroy();
			else session.close();
		} catch {
			// ignore destroy/close errors on broken session
		}
	};
	const evictSession = (authority: string, session: ApnsHttp2Client, destroy = false): void => {
		if (sessions.get(authority) === session) sessions.delete(authority);
		if (destroy) destroySession(session);
	};
	const getSession = (authority: string): ApnsHttp2Client => {
		const existing = sessions.get(authority);
		if (existing && !existing.closed && !existing.destroyed) return existing;
		const session = clientFactory(authority);
		const evictAndDestroy = () => evictSession(authority, session, true);
		const evictOnly = () => evictSession(authority, session, false);
		if (typeof session.on === "function") {
			session.on("error", evictAndDestroy);
		} else {
			session.once("error", evictAndDestroy);
		}
		session.once?.("close", evictOnly);
		session.once?.("goaway", evictAndDestroy);
		session.setTimeout?.(idleTimeoutMs, evictAndDestroy);
		sessions.set(authority, session);
		return session;
	};
	let cachedToken: { value: string; createdAt: number } | null = null;
	const getProviderToken = (): string => {
		const currentTime = now();
		if (!cachedToken || currentTime - cachedToken.createdAt >= APNS_PROVIDER_TOKEN_TTL_MS) {
			cachedToken = { value: providerToken(config, privateKey, currentTime), createdAt: currentTime };
		}
		return cachedToken.value;
	};

	const sendRequest = (msg: ApnsMessage, token: string): Promise<void> => {
		const authority = `https://${msg.host}`;
		const session = getSession(authority);
		return new Promise<void>((resolve, reject) => {
			let status = 0;
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const chunks: Buffer[] = [];
			const cleanup = () => {
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				session.off?.("error", fail);
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			let req: ApnsHttp2Stream;
			try {
				req = session.request({
					":method": "POST",
					":path": `/3/device/${encodeURIComponent(msg.token)}`,
					authorization: `bearer ${token}`,
					"content-type": "application/json",
					"apns-topic": msg.headers.topic,
					"apns-collapse-id": fitApnsCollapseId(msg.headers.collapseId),
					"apns-push-type": msg.headers.pushType,
					"apns-priority": String(msg.headers.priority),
				});
			} catch (err) {
				evictSession(authority, session, true);
				reject(err as Error);
				return;
			}
			if (typeof session.on === "function") {
				session.on("error", fail);
			} else {
				session.once("error", fail);
			}
			req.once("response", (headers) => {
				status = Number(headers[":status"] ?? 0);
			});
			req.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
			if (typeof req.on === "function") {
				req.on("error", fail);
			} else {
				req.once("error", fail);
			}
			req.once("end", () => {
				if (settled) return;
				const body = Buffer.concat(chunks).toString("utf8");
				if (status >= 200 && status < 300) {
					settled = true;
					cleanup();
					resolve();
					return;
				}
				let reason: string | undefined;
				try {
					reason = (JSON.parse(body) as { reason?: string }).reason;
				} catch {
					// APNs may return an empty response body.
				}
				const code =
					status === 410 || reason === APNS_BAD_TOKEN
						? APNS_BAD_TOKEN
						: status === 400 && reason === BAD_DEVICE_TOKEN
							? BAD_DEVICE_TOKEN
							: (reason ?? "apns/rejected");
				fail(new ApnsError(code, status, reason ?? `APNs HTTP ${status}: ${body}`));
			});
			timer = setTimeout(() => {
				fail(new ApnsError("apns/timeout", 0, "timeout al enviar APNs"));
				evictSession(authority, session, true);
				try {
					req.close();
				} catch {
					// ignore stream close errors
				}
			}, timeoutMs);
			timer.unref();
			req.once("close", () => {
				if (!settled) {
					fail(new ApnsError("apns/stream-closed", status, "stream APNs cerrado prematuramente"));
					return;
				}
				cleanup();
			});
			req.end(JSON.stringify(msg.payload));
		});
	};

	return {
		async send(msg) {
			const token = getProviderToken();
			try {
				await sendRequest(msg, token);
			} catch (error) {
				if (!(error instanceof ApnsError) || error.status !== 403 || error.code !== "ExpiredProviderToken") throw error;
				if (cachedToken?.value === token) cachedToken = null;
				await sendRequest(msg, getProviderToken());
			}
		},
		close() {
			for (const s of sessions.values()) {
				try {
					s.close();
				} catch {
					// ignore
				}
			}
			sessions.clear();
		},
	};
}
