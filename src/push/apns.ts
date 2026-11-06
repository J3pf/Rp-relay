import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:http2";

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
}

export interface ApnsHttp2Stream {
	on(event: "data", listener: (chunk: Buffer | string) => void): this;
	once(event: "response", listener: (headers: { ":status"?: number | string }) => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "end" | "close", listener: () => void): this;
	end(body?: string): void;
	close(): void;
}

export interface ApnsHttp2Client {
	request(headers: Record<string, string>): ApnsHttp2Stream;
	once(event: "error", listener: (error: Error) => void): this;
	close(): void;
}

export interface ApnsSenderOptions {
	now?: () => number;
	clientFactory?: (authority: string) => ApnsHttp2Client;
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

const APNS_PROVIDER_TOKEN_TTL_MS = 40 * 60_000;

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
	const clientFactory = options.clientFactory ?? ((authority) => connect(authority) as unknown as ApnsHttp2Client);
	let cachedToken: { value: string; createdAt: number } | null = null;
	const getProviderToken = (): string => {
		const currentTime = now();
		if (!cachedToken || currentTime - cachedToken.createdAt >= APNS_PROVIDER_TOKEN_TTL_MS) {
			cachedToken = { value: providerToken(config, privateKey, currentTime), createdAt: currentTime };
		}
		return cachedToken.value;
	};

	const sendRequest = (msg: ApnsMessage, token: string): Promise<void> => {
		const session = clientFactory(`https://${msg.host}`);
		return new Promise<void>((resolve, reject) => {
			let status = 0;
			let settled = false;
			const chunks: Buffer[] = [];
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			const req = session.request({
				":method": "POST",
				":path": `/3/device/${encodeURIComponent(msg.token)}`,
				authorization: `bearer ${token}`,
				"content-type": "application/json",
				"apns-topic": msg.headers.topic,
				"apns-collapse-id": fitApnsCollapseId(msg.headers.collapseId),
				"apns-push-type": msg.headers.pushType,
				"apns-priority": String(msg.headers.priority),
			});
			session.once("error", fail);
			req.once("response", (headers) => {
				status = Number(headers[":status"] ?? 0);
			});
			req.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
			req.once("error", fail);
			req.once("end", () => {
				if (settled) return;
				const body = Buffer.concat(chunks).toString("utf8");
				if (status >= 200 && status < 300) {
					settled = true;
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
			const timer = setTimeout(() => {
				req.close();
				fail(new ApnsError("apns/timeout", 0, "timeout al enviar APNs"));
			}, APNS_TIMEOUT_MS);
			timer.unref();
			req.once("close", () => clearTimeout(timer));
			req.end(JSON.stringify(msg.payload));
		}).finally(() => session.close());
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
	};
}
