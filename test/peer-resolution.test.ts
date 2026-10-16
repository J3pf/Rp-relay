import { describe, expect, it } from "vitest";
import type { CandidateAgent } from "../src/domain/peerResolution.js";
import { resolvePeerAgentId, resolvePeerAgentIdFromReply } from "../src/domain/peerResolution.js";
import { cleanup, connectAgent, pairMachine, promptBody, sleep, startRelay } from "./helpers.js";

const agent = (overrides: Partial<CandidateAgent> = {}): CandidateAgent => ({
	id: "agent-b",
	machine_id: "machine-2",
	session_id: "session-b-12345678",
	session_name: "worker",
	...overrides,
});

describe("resolvePeerAgentId", () => {
	it("matches an exact Pi session id", () => {
		expect(resolvePeerAgentId("agent-a", "machine-1", { sessionId: "session-b-12345678" }, [agent()])).toBe("agent-b");
	});

	it("matches a ref/session prefix with at least eight characters", () => {
		expect(resolvePeerAgentId("agent-a", "machine-1", { ref: "session-b" }, [agent()])).toBe("agent-b");
		expect(resolvePeerAgentId("agent-a", "machine-1", { sessionId: "agent-b1" }, [agent({ id: "agent-b123" })])).toBe(
			"agent-b123",
		);
	});

	it("does not match a prefix shorter than eight characters", () => {
		expect(resolvePeerAgentId("agent-a", "machine-1", { ref: "session" }, [agent()])).toBeNull();
	});

	it("matches by session name", () => {
		expect(resolvePeerAgentId("agent-a", "machine-1", { name: "worker" }, [agent()])).toBe("agent-b");
	});

	it("prefers the only same-machine match when names are duplicated", () => {
		const remote = agent({ id: "agent-remote", machine_id: "machine-2" });
		const local = agent({ id: "agent-local", machine_id: "machine-1" });
		expect(resolvePeerAgentId("agent-a", "machine-1", { name: "worker" }, [remote, local])).toBe("agent-local");
	});

	it("returns null when a match remains ambiguous across machines", () => {
		const first = agent({ id: "agent-1", machine_id: "machine-2" });
		const second = agent({ id: "agent-2", machine_id: "machine-3" });
		expect(resolvePeerAgentId("agent-a", "machine-1", { name: "worker" }, [first, second])).toBeNull();
	});

	it("prevents an agent from resolving to itself", () => {
		const self = agent({ id: "agent-a", machine_id: "machine-1", session_id: "self-session", session_name: "self" });
		expect(resolvePeerAgentId("agent-a", "machine-1", { sessionId: "self-session", name: "self" }, [self])).toBeNull();
	});

	it("resolves an incoming referenced comm by its known or derived sender", () => {
		const receiver = agent({ id: "agent-receiver", machine_id: "machine-1", session_id: "receiver-session" });
		const sender = agent();
		const referenced = {
			agent_id: receiver.id,
			machine_id: receiver.machine_id,
			direction: "in" as const,
			peer_session_id: sender.session_id,
			peer_name: sender.session_name,
			peer_cwd: null,
			peer_ref: null,
			peer_agent_id: sender.id,
		};

		expect(resolvePeerAgentIdFromReply("agent-reply", referenced, [receiver, sender])).toBe(sender.id);
		expect(resolvePeerAgentIdFromReply("agent-reply", { ...referenced, peer_agent_id: null }, [receiver, sender])).toBe(
			sender.id,
		);
	});
});

