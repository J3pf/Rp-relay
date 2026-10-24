import { type Static, Type } from "@sinclair/typebox";
import { Answer, Id, NotifyCategoryMap, Nullable, UserMessageBody } from "./common.js";
import { CommView } from "./mesh.js";

export const PairDeviceReq = Type.Object({
	code: Type.String({ minLength: 4, maxLength: 32 }),
	name: Type.String({ minLength: 1, maxLength: 80 }),
	fcmToken: Type.Optional(Nullable(Type.String())),
});
export const PairDeviceRes = Type.Object({
	deviceId: Id,
	deviceToken: Type.String(),
	pushKey: Type.String(),
	relayName: Type.String(),
	relayId: Type.Optional(Type.String()),
});
export const PairMachineReq = Type.Object({
	code: Type.String({ minLength: 4, maxLength: 32 }),
	hostname: Type.String({ minLength: 1, maxLength: 200 }),
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
	context: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
});
export const PairMachineRes = Type.Object({
	machineId: Id,
	machineToken: Type.String(),
	relayId: Type.Optional(Type.String()),
});
export const PairCodeRes = Type.Object({ code: Type.String(), expiresAt: Type.Number() });

export const PushChannelReq = Type.Object({
	fcmToken: Type.Optional(Nullable(Type.String())),
	direct: Type.Boolean(),
});
export const QuietHours = Type.Object({
	from: Type.String({ pattern: "^\\d{2}:\\d{2}$" }),
	to: Type.String({ pattern: "^\\d{2}:\\d{2}$" }),
	tz: Type.Optional(Type.String()),
});
export type QuietHours = Static<typeof QuietHours>;

export const MachinePatch = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
	context: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
	color: Type.Optional(Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" })),
	icon: Type.Optional(Nullable(Type.String({ maxLength: 40 }))),
	quietHours: Type.Optional(Nullable(QuietHours)),
});
export type MachinePatch = Static<typeof MachinePatch>;

export const MachinePrefs = Type.Object({
	mute: Type.Optional(Type.Boolean()),
	categories: Type.Optional(NotifyCategoryMap),
	quietHours: Type.Optional(Nullable(QuietHours)),
});
/** `criticalAlways`: las autorizaciones `danger=high` ignoran silencio y horas silenciosas (adición compatible). */
export const NotifyPrefs = Type.Object({
	categories: Type.Optional(NotifyCategoryMap),
	machines: Type.Optional(Type.Record(Type.String(), MachinePrefs)),
	criticalAlways: Type.Optional(Type.Boolean()),
});
export type NotifyPrefs = Static<typeof NotifyPrefs>;

export const PromptAnswerReq = Type.Object({ answer: Answer });
export const AgentMessageReq = Type.Omit(UserMessageBody, ["deviceId"]);
export const AgentSendReq = Type.Array(Type.Unknown(), { maxItems: 200 });
export const BlobRes = Type.Object({ blobId: Id, sha256: Type.String(), size: Type.Integer(), mime: Type.String() });
export const HealthRes = Type.Object({ ok: Type.Boolean(), version: Type.String(), uptime: Type.Number() });

export const MeshQuery = Type.Object({ machineId: Type.Optional(Nullable(Id)) });
export const MeshConversationQuery = Type.Object({
	a: Id,
	b: Id,
	before: Type.Optional(Type.Union([Type.Number(), Type.String()])),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const MeshConversationRes = Type.Object({ items: Type.Array(CommView), nextBefore: Nullable(Type.Number()) });
export const AgentCommsQuery = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) });
export const AgentCommsRes = Type.Object({ items: Type.Array(CommView) });

export type MeshQuery = Static<typeof MeshQuery>;
export type MeshConversationQuery = Static<typeof MeshConversationQuery>;
export type MeshConversationRes = Static<typeof MeshConversationRes>;
export type AgentCommsQuery = Static<typeof AgentCommsQuery>;
export type AgentCommsRes = Static<typeof AgentCommsRes>;
