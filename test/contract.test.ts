import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS, type Channel, knownTypes, parseFrame, validateMessage } from "@j3pf/rp-protocol";
import { describe, expect, it } from "vitest";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "protocol", "fixtures");
const files = readdirSync(dir).filter((f) => /\.(valid|invalid)\.json$/.test(f));

describe("contrato: fixtures", () => {
	it("hay fixtures", () => expect(files.length).toBeGreaterThan(50));

	for (const f of files) {
		const valid = f.endsWith(".valid.json");
		const [channel, t] = f.split("__");
		it(`${f} → ${valid ? "válido" : "inválido"}`, () => {
			const raw = readFileSync(join(dir, f), "utf8");
			const parsed = parseFrame(raw);
			if (channel === "envelope") {
				expect(parsed.ok).toBe(valid);
				return;
			}
			expect(parsed.ok, "el sobre de un fixture del canal debe parsear").toBe(true);
			if (!parsed.ok) return;
			expect(CHANNELS).toContain(channel);
			const res = validateMessage(channel as Channel, parsed.env);
			expect(res.ok, res.ok ? "" : res.message).toBe(valid);
			expect(parsed.env.t).toBe(t);
		});
	}

	it("cada tipo conocido de cada canal tiene al menos un fixture válido", () => {
		const covered = new Set(
			files.filter((f) => f.endsWith(".valid.json")).map((f) => f.split("__").slice(0, 2).join("__")),
		);
		const missing: string[] = [];
		for (const ch of CHANNELS)
			for (const t of knownTypes(ch)) if (!covered.has(`${ch}__${t}`)) missing.push(`${ch}/${t}`);
		expect(missing).toEqual([]);
	});

	it("rechaza tipos desconocidos y JSON roto", () => {
		const p = parseFrame('{"v":1,"t":"no.existe"}');
		expect(p.ok).toBe(true);
		if (p.ok) {
			const r = validateMessage("up", p.env);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.unknown).toBe(true);
		}
		expect(parseFrame("{no json").ok).toBe(false);
		expect(parseFrame("x".repeat(2_000_000)).ok).toBe(false);
	});
});
