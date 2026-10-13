import type { Logger } from "pino";
import type { Authenticator } from "./auth/middleware.js";
import type { PairingService } from "./auth/pairing.js";
import type { BlobStore } from "./blobs/store.js";
import type { Config } from "./config.js";
import type { Repos } from "./db/repos/index.js";
import type { AgentService } from "./domain/agents.js";
import type { EntityService } from "./domain/entities.js";
import type { HistoryService } from "./domain/history.js";
import type { HostService } from "./domain/hosts.js";
import type { MessageService } from "./domain/messages.js";
import type { PromptService } from "./domain/prompts.js";
import type { Publisher } from "./domain/publisher.js";
import type { Summaries } from "./domain/summaries.js";
import type { PushDispatcher } from "./push/dispatcher.js";
import type { Hub } from "./ws/hub.js";

/** Contenedor de dependencias; los servicios lo leen en tiempo de llamada, así pueden referenciarse entre sí. */
export interface Ctx {
	config: Config;
	log: Logger;
	repos: Repos;
	hub: Hub;
	auth: Authenticator;
	pairing: PairingService;
	summaries: Summaries;
	publisher: Publisher;
	agents: AgentService;
	prompts: PromptService;
	messages: MessageService;
	history: HistoryService;
	hosts: HostService;
	entities: EntityService;
	dispatcher: PushDispatcher;
	blobs: BlobStore;
}
