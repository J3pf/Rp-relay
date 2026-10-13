/**
 * Prueba de carga manual (RESILIENCIA §4 / PLAN-RELAY §11): 50 agentes × 20 ev/s durante 5 min.
 *
 *   npm run test:load -- [--agents 50] [--rate 20] [--duration 300] [--apps 2] [--p99 50]
 *
 * Arranca el relay como PROCESO APARTE (para no medir el bucle de eventos del generador) con una base temporal,
 * mide la latencia de reenvío (agente → app) y la memoria del relay, y sale con código 1 si p99 supera el objetivo o
 * se pierde algún evento final.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runLoad } from "./generator.js";

const ROOT = join(import.meta.dirname, "..", "..");
const { values } = parseArgs({
	options: {
		agents: { type: "string", default: "50" },
		rate: { type: "string", default: "20" },
		duration: { type: "string", default: "300" },
		apps: { type: "string", default: "2" },
		p99: { type: "string", default: "50" },
	},
});

const freePort = () =>
	new Promise<number>((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});

async function main() {
	const dir = mkdtempSync(join(tmpdir(), "rp-load-"));
	const port = await freePort();
	const cfg = join(dir, "config.json");
	writeFileSync(
		cfg,
		JSON.stringify({
			dataDir: join(dir, "data"),
			listen: { host: "127.0.0.1", port },
			publicUrl: `http://127.0.0.1:${port}`,
			logLevel: "warn",
			backup: { enabled: false },
		}),
	);
	const bin = join(ROOT, "node_modules", ".bin", "tsx");
	const run = (args: string[]) =>
		spawn(bin, [join(ROOT, "src/cli/index.ts"), ...args], {
			env: { ...process.env, RP_CONFIG: cfg },
			stdio: ["ignore", "pipe", "inherit"],
		});
	const initP = run([
		"init",
		"--yes",
		"--config",
		cfg,
		"--data-dir",
		join(dir, "data"),
		"--public-url",
		`http://127.0.0.1:${port}`,
		"--port",
		String(port),
	]);
	await new Promise((r) => initP.on("exit", r));
	const server: ChildProcess = spawn(bin, [join(ROOT, "src/cli/index.ts"), "serve"], {
		env: { ...process.env, RP_CONFIG: cfg },
		stdio: ["ignore", "inherit", "inherit"],
	});
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${base}/healthz`)).ok) break;
		} catch {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	const codeOf = async (kind: "device" | "machine") => {
		const p = run(["pair", kind, "--no-qr"]);
		let out = "";
		p.stdout!.on("data", (d) => (out += d));
		await new Promise((r) => p.on("exit", r));
		return /Código: ([0-9A-Z]{4})-([0-9A-Z]{4})/.exec(out)!.slice(1, 3).join("");
	};
	const rss = () => {
		try {
			return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${server.pid}/status`, "utf8"))![1]) / 1024;
		} catch {
			return undefined;
		}
	};
	try {
		const res = await runLoad({
			baseUrl: base,
			agents: Number(values.agents),
			apps: Number(values.apps),
			rate: Number(values.rate),
			durationSec: Number(values.duration),
			log: (m) => console.log(m),
			pair: async () => {
				const m = await (
					await fetch(`${base}/v1/pair/machine`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ code: await codeOf("machine"), hostname: "load" }),
					})
				).json();
				const d = await (
					await fetch(`${base}/v1/pair/device`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ code: await codeOf("device"), name: "load" }),
					})
				).json();
				return {
					machineId: m.machineId,
					machineToken: m.machineToken,
					deviceId: d.deviceId,
					deviceToken: d.deviceToken,
				};
			},
		});
		res.rssMb = rss();
		console.log(JSON.stringify(res, null, 2));
		const ok = res.latencyMs.p99 < Number(values.p99) && res.lostFinals === 0;
		console.log(
			ok
				? `OK: p99 ${res.latencyMs.p99} ms < ${values.p99} ms y sin pérdidas de eventos finales`
				: `FALLO: p99 ${res.latencyMs.p99} ms (objetivo < ${values.p99} ms), finales perdidos: ${res.lostFinals}`,
		);
		process.exitCode = ok ? 0 : 1;
	} finally {
		server.kill("SIGTERM");
		await new Promise((r) => setTimeout(r, 500));
		rmSync(dir, { recursive: true, force: true });
	}
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
