import { type Static, Type } from "@sinclair/typebox";
import { AgentStatus, Id, Nullable, OptNullable, SubagentUpdateEvent } from "./common.js";

export const CommPeer = Type.Object({
	sessionId: Nullable(Type.String()),
	name: Nullable(Type.String()),
	cwd: Nullable(Type.String()),
	ref: Nullable(Type.String()),
});
export type CommPeer = Static<typeof CommPeer>;

export const CommDirection = Type.Union([Type.Literal("out"), Type.Literal("in")]);
export type CommDirection = Static<typeof CommDirection>;

export const CommChannel = Type.Union([Type.Literal("intercom"), Type.Literal("orchestrator")]);
export type CommChannel = Static<typeof CommChannel>;

export const CommAction = Type.Union([
	Type.Literal("send"),
	Type.Literal("ask"),
	Type.Literal("reply"),
	Type.Literal("handover"),
	Type.Literal("message"),
]);
export type CommAction = Static<typeof CommAction>;

export const CommEvent = Type.Object({
	type: Type.Literal("comm"),
	commId: Id,
	direction: CommDirection,
	channel: CommChannel,
	action: CommAction,
	peer: CommPeer,
	messageId: Nullable(Type.String()),
	replyTo: Nullable(Type.String()),
	expectsReply: Type.Boolean(),
	text: Nullable(Type.String({ maxLength: 2000 })),
	truncated: Type.Boolean(),
	delivered: OptNullable(Type.Boolean()),
	at: Type.Number(),
});
export type CommEvent = Static<typeof CommEvent>;

export const MeshSubscribe = Type.Object({ machineId: Nullable(Id) });
export type MeshSubscribe = Static<typeof MeshSubscribe>;

export const MeshUnsubscribe = Type.Object({});
export type MeshUnsubscribe = Static<typeof MeshUnsubscribe>;

export const MeshGroupConfidence = Type.Union([Type.Literal("comms"), Type.Literal("cwd")]);
export type MeshGroupConfidence = Static<typeof MeshGroupConfidence>;

export const MeshGroup = Type.Object({
	groupId: Type.String(),
	label: Type.String(),
	orchestratorAgentId: Nullable(Id),
	machineIds: Type.Array(Id),
	memberAgentIds: Type.Array(Id),
	confidence: MeshGroupConfidence,
});
export type MeshGroup = Static<typeof MeshGroup>;

export const MeshNodeRole = Type.Union([
	Type.Literal("orchestrator"),
	Type.Literal("subordinate"),
	Type.Literal("solo"),
]);
export type MeshNodeRole = Static<typeof MeshNodeRole>;

export const MeshNodeTodos = Type.Object({
	total: Type.Integer({ minimum: 0 }),
	done: Type.Integer({ minimum: 0 }),
	inProgress: Type.Integer({ minimum: 0 }),
	blocked: Type.Integer({ minimum: 0 }),
	pending: Type.Integer({ minimum: 0 }),
	current: Nullable(Type.String()),
});
export type MeshNodeTodos = Static<typeof MeshNodeTodos>;

export const MeshSubagent = Type.Omit(SubagentUpdateEvent, ["type"]);
export type MeshSubagent = Static<typeof MeshSubagent>;

export const MeshNode = Type.Object({
	agentId: Id,
	machineId: Id,
	machineName: Type.String(),
	machineColor: Type.String(),
	name: Type.String(),
	cwd: Nullable(Type.String()),
	gitBranch: Nullable(Type.String()),
	model: Nullable(Type.String()),
	status: AgentStatus,
	activity: Nullable(Type.String()),
	online: Type.Boolean(),
	role: MeshNodeRole,
	parentAgentId: Nullable(Id),
	groupId: Nullable(Type.String()),
	todos: Nullable(MeshNodeTodos),
	subagents: Type.Array(MeshSubagent),
	lastCommAt: Nullable(Type.Number()),
	openPromptCount: Type.Integer({ minimum: 0 }),
});
export type MeshNode = Static<typeof MeshNode>;

export const MeshEdge = Type.Object({
	edgeId: Type.String(),
	a: Id,
	b: Id,
	count: Type.Integer({ minimum: 0 }),
	aToB: Type.Integer({ minimum: 0 }),
	bToA: Type.Integer({ minimum: 0 }),
	lastAt: Type.Number(),
	lastFrom: Id,
	lastAction: Type.String(),
	lastPreview: Nullable(Type.String({ maxLength: 140 })),
	pendingAsk: Type.Boolean(),
	active: Type.Boolean(),
});
export type MeshEdge = Static<typeof MeshEdge>;

export const MeshSnapshot = Type.Object({
	machineId: Nullable(Id),
	generatedAt: Type.Number(),
	groups: Type.Array(MeshGroup),
	nodes: Type.Array(MeshNode),
	edges: Type.Array(MeshEdge),
});
export type MeshSnapshot = Static<typeof MeshSnapshot>;

export const MeshUpdate = MeshSnapshot;
export type MeshUpdate = MeshSnapshot;

export const CommView = Type.Object({
	commKey: Type.String(),
	fromAgentId: Nullable(Id),
	toAgentId: Nullable(Id),
	fromName: Type.String(),
	toName: Type.String(),
	action: CommAction,
	text: Nullable(Type.String()),
	truncated: Type.Boolean(),
	at: Type.Number(),
	groupId: Nullable(Type.String()),
});
export type CommView = Static<typeof CommView>;

export const MeshComm = Type.Object({ comm: CommView });
export type MeshComm = Static<typeof MeshComm>;
