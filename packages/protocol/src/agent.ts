import { type Static, Type } from "@sinclair/typebox";
import {
	AgentStatus,
	Answer,
	AnswerBody,
	Entry,
	Id,
	Nullable,
	OptNullable,
	PiEvent,
	PromptOpen,
	PromptResolved,
	UserMessageAck,
	UserMessageBody,
} from "./common.js";

// ---- Plugin → Relay (PROTOCOLO §4) ----

export const AgentHello = Type.Object({
	agentId: Id,
	kind: Type.Optional(Type.String()),
	instance: Id,
	epoch: Id,
	pi: Type.Object({ version: Type.String(), mode: Type.String() }),
	plugin: Type.Object({ version: Type.String(), features: Type.Array(Type.String()) }),
	session: Type.Object({ id: Id, file: OptNullable(Type.String()), name: OptNullable(Type.String()) }),
	host: Type.Object({
		hostname: Type.String(),
		user: Type.Optional(Type.String()),
		pid: Type.Optional(Type.Integer()),
		os: Type.Optional(Type.String()),
	}),
	launcher: OptNullable(Type.String()),
	herdr: OptNullable(
		Type.Object({
			paneId: OptNullable(Type.String()),
			tabId: OptNullable(Type.String()),
			workspaceId: OptNullable(Type.String()),
			session: OptNullable(Type.String()),
		}),
	),
	gentle: OptNullable(Type.Object({ version: OptNullable(Type.String()), mode: Type.Optional(Type.String()) })),
	transport: Type.Optional(Type.Union([Type.Literal("ws"), Type.Literal("longpoll")])),
	redacted: Type.Optional(Type.Boolean()),
	cwd: OptNullable(Type.String()),
	spawnId: OptNullable(Type.String()),
	git: OptNullable(Type.Object({ branch: OptNullable(Type.String()), dirty: Type.Optional(Type.Boolean()) })),
	model: OptNullable(Type.Object({ provider: Type.String(), id: Type.String() })),
	thinking: OptNullable(Type.String()),
	status: AgentStatus,
	openPrompts: Type.Optional(Type.Array(PromptOpen)),
});
export type AgentHello = Static<typeof AgentHello>;

export const AgentSnapshot = Type.Object({
	epoch: Id,
	seq: Type.Integer({ minimum: 0 }),
	entries: Type.Array(Entry),
	truncated: Type.Optional(Type.Boolean()),
});
export type AgentSnapshot = Static<typeof AgentSnapshot>;

export const AgentEvent = Type.Object({
	epoch: Id,
	seq: Type.Integer({ minimum: 1 }),
	e: PiEvent,
});
export type AgentEvent = Static<typeof AgentEvent>;

export const AgentStatusMsg = Type.Object({ status: AgentStatus, detail: OptNullable(Type.String()) });
export const AgentStatuses = Type.Object({ items: Type.Record(Type.String(), Nullable(Type.String())) });

// ---- Relay → Plugin (PROTOCOLO §5) ----

export const AgentWelcome = Type.Object({
	serverTime: Type.Number(),
	lastSeq: Nullable(Type.Integer({ minimum: 0 })),
	pendingAnswers: Type.Array(AnswerBody),
	relayId: Type.Optional(Type.String()),
});
export type AgentWelcome = Static<typeof AgentWelcome>;

export const PromptCancel = Type.Object({ promptId: Id });
export const PromptAck = Type.Object({ promptId: Id, accepted: Type.Boolean() });
export const Empty = Type.Object({});

export { Answer, AnswerBody, PromptOpen, PromptResolved, UserMessageAck, UserMessageBody };
