import { type TSchema, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
	AgentEvent,
	AgentHello,
	AgentSnapshot,
	AgentStatuses,
	AgentStatusMsg,
	AgentWelcome,
	Empty,
	PromptAck,
	PromptCancel,
} from "./agent.js";
import {
	AgentHistory,
	AgentRef,
	AgentSubscribe,
	AgentsUpdate,
	AppAgentEvent,
	AppHello,
	AppPromptAnswer,
	AppUserMessage,
	AppWelcome,
	MachinesUpdate,
	PromptAnswerResult,
	PushAck,
	TerminalWait,
} from "./app.js";
import { AnswerBody, Prompt, PromptOpen, PromptResolved, UserMessageAck, UserMessageBody } from "./common.js";
import type { Envelope } from "./envelope.js";
import { ErrorBody } from "./envelope.js";
import {
	HostDirs,
	HostHello,
	HostHerdrLayout,
	HostHerdrLayoutResult,
	HostKill,
	HostListDirs,
	HostSpawn,
	HostSpawned,
	HostsUpdate,
} from "./host.js";
import { PushNotify } from "./push.js";

/**
 * Canales (dirección) del protocolo. Los fixtures se nombran `<canal>__<t>__<etiqueta>.(valid|invalid).json`.
 *  - `up`       plugin → relay (`/ws/agent`)
 *  - `down`     relay → plugin
 *  - `appUp`    app → relay (`/ws/app`)
 *  - `appDown`  relay → app
 *  - `hostUp`   rp-host → relay (`/ws/host`)
 *  - `hostDown` relay → rp-host
 */
export type Channel = "up" | "down" | "appUp" | "appDown" | "hostUp" | "hostDown";
export const CHANNELS: readonly Channel[] = ["up", "down", "appUp", "appDown", "hostUp", "hostDown"];

const Ack = Type.Optional(Type.Object({}));

export const SCHEMAS: Record<Channel, Record<string, TSchema>> = {
	up: {
		"agent.hello": AgentHello,
		"agent.snapshot": AgentSnapshot,
		"agent.event": AgentEvent,
		"agent.status": AgentStatusMsg,
		"agent.statuses": AgentStatuses,
		"prompt.open": PromptOpen,
		"prompt.resolved": PromptResolved,
		"prompt.ack": PromptAck,
		"user.message.ack": UserMessageAck,
	},
	down: {
		"agent.welcome": AgentWelcome,
		"agent.resync": Empty,
		"user.message": UserMessageBody,
		"agent.abort": Empty,
		"prompt.answer": AnswerBody,
		"prompt.cancel": PromptCancel,
		error: ErrorBody,
	},
	appUp: {
		"app.hello": AppHello,
		"agent.subscribe": AgentSubscribe,
		"agent.unsubscribe": AgentRef,
		"user.message": AppUserMessage,
		"agent.abort": AgentRef,
		"prompt.answer": AppPromptAnswer,
		"agent.forget": AgentRef,
		"push.ack": PushAck,
		"host.list_dirs": HostListDirs,
		"host.herdr_layout": HostHerdrLayout,
		"host.spawn": HostSpawn,
		"host.kill": HostKill,
	},
	appDown: {
		"app.welcome": AppWelcome,
		"agent.history": AgentHistory,
		"machines.update": MachinesUpdate,
		"agents.update": AgentsUpdate,
		"agent.event": AppAgentEvent,
		"prompt.opened": Prompt,
		"prompt.resolved": PromptResolved,
		terminal_wait: TerminalWait,
		"user.message.ack": UserMessageAck,
		"prompt.answer.result": PromptAnswerResult,
		ack: Ack,
		error: ErrorBody,
		"push.notify": PushNotify,
		"hosts.update": HostsUpdate,
		"host.dirs": HostDirs,
		"host.herdr_layout.result": HostHerdrLayoutResult,
		"host.spawned": HostSpawned,
	},
	hostUp: {
		"host.hello": HostHello,
		"host.dirs": HostDirs,
		"host.herdr_layout.result": HostHerdrLayoutResult,
		"host.spawned": HostSpawned,
		ack: Ack,
		error: ErrorBody,
	},
	hostDown: {
		"host.list_dirs": HostListDirs,
		"host.herdr_layout": HostHerdrLayout,
		"host.spawn": HostSpawn,
		"host.kill": HostKill,
		error: ErrorBody,
	},
};

type Checker = ReturnType<typeof TypeCompiler.Compile>;
const compiled = new Map<string, Checker>();
function checker(channel: Channel, t: string): Checker | undefined {
	const key = `${channel}\u0000${t}`;
	let c = compiled.get(key);
	if (!c) {
		const schema = SCHEMAS[channel][t];
		if (!schema) return undefined;
		c = TypeCompiler.Compile(schema);
		compiled.set(key, c);
	}
	return c;
}

export type ValidationResult = { ok: true } | { ok: false; unknown: boolean; message: string };

/** Valida el cuerpo `d` de un sobre contra el esquema de su tipo `t` en el canal dado. */
export function validateMessage(channel: Channel, env: Envelope): ValidationResult {
	const c = checker(channel, env.t);
	if (!c) return { ok: false, unknown: true, message: `tipo desconocido: ${env.t}` };
	const body = env.d === undefined ? {} : env.d;
	if (c.Check(body)) return { ok: true };
	const first = [...c.Errors(body)][0];
	return { ok: false, unknown: false, message: first ? `${first.path || "/"}: ${first.message}` : "cuerpo inválido" };
}

/** Compila y valida un valor suelto contra un esquema (rutas HTTP, tests). */
export function validateSchema(schema: TSchema, value: unknown): ValidationResult {
	const c = TypeCompiler.Compile(schema);
	if (c.Check(value)) return { ok: true };
	const first = [...c.Errors(value)][0];
	return { ok: false, unknown: false, message: first ? `${first.path || "/"}: ${first.message}` : "valor inválido" };
}

export function knownTypes(channel: Channel): string[] {
	return Object.keys(SCHEMAS[channel]);
}
