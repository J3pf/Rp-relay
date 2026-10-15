import { type Static, type TSchema, Type } from "@sinclair/typebox";

export const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
export const OptNullable = <T extends TSchema>(t: T) => Type.Optional(Type.Union([t, Type.Null()]));

export const Id = Type.String({ minLength: 1, maxLength: 256 });
export const Ts = Type.Number();

export const QuotaWindow = Type.Object({
	id: Type.String(),
	label: OptNullable(Type.String()),
	usedPercent: Type.Number(),
	remainingPercent: Type.Number(),
	resetsAt: OptNullable(Type.String()),
	resetsInSec: OptNullable(Type.Integer()),
	note: OptNullable(Type.String()),
});
export type QuotaWindow = Static<typeof QuotaWindow>;

export const MachineQuota = Type.Object({
	family: Type.String(),
	label: Type.String(),
	plan: OptNullable(Type.String()),
	ok: Type.Boolean(),
	notConfigured: Type.Optional(Type.Boolean()),
	error: OptNullable(Type.String()),
	primaryWindowId: OptNullable(Type.String()),
	windows: Type.Array(QuotaWindow),
	updatedAt: OptNullable(Type.String()),
});
export type MachineQuota = Static<typeof MachineQuota>;

export const Option = Type.Object({
	id: Type.String(),
	label: Type.String(),
	description: Type.Optional(Type.String()),
	preview: Type.Optional(Type.String()),
});
export type Option = Static<typeof Option>;

export const Question = Type.Object({
	question: Type.String(),
	header: Type.Optional(Type.String()),
	multiSelect: Type.Optional(Type.Boolean()),
	allowFreeText: Type.Optional(Type.Boolean()),
	options: Type.Array(Option),
});

/** Respuesta a un prompt (PROTOCOLO §5). */
export const Answer = Type.Union([
	Type.Object({ optionIds: Type.Array(Type.String()) }),
	Type.Object({ confirmed: Type.Boolean() }),
	Type.Object({ text: Type.String() }),
	Type.Object({ cancelled: Type.Boolean() }),
	Type.Object({
		answers: Type.Array(
			Type.Union([
				Type.Object({ questionIndex: Type.Integer({ minimum: 0 }), optionIds: Type.Array(Type.String()) }),
				Type.Object({ questionIndex: Type.Integer({ minimum: 0 }), text: Type.String() }),
			]),
			{ minItems: 1 },
		),
	}),
]);
export type Answer = Static<typeof Answer>;

export const AgentStatus = Type.Union([
	Type.Literal("idle"),
	Type.Literal("working"),
	Type.Literal("waiting_input"),
	Type.Literal("compacting"),
	Type.Literal("error"),
]);
export type AgentStatus = Static<typeof AgentStatus>;

export const Danger = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);
export const PromptKind = Type.Union([
	Type.Literal("confirm"),
	Type.Literal("select"),
	Type.Literal("input"),
	Type.Literal("questionnaire"),
]);
export const PromptCategory = Type.Union([
	Type.Literal("permission"),
	Type.Literal("question"),
	Type.Literal("dialog"),
]);

/** Cuerpo de `prompt.open` (PROTOCOLO §4). */
export const PromptOpen = Type.Object({
	promptId: Id,
	agentId: Type.Optional(Id),
	kind: PromptKind,
	category: PromptCategory,
	title: Type.String(),
	message: OptNullable(Type.String()),
	options: Type.Optional(Type.Array(Option)),
	allowFreeText: Type.Optional(Type.Boolean()),
	placeholder: OptNullable(Type.String()),
	questions: OptNullable(Type.Array(Question, { minItems: 1, maxItems: 4 })),
	source: Type.Optional(
		Type.Object({
			extension: Type.Optional(Type.String()),
			tool: Type.Optional(Type.String()),
			subagent: Type.Optional(Type.Boolean()),
		}),
	),
	tool: Type.Optional(Type.Object({ name: Type.String(), args: Type.Optional(Type.Unknown()) })),
	danger: Type.Optional(Danger),
	expiresAt: OptNullable(Type.Number()),
});
export type PromptOpen = Static<typeof PromptOpen>;

