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

// TODO: Cache and refresh provider JWTs to avoid APNs TooManyProviderTokenUpdates under high send volume.
function providerToken(config: ApnsConfig, privateKey: string): string {
	const encode = (value: string | Buffer) => Buffer.from(value).toString("base64url");
	const input = `${encode(JSON.stringify({ alg: "ES256", kid: config.keyId }))}.${encode(
		JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }),
	)}`;
	const signer = createSign("SHA256");
	signer.update(input);
	signer.end();
	const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
	return `${input}.${signature}`;
}

/** Envío APNs HTTP/2; la clave privada sólo se lee cuando esta fábrica se configura. */
export function createApnsSender(config: ApnsConfig): ApnsSender {
	const privateKey = readFileSync(config.keyFile, "utf8");
	return {
		send(msg) {
			const session = connect(`https://${msg.host}`);
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
					authorization: `bearer ${providerToken(config, privateKey)}`,
					"content-type": "application/json",
					"apns-topic": msg.headers.topic,
					"apns-collapse-id": msg.headers.collapseId,
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
		},
	};
}
