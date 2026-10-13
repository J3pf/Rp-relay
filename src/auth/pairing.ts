import { ulid } from "ulid";
import type { Repos } from "../db/repos/index.js";
import { RelayError } from "../util/errors.js";
import { MINUTE } from "../util/time.js";
import { hashToken, newPairingCode, newPushKey, newToken, normalizeCode } from "./tokens.js";

export const PAIRING_TTL_MS = 10 * MINUTE;

export class PairingService {
	constructor(
		private repos: Repos,
		private relayName: string,
	) {}

	createCode(
		kind: "device" | "machine",
		createdBy: string | null,
		meta?: { name?: string; context?: string },
		ttlMs = PAIRING_TTL_MS,
	) {
		const code = newPairingCode();
		const expiresAt = Date.now() + ttlMs;
		this.repos.pairing.insert({ codeHash: hashToken(code), kind, expiresAt, createdBy, meta });
		return { code, expiresAt };
	}

	pairDevice(req: { code: string; name: string; fcmToken?: string | null }) {
		const row = this.repos.pairing.consume(hashToken(normalizeCode(req.code)), "device", Date.now());
		if (!row) throw new RelayError("unauthorized", "código de emparejamiento inválido, usado o caducado");
		const deviceId = ulid();
		const deviceToken = newToken("device");
		const pushKey = newPushKey();
		this.repos.devices.insert({
			id: deviceId,
			name: req.name,
			tokenHash: hashToken(deviceToken),
			pushKey,
			fcmToken: req.fcmToken ?? null,
			now: Date.now(),
		});
		return {
			deviceId,
			deviceToken,
			pushKey: pushKey.toString("base64"),
			relayName: this.relayName,
			relayId: this.repos.meta.relayId(),
		};
	}

	pairMachine(req: { code: string; hostname: string; name?: string; context?: string }) {
		const row = this.repos.pairing.consume(hashToken(normalizeCode(req.code)), "machine", Date.now());
		if (!row) throw new RelayError("unauthorized", "código de emparejamiento inválido, usado o caducado");
		const meta = (row.meta ? JSON.parse(row.meta) : {}) as { name?: string; context?: string };
		const machineId = ulid();
		const machineToken = newToken("machine");
		this.repos.machines.insert({
			id: machineId,
			name: req.name ?? meta.name ?? req.hostname,
			hostname: req.hostname,
			tokenHash: hashToken(machineToken),
			context: req.context ?? meta.context ?? "personal",
			now: Date.now(),
		});
		return { machineId, machineToken, relayId: this.repos.meta.relayId() };
	}
}
