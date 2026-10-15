import { type Static, Type } from "@sinclair/typebox";
import {
	AgentStatus,
	Answer,
	Entry,
	Id,
	MachineQuota,
	OptNullable,
	PiEvent,
	Prompt,
	PromptResolved,
	UserMessageAck,
	UserMessageBody,
} from "./common.js";

export const MachineSummary = Type.Object({
	machineId: Id,
	name: Type.String(),
	context: Type.String(),
	color: Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }),
	icon: OptNullable(Type.String()),
	online: Type.Boolean(),
	agentCount: Type.Integer({ minimum: 0 }),
	openPromptCount: Type.Integer({ minimum: 0 }),
	hostOnline: Type.Boolean(),
	relayId: Type.Optional(Type.String()),
	quotas: Type.Optional(Type.Array(MachineQuota)),
});
export type MachineSummary = Static<typeof MachineSummary>;

export const AgentSummary = Type.Object({
	agentId: Id,
	machineId: Id,
	machineName: Type.String(),
	machineContext: Type.String(),
	machineColor: Type.String(),
	sessionName: OptNullable(Type.String()),
	cwd: OptNullable(Type.String()),
	gitBranch: OptNullable(Type.String()),
	model: OptNullable(Type.String()),
	status: AgentStatus,
	online: Type.Boolean(),
	lastSeenAt: Type.Number(),
	openPromptCount: Type.Integer({ minimum: 0 }),
	lastMessagePreview: OptNullable(Type.String({ maxLength: 140 })),
	launcher: OptNullable(Type.String()),
	herdr: OptNullable(Type.Unknown()),
	gentleMode: OptNullable(Type.String()),
	redacted: Type.Boolean(),
	spawnedByHost: Type.Boolean(),
	kind: Type.Optional(Type.String()),
});
export type AgentSummary = Static<typeof AgentSummary>;

// ---- App → Relay (PROTOCOLO §6) ----

export const AppHello = Type.Object({
	deviceId: Id,
	app: Type.Object({ version: Type.String() }),
	subscriptions: Type.Optional(Type.Literal("all")),
});
export const AgentSubscribe = Type.Object({
	agentId: Id,
	sinceSeq: OptNullable(Type.Integer({ minimum: 0 })),
	epoch: OptNullable(Type.String()),
});
export const AgentRef = Type.Object({ agentId: Id });
export const AppUserMessage = Type.Composite([UserMessageBody, Type.Object({ agentId: Id })]);
export const AppPromptAnswer = Type.Object({ promptId: Id, answer: Answer });
export const PushAck = Type.Object({ pushId: Id });

// ---- Relay → App ----

export const AppWelcome = Type.Object({
	machines: Type.Array(MachineSummary),
	agents: Type.Array(AgentSummary),
	openPrompts: Type.Array(Prompt),
	relayId: Type.Optional(Type.String()),
	relayName: Type.Optional(Type.String()),
	serverTime: Type.Optional(Type.Number()),
});
export const AgentHistory = Type.Object({
	agentId: Id,
	epoch: OptNullable(Type.String()),
	entries: Type.Array(Entry),
	events: Type.Array(Type.Object({ seq: Type.Integer(), ts: Type.Number(), e: PiEvent })),
	liveFromSeq: Type.Integer({ minimum: 0 }),
	truncated: Type.Optional(Type.Boolean()),
});
export const MachinesUpdate = Type.Object({
	upsert: Type.Array(MachineSummary),
	remove: Type.Array(Id),
});
export const AgentsUpdate = Type.Object({
	upsert: Type.Array(AgentSummary),
	remove: Type.Array(Id),
});
export const AppAgentEvent = Type.Object({
	agentId: Id,
	epoch: Id,
	seq: Type.Integer({ minimum: 1 }),
	e: PiEvent,
});
export const PromptResolvedApp = PromptResolved;
export const TerminalWait = Type.Object({
	agentId: Id,
	kind: Type.Optional(Type.String()),
	title: OptNullable(Type.String()),
	active: Type.Boolean(),
});
export const PromptAnswerResult = Type.Object({
	ok: Type.Boolean(),
	reason: Type.Optional(
		Type.Union([Type.Literal("already_resolved"), Type.Literal("agent_offline_queued"), Type.Literal("not_found")]),
	),
});
export { UserMessageAck };
