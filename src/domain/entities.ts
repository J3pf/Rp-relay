import { CloseCode } from "@j3pf/rp-protocol";
import type { Ctx } from "../context.js";
import type { MachinePatchRow } from "../db/repos/machines.js";

/** Operaciones sobre dispositivos y PCs compartidas por la API HTTP, la API de administración y el CLI. */
export class EntityService {
	constructor(private c: () => Ctx) {}

	revokeDevice(id: string): boolean {
		const { repos, hub } = this.c();
		const ok = repos.devices.revoke(id, Date.now());
		if (ok) hub.closeDevice(id, CloseCode.Unauthorized, "device revoked");
		return ok;
	}

	revokeMachine(id: string): boolean {
		const { repos, hub, prompts, publisher, hosts, mesh } = this.c();
		const agents = repos.agents.byMachine(id);
		for (const conn of hub.agentsOfMachine(id)) {
			if (conn.agentId) repos.agents.setSeq(conn.agentId, conn.lastSeq);
		}
		const ok = repos.machines.revoke(id, Date.now());
		if (!ok) return false;
		hub.closeMachine(id, CloseCode.Unauthorized, "machine revoked");
		hosts.onMachineRevoked(id);
		for (const a of agents) {
			prompts.cancelOpenOfAgent(a.id, ["open", "answered"]);
			repos.agents.setOffline(a.id, Date.now());
			publisher.agentRemoved(a.id);
		}
		mesh.invalidate();
		publisher.hostRemoved(id);
		publisher.machineRemoved(id);
		return true;
	}

	patchMachine(id: string, patch: MachinePatchRow): boolean {
		const { repos, publisher, mesh } = this.c();
		if (!repos.machines.patch(id, patch)) return false;
		mesh.invalidate();
		publisher.machine(id);
		for (const a of repos.agents.byMachine(id)) publisher.agent(a.id);
		return true;
	}
}
