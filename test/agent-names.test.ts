import { describe, expect, it } from "vitest";
import { agentDisplayName, disambiguateAgentNames, isHumanName } from "../src/domain/agentNames.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("agentDisplayName", () => {
	it("returns a genuine human session_name when provided", () => {
		expect(agentDisplayName({ session_name: "orchestrator" })).toBe("orchestrator");
		expect(agentDisplayName({ session_name: "Release work" })).toBe("Release work");
		expect(agentDisplayName({ session_name: "worker-a" })).toBe("worker-a");
		expect(agentDisplayName({ session_name: "Frontend Coordinator" })).toBe("Frontend Coordinator");
	});

	it("rejects UUID session_names and falls back to cwd basename or Agent", () => {
		const uuid = "01a14fbb-44e3-765f-99e1-970655bf47bf";
		expect(isHumanName(uuid)).toBe(false);

		// With valid cwd
		const withCwd = agentDisplayName({
			session_name: uuid,
			cwd: "/home/x/Workspace/RP/Rp-app",
		});
		expect(withCwd).toBe("Rp-app");
		expect(UUID_REGEX.test(withCwd)).toBe(false);

		// Without cwd
		const withoutCwd = agentDisplayName({
			session_name: uuid,
		});
		expect(withoutCwd).toBe("Agent");
		expect(UUID_REGEX.test(withoutCwd)).toBe(false);
	});

	it("rejects auto names like subagent-chat-<hex>", () => {
		const autoName = "subagent-chat-01a14fbb-44e3-765f";
		expect(isHumanName(autoName)).toBe(false);

		const result = agentDisplayName({
			session_name: autoName,
			cwd: "/home/x/Workspace/RP/Rp-app",
		});
		expect(result).toBe("Rp-app");

		const resultNoCwd = agentDisplayName({
			session_name: autoName,
		});
		expect(resultNoCwd).toBe("Agent");

		const autoNameFullUuid = "subagent-chat-01a14fbb-2812-7332-aae5-d003f17b8fe7";
		expect(isHumanName(autoNameFullUuid)).toBe(false);
	});

	it("returns basename(cwd) when session_name is null or empty", () => {
		expect(
			agentDisplayName({
				session_name: null,
				cwd: "/home/x/Workspace/RP/Rp-app",
			}),
		).toBe("Rp-app");

		expect(
			agentDisplayName({
				session_name: "",
				cwd: "/home/x/Workspace/RP/Rp-app",
			}),
		).toBe("Rp-app");

		expect(
			agentDisplayName({
				session_name: "   ",
				cwd: "/home/x/Workspace/RP/Rp-app/",
			}),
		).toBe("Rp-app");
	});

	it("falls back to Agent when cwd is root or empty", () => {
		expect(agentDisplayName({ session_name: null, cwd: "/" })).toBe("Agent");
		expect(agentDisplayName({ session_name: null, cwd: "" })).toBe("Agent");
		expect(agentDisplayName({ session_name: null, cwd: null })).toBe("Agent");
		expect(agentDisplayName({})).toBe("Agent");
		expect(agentDisplayName(null)).toBe("Agent");
		expect(agentDisplayName(undefined)).toBe("Agent");
	});

	it("rejects session_name equal to session_id or agent id", () => {
		const sessionId = "session-12345";
		const agentId = "machine-1:session-12345";

		expect(
			agentDisplayName({
				id: agentId,
				session_id: sessionId,
				session_name: sessionId,
				cwd: "/home/x/Workspace/RP/Rp-app",
			}),
		).toBe("Rp-app");

		expect(
			agentDisplayName({
				id: agentId,
				session_id: sessionId,
				session_name: agentId,
				cwd: "/home/x/Workspace/RP/Rp-app",
			}),
		).toBe("Rp-app");

		expect(
			agentDisplayName({
				id: agentId,
				session_id: sessionId,
				session_name: "session-12345",
				cwd: null,
			}),
		).toBe("Agent");
	});

	it("rejects ULID session_names", () => {
		const ulid = "01AN4Z07BY79KA1307SR9X4MV3";
		expect(isHumanName(ulid)).toBe(false);
		expect(agentDisplayName({ session_name: ulid, cwd: "/home/x/project" })).toBe("project");
		expect(agentDisplayName({ session_name: ulid })).toBe("Agent");
	});

	it("rejects raw hex ids", () => {
		const hexId = "01a14fbb28127332";
		const hyphenatedHex = "01a14fbb-2812-7332";
		expect(isHumanName(hexId)).toBe(false);
		expect(isHumanName(hyphenatedHex)).toBe(false);
		expect(agentDisplayName({ session_name: hexId })).toBe("Agent");
		expect(agentDisplayName({ session_name: hyphenatedHex })).toBe("Agent");
	});

	it("never returns a raw UUID or ID even if cwd basename is an ID", () => {
		const uuid = "01a14fbb-44e3-765f-99e1-970655bf47bf";
		const result = agentDisplayName({
			session_name: null,
			cwd: `/tmp/${uuid}`,
		});
		expect(result).toBe("Agent");
		expect(UUID_REGEX.test(result)).toBe(false);
	});
});

