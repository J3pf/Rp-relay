import { readFileSync } from "node:fs";
import type { Logger } from "pino";

export interface FcmMessage {
	token: string;
	data: Record<string, string>;
	android: { priority: "high" | "normal"; ttl: number; collapseKey: string };
}

/** Abstracción del envío FCM; inyectable en tests (`FcmSender`). */
export interface FcmSender {
	send(msg: FcmMessage): Promise<void>;
}

export class FcmError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export const FCM_UNREGISTERED = "messaging/registration-token-not-registered";
const FCM_TIMEOUT_MS = 10_000;

/** Envío real con `firebase-admin` (dependencia opcional, FCM HTTP v1). */
export async function createFirebaseSender(serviceAccountFile: string, log: Logger): Promise<FcmSender> {
	const sa = JSON.parse(readFileSync(serviceAccountFile, "utf8"));
	let admin: any;
	try {
		admin = await import("firebase-admin");
	} catch (e) {
		throw new Error(
			`firebase-admin no está instalado (${(e as Error).message}); instálalo o quita "fcm" de la configuración`,
		);
	}
	const mod = admin.default ?? admin;
	const appName = `rp-relay-${sa.project_id ?? "default"}`;
	const existing = Array.isArray(mod.apps) ? mod.apps.find((a: any) => a?.name === appName) : undefined;
	const app = existing ?? mod.initializeApp({ credential: mod.credential.cert(sa) }, appName);
	const messaging = mod.messaging(app);
	log.info({ project: sa.project_id }, "FCM habilitado");
	return {
		async send(msg) {
			let timer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					messaging.send({
						token: msg.token,
						data: msg.data,
						android: { priority: msg.android.priority, ttl: msg.android.ttl, collapseKey: msg.android.collapseKey },
					}),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject({ code: "messaging/timeout", message: "timeout al enviar FCM" }),
							FCM_TIMEOUT_MS,
						);
						timer.unref();
					}),
				]);
			} catch (e) {
				const err = e as { code?: string; message?: string };
				throw new FcmError(err.code ?? "messaging/unknown", err.message ?? "error FCM");
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}
