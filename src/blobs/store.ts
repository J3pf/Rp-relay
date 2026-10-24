import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, statSync } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ulid } from "ulid";
import type { BlobRow } from "../db/repos/blobs.js";
import type { Repos } from "../db/repos/index.js";
import { RelayError } from "../util/errors.js";
import { DAY } from "../util/time.js";

export const BLOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const isControl = (ch: string): boolean => {
	const c = ch.charCodeAt(0);
	return c < 0x20 || c === 0x7f;
};

export function sanitizeName(name: string | undefined): string {
	const base = (name ?? "archivo").split(/[\\/]/).pop() ?? "archivo";
	const clean = [...base]
		.filter((ch) => !isControl(ch) && ch !== '"')
		.join("")
		.trim()
		.slice(0, 200);
	return clean || "archivo";
}

export class BlobStore {
	private resolvedDir: string;
	constructor(
		private dir: string,
		private repos: Repos,
		private limits: { blobMaxBytes: number; blobTtlDays: number },
	) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.resolvedDir = resolve(dir);
	}

	path(id: string): string {
		if (!BLOB_ID_RE.test(id)) throw new RelayError("not_found", "adjunto no encontrado");
		const full = resolve(this.resolvedDir, id);
		if (!full.startsWith(`${this.resolvedDir}${sep}`)) {
			throw new RelayError("not_found", "adjunto no encontrado");
		}
		return full;
	}

	async save(stream: Readable, meta: { name?: string; mime?: string; uploadedBy: string }): Promise<BlobRow> {
		const id = ulid();
		const tmp = join(this.dir, `${id}.part`);
		const hash = createHash("sha256");
		let size = 0;
		const max = this.limits.blobMaxBytes;
		stream.on("data", (chunk: Buffer) => {
			size += chunk.length;
			hash.update(chunk);
			if (size > max) stream.destroy(new RelayError("too_large", `el archivo supera ${max} bytes`));
		});
		try {
			await pipeline(stream, createWriteStream(tmp, { mode: 0o600 }));
			if ((stream as { truncated?: boolean }).truncated)
				throw new RelayError("too_large", `el archivo supera ${max} bytes`);
			await rename(tmp, this.path(id));
		} catch (e) {
			await rm(tmp, { force: true });
			if (e instanceof RelayError) throw e;
			if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE")
				throw new RelayError("too_large", `el archivo supera ${max} bytes`);
			throw e;
		}
		const now = Date.now();
		const row: BlobRow = {
			id,
			sha256: hash.digest("hex"),
			name: sanitizeName(meta.name),
			mime: meta.mime || "application/octet-stream",
			size,
			uploaded_by: meta.uploadedBy,
			created_at: now,
			expires_at: now + this.limits.blobTtlDays * DAY,
		};
		try {
			this.repos.blobs.insert(row);
		} catch (e) {
			await rm(this.path(id), { force: true });
			throw e;
		}
		return row;
	}

	open(id: string) {
		const p = this.path(id);
		const st = statSync(p, { throwIfNoEntry: false });
		if (!st) return null;
		return { stream: createReadStream(p), size: st.size };
	}

	/** Borra blobs caducados (archivo + fila) y archivos huérfanos o `.part` viejos. */
	async gc(now = Date.now()): Promise<number> {
		let n = 0;
		for (const b of this.repos.blobs.expired(now)) {
			await rm(this.path(b.id), { force: true });
			this.repos.blobs.delete(b.id);
			n++;
		}
		const files = await readdir(this.dir);
		const known = new Set(this.repos.blobs.all().map((b) => b.id));
		for (const f of files) {
			const full = join(this.dir, f);
			const id = f.replace(/\.part$/, "");
			const st = await stat(full).catch(() => null);
			if (!st) continue;
			const age = now - st.mtimeMs;
			if ((f.endsWith(".part") && age > 3_600_000) || (!f.endsWith(".part") && !known.has(id) && age > 3_600_000)) {
				await rm(full, { force: true });
				n++;
			}
		}
		return n;
	}
}