describe("disambiguateAgentNames", () => {
	it("disambiguates duplicates on the same machine deterministically", () => {
		const agents = [
			{ id: "a3", machine_id: "m1", cwd: "/repo/Rp-app", first_seen_at: 300 },
			{ id: "a1", machine_id: "m1", cwd: "/repo/Rp-app", first_seen_at: 100 },
			{ id: "a2", machine_id: "m1", cwd: "/repo/Rp-app", first_seen_at: 200 },
		];

		const names = disambiguateAgentNames(agents);
		expect(names.get("a1")).toBe("Rp-app");
		expect(names.get("a2")).toBe("Rp-app (2)");
		expect(names.get("a3")).toBe("Rp-app (3)");
	});

	it("keeps same display name on different machines unsuffixed", () => {
		const agents = [
			{ id: "m1-a1", machine_id: "m1", cwd: "/repo/Rp-app", first_seen_at: 100 },
			{ id: "m2-a1", machine_id: "m2", cwd: "/other/Rp-app", first_seen_at: 150 },
		];

		const names = disambiguateAgentNames(agents);
		expect(names.get("m1-a1")).toBe("Rp-app");
		expect(names.get("m2-a1")).toBe("Rp-app");
	});

	it("disambiguates when there are duplicates on machine 1 and duplicates on machine 2", () => {
		const agents = [
			{ id: "m1-a1", machine_id: "m1", cwd: "/repo/Rp-app", first_seen_at: 100 },
			{ id: "m1-a2", machine_id: "m1", cwd: "/repo/Rp-app", first_seen_at: 200 },
			{ id: "m2-a1", machine_id: "m2", cwd: "/other/Rp-app", first_seen_at: 50 },
			{ id: "m2-a2", machine_id: "m2", cwd: "/other/Rp-app", first_seen_at: 150 },
		];

		const names = disambiguateAgentNames(agents);
		expect(names.get("m1-a1")).toBe("Rp-app");
		expect(names.get("m1-a2")).toBe("Rp-app (2)");
		expect(names.get("m2-a1")).toBe("Rp-app");
		expect(names.get("m2-a2")).toBe("Rp-app (2)");
	});

	it("tie-breaks by agent id when first_seen_at is equal", () => {
		const agents = [
			{ id: "z-agent", machine_id: "m1", cwd: "/repo/worker", first_seen_at: 100 },
			{ id: "a-agent", machine_id: "m1", cwd: "/repo/worker", first_seen_at: 100 },
		];

		const names = disambiguateAgentNames(agents);
		expect(names.get("a-agent")).toBe("worker");
		expect(names.get("z-agent")).toBe("worker (2)");
	});
});
