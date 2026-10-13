import { type Static, Type } from "@sinclair/typebox";
import { Danger, Id, Option, OptNullable, PromptCategory, PromptKind } from "./common.js";

export const PushKind = Type.Union([
	Type.Literal("prompt"),
	Type.Literal("cancel"),
	Type.Literal("settled"),
	Type.Literal("error"),
	Type.Literal("terminal_wait"),
	Type.Literal("test"),
]);

/** Cuerpo (descifrado) de `k=prompt` (PROTOCOLO §8.1). */
export const PushPromptBody = Type.Object({
	promptId: Id,
	agentId: Id,
	agentLabel: Type.String(),
	machineId: Id,
	machineName: Type.String(),
	machineContext: Type.String(),
	kind: PromptKind,
	category: PromptCategory,
	title: Type.String(),
	message: OptNullable(Type.String({ maxLength: 500 })),
	options: Type.Array(Type.Pick(Option, ["id", "label"])),
	allowFreeText: Type.Boolean(),
	danger: Type.Optional(Danger),
});
export type PushPromptBody = Static<typeof PushPromptBody>;

export const PushCancelBody = Type.Object({ promptId: Id });
export const PushSettledBody = Type.Object({
	agentId: Id,
	agentLabel: Type.String(),
	preview: OptNullable(Type.String()),
	machineId: Type.Optional(Id),
	machineName: Type.Optional(Type.String()),
	machineContext: Type.Optional(Type.String()),
});
export const PushErrorBody = Type.Object({
	agentId: Id,
	agentLabel: Type.String(),
	detail: OptNullable(Type.String()),
	machineId: Type.Optional(Id),
	machineName: Type.Optional(Type.String()),
	machineContext: Type.Optional(Type.String()),
});
export const PushTerminalWaitBody = Type.Object({
	agentId: Id,
	agentLabel: Type.String(),
	title: OptNullable(Type.String()),
	machineId: Type.Optional(Id),
	machineName: Type.Optional(Type.String()),
	machineContext: Type.Optional(Type.String()),
});
export const PushTestBody = Type.Object({ message: Type.String() });

/** Mensaje del canal directo: `push.notify` (PROTOCOLO §8). */
export const PushNotify = Type.Object({
	pushId: Id,
	k: PushKind,
	body: Type.Unknown(),
});

/** Datos FCM (todos los valores string). */
export const FcmData = Type.Object({
	v: Type.Literal("1"),
	k: PushKind,
	n: Type.String(),
	c: Type.String(),
});
export type FcmData = Static<typeof FcmData>;
