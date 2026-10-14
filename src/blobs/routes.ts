import type { FastifyInstance } from "fastify";
import type { Ctx } from "../context.js";
import type { HttpAuth } from "../http/auth.js";
import { RelayError } from "../util/errors.js";

export function registerBlobRoutes(app: FastifyInstance, c: () => Ctx, auth: HttpAuth): void {
	app.post("/v1/blobs", { preHandler: auth.device }, async (req, reply) => {
		const part = await req.file();
		if (!part) throw new RelayError("bad_request", "falta el campo multipart 'file'");
		const row = await c().blobs.save(part.file, {
			name: part.filename,
			mime: part.mimetype,
			uploadedBy: req.device!.id,
		});
		return reply.code(201).send({ blobId: row.id, sha256: row.sha256, size: row.size, mime: row.mime });
	});

	app.get<{ Params: { id: string } }>("/v1/blobs/:id", { preHandler: auth.deviceOrMachine }, async (req, reply) => {
		const { repos, blobs } = c();
		const row = repos.blobs.get(req.params.id);
		if (!row || row.expires_at <= Date.now()) throw new RelayError("not_found", "adjunto no encontrado o caducado");
		if (req.device && row.uploaded_by !== req.device.id) throw new RelayError("not_found", "adjunto no encontrado");
		if (req.machine && !repos.blobs.granted(row.id, req.machine.id))
			throw new RelayError("not_found", "adjunto no encontrado");
		const f = blobs.open(row.id);
		if (!f) {
			repos.blobs.delete(row.id);
			throw new RelayError("not_found", "adjunto no encontrado");
		}
		const filename = encodeURIComponent(row.name ?? row.id);
		return reply
			.header("Content-Type", row.mime ?? "application/octet-stream")
			.header("Content-Length", f.size)
			.header("Content-Disposition", `attachment; filename*=UTF-8''${filename}`)
			.header("ETag", `"${row.sha256}"`)
			.header("X-Content-Type-Options", "nosniff")
			.header("Cache-Control", "private, max-age=3600")
			.send(f.stream);
	});
}
