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
});
