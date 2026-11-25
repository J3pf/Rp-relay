import { describe, expect, it } from "vitest";
import { fitApnsCollapseId } from "../src/push/apns.js";
import { fitBody } from "../src/push/dispatcher.js";

const bytes = (o: unknown) => Buffer.byteLength(JSON.stringify(o));
const base = { promptId: "p", agentId: "a", pushId: "x", machineId: "m", kind: "error", category: "c" };

describe("fitApnsCollapseId", () => {
	it("truncates deterministically at a code-point boundary to <= 64 B", () => {
		const r = fitApnsCollapseId("😀".repeat(30));
		expect(Buffer.byteLength(r)).toBeLessThanOrEqual(64);
		expect(Array.from(r).length).toBe(16);
		expect(fitApnsCollapseId("😀".repeat(30))).toBe(r);
		expect(fitApnsCollapseId("short")).toBe("short");
	});
});

describe("fitBody long-field guard", () => {
	it.each([2900, 3000])("keeps unspecified long fields within %i B", (max) => {
		const input = { ...base, detail: "x".repeat(6000), preview: "é".repeat(4000), zzz: { a: ["y".repeat(5000)] } };
		const snapshot = JSON.stringify(input);
		const out = fitBody(input, max);
		expect(bytes(out)).toBeLessThanOrEqual(max);
		expect(JSON.stringify(input)).toBe(snapshot);
		expect(JSON.stringify(fitBody(input, max))).toBe(JSON.stringify(out));
	});

	it("drops optional overflow fields in priority order while preserving required keys", () => {
		const input = {
			...base,
			detail: "d".repeat(200),
			preview: "p".repeat(200),
			agentLabel: "l".repeat(200),
			options: [
				{ id: "1", label: "One" },
				{ id: "2", label: "Two" },
				{ id: "3", label: "Three" },
				{ id: "4", label: "Four" },
			],
			extra: { nested: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
		};
		const snapshot = JSON.stringify(input);
		const out = fitBody(input, 140);
		expect(bytes(out)).toBeLessThanOrEqual(140);
		expect(JSON.stringify(input)).toBe(snapshot);
		expect("promptId" in out).toBe(true);
		expect("agentId" in out).toBe(true);
		expect("pushId" in out).toBe(true);
		expect("machineId" in out).toBe(true);
		expect("kind" in out).toBe(true);
		expect("category" in out).toBe(true);
		expect(out.detail).toBeUndefined();
		expect(out.preview).toBeUndefined();
	});
});