export const PromptState = Type.Union([
	Type.Literal("open"),
	Type.Literal("answered"),
	Type.Literal("resolved"),
	Type.Literal("cancelled"),
	Type.Literal("expired"),
]);
export type PromptState = Static<typeof PromptState>;

/** Prompt tal como lo ven las apps: `prompt.open` + estado y contexto de la PC. */
export const Prompt = Type.Intersect([
	PromptOpen,
	Type.Object({
		agentId: Id,
		state: PromptState,
		createdAt: Type.Number(),
		resolvedAt: OptNullable(Type.Number()),
		machineId: Id,
		machineName: Type.String(),
		machineContext: Type.String(),
		agentLabel: Type.String(),
	}),
]);
export type Prompt = Static<typeof Prompt>;

/** Entrada normalizada del historial de Pi (PROTOCOLO §4, `agent.snapshot`). */
export const Entry = Type.Object({
	eid: Type.String(),
	kind: Type.Union([
		Type.Literal("user"),
		Type.Literal("assistant"),
		Type.Literal("tool_result"),
		Type.Literal("bash"),
		Type.Literal("custom"),
		Type.Literal("compaction"),
		Type.Literal("branch_summary"),
		Type.Literal("model_change"),
	]),
	at: Type.Number(),
	msg: Type.Unknown(),
});
export type Entry = Static<typeof Entry>;

/** Evento de Pi reenviado: se exige `type`; el resto es transparente. */
export const PiEvent = Type.Object({ type: Type.String({ minLength: 1 }) }, { additionalProperties: true });
export type PiEvent = Static<typeof PiEvent>;

export const Attachment = Type.Object({
	blobId: Id,
	name: Type.String(),
	mime: Type.String(),
	size: Type.Number({ minimum: 0 }),
});
export type Attachment = Static<typeof Attachment>;

export const Delivery = Type.Union([Type.Literal("auto"), Type.Literal("steer"), Type.Literal("followUp")]);
export const Method = Type.Union([
	Type.Literal("auto"),
	Type.Literal("api"),
	Type.Literal("interactive"),
	Type.Literal("herdr"),
]);

export const UserMessageBody = Type.Object({
	clientMsgId: Id,
	deviceId: Type.Optional(Id),
	text: Type.String(),
	attachments: Type.Optional(Type.Array(Attachment)),
	delivery: Type.Optional(Delivery),
	method: Type.Optional(Method),
	asCommand: Type.Optional(Type.Boolean()),
});

export const UserMessageAck = Type.Object({
	clientMsgId: Id,
	disposition: Type.Union([
		Type.Literal("sent"),
		Type.Literal("queued_steer"),
		Type.Literal("queued_followup"),
		Type.Literal("typed"),
		Type.Literal("typed_after_dialog"),
		Type.Literal("command"),
		Type.Literal("duplicate"),
		Type.Literal("rejected"),
	]),
	method: Type.Optional(Type.Union([Type.Literal("api"), Type.Literal("interactive"), Type.Literal("herdr")])),
	error: OptNullable(
		Type.Union([
			Type.Literal("agent_blocked"),
			Type.Literal("herdr_unavailable"),
			Type.Literal("interactive_unavailable"),
		]),
	),
});
export type UserMessageAck = Static<typeof UserMessageAck>;

export const AnswerBody = Type.Object({ promptId: Id, answer: Answer, deviceId: Type.Optional(Id) });
export type AnswerBody = Static<typeof AnswerBody>;

export const PromptResolved = Type.Object({
	promptId: Id,
	by: Type.Union([Type.Literal("local"), Type.Literal("remote"), Type.Literal("timeout"), Type.Literal("cancelled")]),
	answer: OptNullable(Answer),
	byDeviceId: Type.Optional(Id),
});
export type PromptResolved = Static<typeof PromptResolved>;

export const NotifyCategoryMap = Type.Partial(
	Type.Object({
		permission: Type.Boolean(),
		question: Type.Boolean(),
		settled: Type.Boolean(),
		error: Type.Boolean(),
		terminal_wait: Type.Boolean(),
	}),
);
