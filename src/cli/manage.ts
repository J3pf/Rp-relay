import { parseArgs } from "node:util";
import { adminCall, c, fmtTime, open, table } from "./util.js";

async function revoke(kind: "device" | "machine", id: string): Promise<void> {
	const { config, repos, close } = open();
	try {
		const live = await adminCall<{ ok?: boolean; error?: { message: string } }>(config, "POST", "/admin/revoke", {
			kind,
			id,
		});
		if (live) {
			if (live.status === 200)
				return console.log(
					c.green(`✓ ${kind === "device" ? "dispositivo" : "PC"} ${id} revocado (conexiones cerradas)`),
				);
			throw new Error(live.data?.error?.message ?? `HTTP ${live.status}`);
		}
		const ok = kind === "device" ? repos.devices.revoke(id, Date.now()) : repos.machines.revoke(id, Date.now());
		if (!ok) throw new Error("no encontrado o ya revocado");
		console.log(
			c.green(`✓ ${kind === "device" ? "dispositivo" : "PC"} ${id} revocado`) +
				c.dim(" (el relay no estaba en marcha)"),
		);
	} finally {
		close();
	}
}

export async function devices(argv: string[]): Promise<void> {
	const [sub, id] = argv;
	if (sub === "revoke") {
		if (!id) throw new Error("uso: rp-relay devices revoke <id>");
		return revoke("device", id);
	}
	if (sub && sub !== "list") throw new Error("uso: rp-relay devices list | revoke <id>");
	const { repos, close } = open();
	try {
		const rows = repos.devices
			.list(true)
			.map((d) => [
				d.id,
				d.name,
				fmtTime(d.created_at),
				fmtTime(d.last_seen_at),
				d.revoked_at ? "revocado" : "activo",
				d.fcm_token ? "fcm" : "",
				d.direct_enabled ? "directo" : "",
			]);
		console.log(
			rows.length
				? table(rows, ["ID", "NOMBRE", "CREADO", "VISTO", "ESTADO", "FCM", "DIRECTO"])
				: "No hay dispositivos emparejados.",
		);
	} finally {
		close();
	}
}

export async function machines(argv: string[]): Promise<void> {
	const [sub, ...rest] = argv;
	if (sub === "revoke") {
		if (!rest[0]) throw new Error("uso: rp-relay machines revoke <id>");
		return revoke("machine", rest[0]);
	}
	if (sub === "set") {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			options: { name: { type: "string" }, context: { type: "string" }, color: { type: "string" } },
		});
		const id = positionals[0];
		if (!id) throw new Error("uso: rp-relay machines set <id> [--name N] [--context C] [--color #RRGGBB]");
		if (values.color && !/^#[0-9A-Fa-f]{6}$/.test(values.color)) throw new Error("--color debe ser #RRGGBB");
		const patch = { name: values.name, context: values.context, color: values.color };
		const { config, repos, close } = open();
		try {
			const live = await adminCall<{ error?: { message: string } }>(
				config,
				"POST",
				`/admin/machines/${encodeURIComponent(id)}`,
				patch,
			);
			if (live) {
				if (live.status !== 200) throw new Error(live.data?.error?.message ?? `HTTP ${live.status}`);
			} else if (!repos.machines.patch(id, patch)) throw new Error("PC no encontrada");
			console.log(c.green(`✓ PC ${id} actualizada`));
		} finally {
			close();
		}
		return;
	}
	if (sub && sub !== "list") throw new Error("uso: rp-relay machines list | set <id> … | revoke <id>");
	const { repos, close } = open();
	try {
		const counts = repos.agents.counts();
		const rows = repos.machines
			.list(true)
			.map((m) => [
				m.id,
				m.name,
				m.context,
				m.color,
				`${counts.get(m.id)?.online ?? 0}/${counts.get(m.id)?.total ?? 0}`,
				fmtTime(m.last_seen_at),
				m.revoked_at ? "revocada" : "activa",
			]);
		console.log(
			rows.length
				? table(rows, ["ID", "NOMBRE", "CONTEXTO", "COLOR", "AGENTES", "VISTA", "ESTADO"])
				: "No hay PCs emparejadas.",
		);
	} finally {
		close();
	}
}

export async function pushTest(argv: string[]): Promise<void> {
	const { config, close } = open();
	try {
		const live = await adminCall<{
			results?: { deviceId: string; direct: string; fcm: string; error?: string }[];
			error?: { message: string };
		}>(config, "POST", "/admin/push-test", { deviceId: argv[0] });
		if (!live)
			throw new Error(
				"el relay no está en marcha: la prueba de push necesita el servidor activo (systemctl start rp-relay)",
			);
		if (live.status !== 200) throw new Error(live.data?.error?.message ?? `HTTP ${live.status}`);
		const results = live.data.results ?? [];
		if (results.length === 0) return console.log(c.yellow("No hay dispositivos a los que enviar."));
		for (const r of results)
			console.log(`${r.deviceId}  directo: ${r.direct}  fcm: ${r.fcm}${r.error ? `  (${r.error})` : ""}`);
	} finally {
		close();
	}
}
