import type { IncomingHttpHeaders } from "node:http";
import type { DeviceRow, MachineRow, Repos } from "../db/repos/index.js";
import { bearer, hashToken } from "./tokens.js";

export type AuthResult<T> = { ok: true; row: T } | { ok: false; reason: "missing" | "invalid" | "revoked" };

export class Authenticator {
	constructor(private repos: Repos) {}

	device(headers: IncomingHttpHeaders): AuthResult<DeviceRow> {
		const token = bearer(headers.authorization);
		if (!token) return { ok: false, reason: "missing" };
		const row = this.repos.devices.byTokenHash(hashToken(token));
		if (!row) return { ok: false, reason: "invalid" };
		if (row.revoked_at) return { ok: false, reason: "revoked" };
		return { ok: true, row };
	}

	machine(headers: IncomingHttpHeaders): AuthResult<MachineRow> {
		const token = bearer(headers.authorization);
		if (!token) return { ok: false, reason: "missing" };
		const row = this.repos.machines.byTokenHash(hashToken(token));
		if (!row) return { ok: false, reason: "invalid" };
		if (row.revoked_at) return { ok: false, reason: "revoked" };
		return { ok: true, row };
	}
}
