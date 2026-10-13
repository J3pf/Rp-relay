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
	const app = mod.initializeApp({ credential: mod.credential.cert(sa) }, `rp-relay-${Date.now()}`);
	const messaging = mod.messaging(app);
	log.info({ project: sa.project_id }, "FCM habilitado");
	return {
		async send(msg) {
			try {
				await messaging.send({
					token: msg.token,
					data: msg.data,
					android: { priority: msg.android.priority, ttl: msg.android.ttl, collapseKey: msg.android.collapseKey },
				});
			} catch (e) {
				const err = e as { code?: string; message?: string };
				throw new FcmError(err.code ?? "messaging/unknown", err.message ?? "error FCM");
			}
		},
	};
}
