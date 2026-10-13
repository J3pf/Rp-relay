import type { DB } from "../index.js";
import { AgentsRepo } from "./agents.js";
import { BlobsRepo } from "./blobs.js";
import { DevicesRepo } from "./devices.js";
import { EventsRepo } from "./events.js";
import { MachinesRepo } from "./machines.js";
import { MetaRepo } from "./meta.js";
import { OutboxRepo } from "./outbox.js";
import { PairingRepo } from "./pairing.js";
import { PromptsRepo } from "./prompts.js";

export class Repos {
	readonly meta: MetaRepo;
	readonly devices: DevicesRepo;
	readonly machines: MachinesRepo;
	readonly pairing: PairingRepo;
	readonly agents: AgentsRepo;
	readonly events: EventsRepo;
	readonly prompts: PromptsRepo;
	readonly blobs: BlobsRepo;
	readonly outbox: OutboxRepo;
	constructor(readonly db: DB) {
		this.meta = new MetaRepo(db);
		this.devices = new DevicesRepo(db);
		this.machines = new MachinesRepo(db);
		this.pairing = new PairingRepo(db);
		this.agents = new AgentsRepo(db);
		this.events = new EventsRepo(db);
		this.prompts = new PromptsRepo(db);
		this.blobs = new BlobsRepo(db);
		this.outbox = new OutboxRepo(db);
	}
}
export type { AgentRow } from "./agents.js";
export type { BlobRow } from "./blobs.js";
export type { DeviceRow } from "./devices.js";
export type { MachineRow } from "./machines.js";
export type { PromptRow } from "./prompts.js";
