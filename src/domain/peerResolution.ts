export interface CandidateAgent {
	id: string;
	machine_id: string;
	session_id: string;
	session_name: string | null;
	cwd?: string | null;
}

export interface PeerQuery {
	sessionId?: string | null;
	name?: string | null;
	ref?: string | null;
	cwd?: string | null;
}

export interface ReferencedComm {
	agent_id: string;
	machine_id: string;
	direction: "out" | "in";
	peer_session_id: string | null;
	peer_name: string | null;
	peer_cwd: string | null;
	peer_ref: string | null;
	peer_agent_id: string | null;
}

export function resolvePeerAgentId(
	originAgentId: string,
	originMachineId: string,
	peer: PeerQuery,
	candidates: Iterable<CandidateAgent>,
): string | null {
	const available = [...candidates].filter((candidate) => candidate.id !== originAgentId);
	const choose = (matches: CandidateAgent[]): string | null | undefined => {
		if (matches.length === 0) return undefined;
		if (matches.length === 1) return matches[0]!.id;
		const sameMachine = matches.filter((candidate) => candidate.machine_id === originMachineId);
		return sameMachine.length === 1 ? sameMachine[0]!.id : null;
	};

	if (peer.sessionId != null) {
		const exact = choose(available.filter((candidate) => candidate.session_id === peer.sessionId));
		if (exact !== undefined) return exact;
	}

	const prefixes = [peer.ref, peer.sessionId].filter(
		(prefix): prefix is string => prefix != null && prefix.length >= 8,
	);
	if (prefixes.length > 0) {
		const prefixMatches = choose(
			available.filter((candidate) =>
				prefixes.some((prefix) => candidate.session_id.startsWith(prefix) || candidate.id.startsWith(prefix)),
			),
		);
		if (prefixMatches !== undefined) return prefixMatches;
	}

	const names = [peer.name, peer.ref].filter((name): name is string => name != null);
	if (names.length > 0) {
		const nameMatches = choose(
			available.filter((candidate) => candidate.session_name != null && names.includes(candidate.session_name)),
		);
		if (nameMatches !== undefined) return nameMatches;
	}

	return null;
}

export function resolvePeerAgentIdFromReply(
	originAgentId: string,
	referencedComm: ReferencedComm | undefined,
	candidates: Iterable<CandidateAgent>,
): string | null {
	if (!referencedComm) return null;
	const available = [...candidates];
	const validAgentId = (agentId: string | null): string | null =>
		agentId != null && agentId !== originAgentId && available.some((candidate) => candidate.id === agentId)
			? agentId
			: null;

	if (referencedComm.direction === "out") return validAgentId(referencedComm.agent_id);

	const knownSender = validAgentId(referencedComm.peer_agent_id);
	if (knownSender) return knownSender;
	const derivedSender = resolvePeerAgentId(
		referencedComm.agent_id,
		referencedComm.machine_id,
		{
			sessionId: referencedComm.peer_session_id,
			name: referencedComm.peer_name,
			cwd: referencedComm.peer_cwd,
			ref: referencedComm.peer_ref,
		},
		available,
	);
	return validAgentId(derivedSender);
}
