import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AAD fijo del protocolo (PROTOCOLO §8.1). */
export const PUSH_AAD = Buffer.from("rp1", "utf8");

export interface EncryptedPush {
	/** base64 del nonce de 12 B */
	n: string;
	/** base64 de cifrado || tag(16 B) */
	c: string;
}

export function encryptPush(key: Buffer, body: unknown, nonce: Buffer = randomBytes(12)): EncryptedPush {
	if (key.length !== 32) throw new Error("la clave de push debe tener 32 bytes");
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(PUSH_AAD);
	const plaintext = typeof body === "string" ? body : JSON.stringify(body);
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
	return { n: nonce.toString("base64"), c: ct.toString("base64") };
}

export function decryptPush(key: Buffer, enc: EncryptedPush): string {
	const nonce = Buffer.from(enc.n, "base64");
	const all = Buffer.from(enc.c, "base64");
	const tag = all.subarray(all.length - 16);
	const ct = all.subarray(0, all.length - 16);
	const d = createDecipheriv("aes-256-gcm", key, nonce);
	d.setAAD(PUSH_AAD);
	d.setAuthTag(tag);
	return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