describe("peer resolution on agent connect", () => {
	it("re-resolves unresolved comms when the matching agent connects", async () => {
		const relay = await startRelay();
		try {
			const machine = await pairMachine(relay);
			const origin = await connectAgent(relay, machine, "origin-session");
			relay.relay.ctx.repos.comms.upsert({
				agent_id: origin.agentId,
				comm_id: "unresolved-comm",
				machine_id: machine.machineId,
				direction: "out",
				channel: "intercom",
				action: "send",
				peer_session_id: "arriving-session",
				peer_name: "arriving",
				peer_cwd: null,
				peer_ref: null,
				peer_agent_id: null,
				message_id: null,
				reply_to: null,
				expects_reply: false,
				text: "hello",
				truncated: false,
				delivered: null,
				at: Date.now(),
			});

			const peer = await connectAgent(relay, machine, "arriving-session", {
				agentId: `${machine.machineId}:arriving-agent`,
			});
			expect(relay.relay.ctx.repos.comms.get(origin.agentId, "unresolved-comm")?.peer_agent_id).toBe(peer.agentId);
			expect(relay.relay.ctx.repos.comms.listUnresolved()).toEqual([]);
			peer.client.close();
			origin.client.close();
		} finally {
			await relay.stop();
			cleanup(relay);
		}
	});

	it("resolves a reply to the sender of its referenced message, not a newer sibling", async () => {
		const relay = await startRelay();
		try {
			const machine = await pairMachine(relay);
			const orchestrator = await connectAgent(relay, machine, "orchestrator-session", {
				agentId: `${machine.machineId}:orchestrator`,
			});
			const sub1 = await connectAgent(relay, machine, "sub1-session", { agentId: `${machine.machineId}:sub1` });
			await sleep(10);
			const sub2 = await connectAgent(relay, machine, "sub2-session", { agentId: `${machine.machineId}:sub2` });
			expect(relay.relay.ctx.repos.agents.list()[0]?.id).toBe(sub2.agentId);

			sub1.event({
				type: "comm",
				commId: "sub1-message",
				direction: "out",
				channel: "intercom",
				action: "send",
				peer: { sessionId: "orchestrator-session", name: null, cwd: null, ref: null },
				messageId: "msg-sub1",
				replyTo: null,
				expectsReply: false,
				text: "message from sub1",
				truncated: false,
				delivered: true,
				at: Date.now(),
			});
			await sleep(30);

			orchestrator.event({
				type: "comm",
				commId: "orchestrator-reply",
				direction: "out",
				channel: "intercom",
				action: "reply",
				peer: { sessionId: null, name: null, cwd: null, ref: null },
				messageId: "msg-orchestrator-reply",
				replyTo: "msg-sub1",
				expectsReply: false,
				text: "reply to sub1",
				truncated: false,
				delivered: true,
				at: Date.now(),
			});
			await sleep(30);

			expect(relay.relay.ctx.repos.comms.get(orchestrator.agentId, "orchestrator-reply")?.peer_agent_id).toBe(
				sub1.agentId,
			);
			expect(sub2.agentId).not.toBe(sub1.agentId);
			orchestrator.client.close();
			sub1.client.close();
			sub2.client.close();
		} finally {
			await relay.stop();
			cleanup(relay);
		}
	});

	it("does not persist a comm with an invalid channel/action combination", async () => {
		const relay = await startRelay();
		try {
			const machine = await pairMachine(relay);
			const agent = await connectAgent(relay, machine, "invalid-comm-session");
			agent.event({
				type: "comm",
				commId: "invalid-intercom-message",
				direction: "out",
				channel: "intercom",
				action: "message",
				peer: { sessionId: null, name: null, cwd: null, ref: null },
				messageId: null,
				replyTo: null,
				expectsReply: false,
				text: "invalid combination",
				truncated: false,
				delivered: null,
				at: Date.now(),
			});
			await sleep(30);

			expect(relay.relay.ctx.repos.comms.get(agent.agentId, "invalid-intercom-message")).toBeUndefined();
			agent.client.close();
		} finally {
			await relay.stop();
			cleanup(relay);
		}
	});

	it("skips a malformed stored answer instead of aborting the agent connection", async () => {
		const relay = await startRelay();
		try {
			const machine = await pairMachine(relay);
			const agentId = `${machine.machineId}:invalid-answer`;
			const promptId = "invalid-pending-answer";
			relay.relay.ctx.repos.prompts.insert(agentId, promptBody(agentId, { promptId }) as never, Date.now());
			relay.relay.ctx.repos.prompts.answer(promptId, {}, null, Date.now());
			relay.relay.db.prepare("UPDATE prompts SET answer=? WHERE id=?").run("{", promptId);

			const connected = await connectAgent(relay, machine, "invalid-answer");
			expect((connected.welcome.d as { pendingAnswers: unknown[] }).pendingAnswers).toEqual([]);
			connected.client.close();
		} finally {
			await relay.stop();
			cleanup(relay);
		}
	});
});
