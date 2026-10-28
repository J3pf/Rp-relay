/** Versión actual del protocolo y la mínima que el relay acepta (PROTOCOLO §3.3: actual y anterior). */
export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

/** Códigos de cierre WebSocket (PROTOCOLO §1). */
export const CloseCode = {
	Normal: 1000,
	ServiceRestart: 1012,
	TryAgainLater: 1013,
	Unauthorized: 4001,
	IncompatibleVersion: 4002,
	Replaced: 4003,
	InvalidFrame: 4008,
} as const;

/** Códigos de error del sobre `error` (PROTOCOLO §2; `agent_timeout`, `host_offline` y `timeout` son adiciones compatibles). */
export const ErrorCode = {
	BadRequest: "bad_request",
	Unauthorized: "unauthorized",
	NotFound: "not_found",
	Conflict: "conflict",
	AgentOffline: "agent_offline",
	AgentTimeout: "agent_timeout",
	AgentCloseUnsupported: "agent_close_unsupported",
	HostOffline: "host_offline",
	Timeout: "timeout",
	TooLarge: "too_large",
	RateLimited: "rate_limited",
	Internal: "internal",
} as const;
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export const MAX_FRAME_BYTES = 1024 * 1024;
export const PING_INTERVAL_MS = 25_000;
export const PONG_TIMEOUT_MS = 10_000;

/** Eventos de Pi que el relay persiste (PROTOCOLO §4, tabla de eventos). */
export const PERSISTED_EVENT_TYPES = [
	"agent_start",
	"agent_settled",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"session_info_changed",
	"model_select",
	"thinking_level_select",
	"session_compact",
	"todo_update",
	"subagent_update",
	"comm",
] as const;
const persisted = new Set<string>(PERSISTED_EVENT_TYPES);
export const isPersistedEvent = (type: string): boolean => persisted.has(type);

/** Eventos que pueden descartarse bajo presión de buffer (se conservan los finales). */
export const DROPPABLE_EVENT_TYPES = ["message_delta", "tool_execution_update", "message_update"] as const;
const droppable = new Set<string>(DROPPABLE_EVENT_TYPES);
export const isDroppableEvent = (type: string): boolean => droppable.has(type);

export const AGENT_STATUSES = ["idle", "working", "waiting_input", "compacting", "error"] as const;
export const NOTIFY_CATEGORIES = ["permission", "question", "settled", "error", "terminal_wait"] as const;
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number];
