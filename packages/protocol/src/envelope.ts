import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { type ErrorCodeValue, MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./constants.js";

/** Sobre común a todos los mensajes (PROTOCOLO §2). */
export const Envelope = Type.Object({
	v: Type.Integer({ minimum: 1 }),
	t: Type.String({ minLength: 1, maxLength: 64 }),
	id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	re: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	ts: Type.Optional(Type.Number()),
	d: Type.Optional(Type.Unknown()),
});
export type Envelope<D = unknown> = Omit<Static<typeof Envelope>, "d"> & { d?: D };

export const ErrorBody = Type.Object({
	code: Type.String(),
	message: Type.String(),
	reason: Type.Optional(Type.String()),
});
export type ErrorBody = Static<typeof ErrorBody>;

const envelopeCheck = TypeCompiler.Compile(Envelope);

export type ParseResult =
	| { ok: true; env: Envelope }
	| { ok: false; reason: "too_large" | "json" | "envelope"; message: string };

/** Parsea un frame de texto en un sobre; no valida el cuerpo (eso lo hace `validateMessage`). */
export function parseFrame(raw: string | Buffer, maxBytes = MAX_FRAME_BYTES): ParseResult {
	const size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
	if (size > maxBytes) return { ok: false, reason: "too_large", message: `frame de ${size} B supera ${maxBytes} B` };
	let value: unknown;
	try {
		value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
	} catch {
		return { ok: false, reason: "json", message: "JSON inválido" };
	}
	if (!envelopeCheck.Check(value)) {
		const first = [...envelopeCheck.Errors(value)][0];
		return {
			ok: false,
			reason: "envelope",
			message: first ? `${first.path || "/"}: ${first.message}` : "sobre inválido",
		};
	}
	return { ok: true, env: value as Envelope };
}

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** ULID mínimo (sin dependencias) para ids de mensajes de los clientes de referencia y tests. */
export function newMessageId(now = Date.now()): string {
	let t = now;
	let time = "";
	for (let i = 0; i < 10; i++) {
		time = ENC[t % 32] + time;
		t = Math.floor(t / 32);
	}
	let rand = "";
	for (let i = 0; i < 16; i++) rand += ENC[Math.floor(Math.random() * 32)];
	return time + rand;
}

export function envelope<D>(t: string, d?: D, extra: Partial<Pick<Envelope, "id" | "re">> = {}): Envelope<D> {
	const env: Envelope<D> = { v: PROTOCOL_VERSION, t, ts: Date.now(), ...extra };
	if (d !== undefined) env.d = d;
	return env;
}

export function errorEnvelope(
	code: ErrorCodeValue | string,
	message: string,
	re?: string,
	reason?: string,
): Envelope<ErrorBody> {
	const body: ErrorBody = { code, message };
	if (reason) body.reason = reason;
	return envelope("error", body, re ? { re } : {});
}
