import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Alfabeto base32 de Crockford (sin I, L, O, U): 8 caracteres ≈ 40 bits. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type TokenKind = "device" | "machine";
const PREFIX: Record<TokenKind, string> = { device: "rpd", machine: "rpm" };

/** Token de 256 bits; sólo se guarda su SHA-256. */
export function newToken(kind: TokenKind): string {
	return `${PREFIX[kind]}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

export function newPushKey(): Buffer {
	return randomBytes(32);
}

export function newPairingCode(): string {
	const bytes = randomBytes(8);
	let out = "";
	for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i]! & 31];
	return out;
}

/** Normaliza lo que teclea el usuario: mayúsculas, sin guiones/espacios, O→0, I/L→1. */
export function normalizeCode(input: string): string {
	return input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

export const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export function bearer(header: string | string[] | undefined): string | undefined {
	if (typeof header !== "string") return undefined;
	const m = /^Bearer\s+(\S+)$/i.exec(header);
	return m?.[1];
}

export function safeEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	return ba.length === bb.length && timingSafeEqual(ba, bb);
}
