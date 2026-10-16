# Feature: Agent Mesh

Cross-repo real-time animated agent graph and communication mesh for Pi agents over intercom/orchestrator.
Canonical contract in Rp-relay: packages/protocol, docs/PROTOCOLO.md, and fixtures.

## Specs

- S1: Plugin→Relay agent.event `e.type:"comm"` (persisted): `{ "type":"comm", "commId":"<ULID>", "direction":"out"|"in", "channel":"intercom"|"orchestrator", "action":"send"|"ask"|"reply"|"handover"|"message", "peer":{ "sessionId":string|null, "name":string|null, "cwd":string|null, "ref":string|null }, "messageId":string|null, "replyTo":string|null, "expectsReply":boolean, "text":string|null, "truncated":boolean, "delivered":boolean|null, "at":epochMs }`. Out comms may arrive twice with the same commId (start, then end with delivered/messageId): UPSERT by (agentId, commId). hello.plugin.features gains "comm".
- S2: App→Relay `mesh.subscribe { machineId: string|null }` (null = all machines) → `mesh.snapshot`; `mesh.unsubscribe {}`.
- S3: Relay→App `mesh.snapshot` and `mesh.update` (same body, full snapshot, coalesced ≤2/s, only while subscribed): `{ "machineId":string|null, "generatedAt":epochMs, "groups":[ { "groupId":string, "label":string, "orchestratorAgentId":string|null, "machineIds":[string], "memberAgentIds":[string], "confidence":"comms"|"cwd" } ], "nodes":[ { "agentId","machineId","machineName","machineColor","name","cwd","gitBranch","model","status","activity":string|null,"online":bool, "role":"orchestrator"|"subordinate"|"solo", "parentAgentId":string|null, "groupId":string|null, "todos":{ "total":int,"done":int,"inProgress":int,"blocked":int,"pending":int,"current":string|null } | null, "subagents":[ SubagentUpdateEvent minus "type" ], "lastCommAt":epochMs|null, "openPromptCount":int } ], "edges":[ { "edgeId":string, "a":agentId, "b":agentId, "count":int, "aToB":int, "bToA":int, "lastAt":epochMs, "lastFrom":agentId, "lastAction":string, "lastPreview":string|null /*≤140*/, "pendingAsk":bool, "active":bool /*lastAt within 20s*/ } ] }`.
- S4: Relay→App `mesh.comm { comm: CommView }` live, for each new deduplicated message within the subscription scope. `CommView = { "commKey":string, "fromAgentId":string|null, "toAgentId":string|null, "fromName":string, "toName":string, "action":string, "text":string|null, "truncated":bool, "at":epochMs, "groupId":string|null }`.
- S5: HTTP (device auth): `GET /v1/mesh?machineId=` → snapshot body; `GET /v1/mesh/conversation?a=&b=&before=&limit=50` → `{ items:[CommView], nextBefore }`; `GET /v1/mesh/agents/:agentId/comms?limit=50` → `{ items:[CommView] }`.
- S6: Schemas: TypeBox schemas in packages/protocol for C1–C5, PROTOCOLO.md updated (agent.event table row "comm", §6 mesh messages, §7 routes), fixtures for: comm out (start+end), comm in, comm redacted, mesh.snapshot (orchestrator + 2 subordinates + subagents + todos + 1 solo), mesh.update, mesh.comm, conversation response. THIS FIRST: commit contract+fixtures early and message me (intercom to 01a14214-32a8) with the commit SHA and fixture paths, so plugin and app can sync.
- S7: Persistence: migration with a `comms` table (upsert by agent_id+comm_id), indexes for (machine, at) and message_id; retention pruning (7 days, max 20k rows) hooked into the existing maintenance/backup cadence.
- S8: Peer resolution → peerAgentId: exact Pi session id match; else peer.ref/sessionId prefix ≥8 chars that is unique; else unique session-name match; prefer same machine; ambiguous → null. Re-resolve unresolved rows when new agents connect.
- S9: Pure topology engine (no I/O, unit-tested) over agents + comms of the last 24h: dedupe out(A,messageId m) with in(B,messageId m) as ONE message; initiation weight = send/ask/handover/message (reply is NOT an initiation); orchestrator of a component = node with the most distinct initiated peers (tie → most initiations → oldest), and must have ≥1 initiation; parentAgentId = the peer that initiated most toward this node (supports multi-level hierarchies, no cycles); groups = connected components, groupId = orchestrator agentId (or a stable hash), label = orchestrator session name, else basename of the common cwd; no comms at all → fallback grouping of agents on the same machine whose cwd descends from another agent's cwd (confidence "cwd", parent = that ancestor); remaining agents role "solo". pendingAsk = ask without a matching reply. todos derived from the latest todo_update; subagents = latest state per taskId (running first, max 10).
- S10: WS mesh.* handling with per-subscriber scope, coalescing ≤2/s, cached per machine and invalidated by relevant events (comm, status, todo_update, subagent_update, agent online/offline); no work when nobody is subscribed. Redacted agents → text/lastPreview null.
- S11: HTTP routes C5 with existing auth and validation; paging is stable.
- S12: Tests: topology unit tests (detection, multi-level, dedupe, pendingAsk, cwd fallback, redaction, tie-breaks), integration with real ws clients (plugin sends comm → app receives mesh.comm + mesh.update), HTTP routes, migration; `npm run check` green; the load smoke test does not regress.
- S13: Docs: README/INSTALACION mention the feature; follow the existing doc language (Spanish).
- S14: Delivery: when everything is green → merge to main, bump minor (0.5.0), tag, PUSH main+tags, PUBLISH a GitHub release (gh release create) with notes, and publish @j3pf/rp-protocol if that is your normal flow.

## Tasks

- T1 [pending] (S1, S2, S3, S4, S5, S6): TypeBox schemas in packages/protocol, docs/PROTOCOLO.md update, contract fixtures, early commit, and intercom notification to 01a14214-32a8. Route: gentle-ai-worker. Commit: pending.
- T2 [pending] (S7): SQLite migration 0003_comms.sql, comms repo, upsert by (agent_id, comm_id), maintenance retention pruning (7 days, max 20k rows). Route: gentle-ai-worker. Commit: pending.
- T3 [pending] (S8): Peer resolution engine: exact session ID match, prefix >= 8 chars, session name match, machine affinity, re-resolution on connect. Route: gentle-ai-worker. Commit: pending.
- T4 [pending] (S9): Pure topology engine: deduplication, initiation scoring, orchestrator detection, parentAgentId tree derivation, connected components, cwd fallback, pendingAsk, todos derivation, subagent state extraction. Route: gentle-ai-worker. Commit: pending.
- T5 [pending] (S10): WS mesh.* subscription handling, coalescing <= 2/s, per-machine cache invalidation, live mesh.comm broadcast, redaction handling. Route: gentle-ai-worker. Commit: pending.
- T6 [pending] (S11): HTTP routes for GET /v1/mesh, GET /v1/mesh/conversation, GET /v1/mesh/agents/:agentId/comms with device auth and validation. Route: gentle-ai-worker. Commit: pending.
- T7 [pending] (S12): Full test suite integration (topology unit tests, WS client integration, HTTP routes, migration, load smoke test, npm run check). Route: gentle-ai-worker. Commit: pending.
- T8 [pending] (S13): Documentation update in README.md and docs/INSTALACION.md in Spanish. Route: gentle-ai-worker. Commit: pending.
- T9 [pending] (S14): Final verification with gentle-ai-verify, merge feat/agent-mesh to main, bump version 0.5.0, tag, push main+tags, publish GitHub release, and final intercom report. Route: parent / gentle-ai-verify. Commit: pending.

## Log

- L1: [AGENT MESH — Rp-relay] I'm the RP orchestrator (session 01a14214-32a8). New cross-repo feature: "Agent Mesh", a new app screen showing a real-time animated graph, per machine and per group, of which Pi agents talk to each other (intercom), what they say, what each one is doing, TODO progress, and the subagents each one launches. The orchestrator and its subordinates are detected automatically. YOU OWN THE CONTRACT: docs/PROTOCOLO.md + packages/protocol + fixtures are canonical, and Rp-plugin and Rp-app align to you.

MANDATORY PROCESS: use ODD. Create odd/tasks/agent-mesh.md (Specs quoting this message verbatim as L1, Tasks, Log). Make a feature branch feat/agent-mesh. Implement through YOUR subagents (gentle-ai-explore / gentle-ai-worker / gentle-ai-verify), RED→GREEN tests. No code written inline by the parent beyond trivial glue.

=== SHARED CONTRACT (v1, additive, backward compatible) ===
C1 Plugin→Relay agent.event `e.type:"comm"` (persisted):
{ "type":"comm", "commId":"<ULID>", "direction":"out"|"in", "channel":"intercom"|"orchestrator",
  "action":"send"|"ask"|"reply"|"handover"|"message",
  "peer":{ "sessionId":string|null, "name":string|null, "cwd":string|null, "ref":string|null },  // ref = raw `to` argument as typed
  "messageId":string|null, "replyTo":string|null, "expectsReply":boolean,
  "text":string|null, "truncated":boolean,   // text ≤2000 chars; null when the agent is redacted
  "delivered":boolean|null,                   // out only; null until known
  "at":epochMs }
 Out comms may arrive twice with the same commId (start, then end with delivered/messageId): UPSERT by (agentId, commId). hello.plugin.features gains "comm".
C2 App→Relay `mesh.subscribe { machineId: string|null }` (null = all machines) → `mesh.snapshot`; `mesh.unsubscribe {}`.
C3 Relay→App `mesh.snapshot` and `mesh.update` (same body, full snapshot, coalesced ≤2/s, only while subscribed):
{ "machineId":string|null, "generatedAt":epochMs,
  "groups":[ { "groupId":string, "label":string, "orchestratorAgentId":string|null, "machineIds":[string], "memberAgentIds":[string], "confidence":"comms"|"cwd" } ],
  "nodes":[ { "agentId","machineId","machineName","machineColor","name","cwd","gitBranch","model","status","activity":string|null,"online":bool,
              "role":"orchestrator"|"subordinate"|"solo", "parentAgentId":string|null, "groupId":string|null,
              "todos":{ "total":int,"done":int,"inProgress":int,"blocked":int,"pending":int,"current":string|null } | null,
              "subagents":[ SubagentUpdateEvent minus "type" ], "lastCommAt":epochMs|null, "openPromptCount":int } ],
  "edges":[ { "edgeId":string, "a":agentId, "b":agentId, "count":int, "aToB":int, "bToA":int, "lastAt":epochMs,
              "lastFrom":agentId, "lastAction":string, "lastPreview":string|null /*≤140*/, "pendingAsk":bool, "active":bool /*lastAt within 20s*/ } ] }
C4 Relay→App `mesh.comm { comm: CommView }` live, for each new deduplicated message within the subscription scope.
 CommView = { "commKey":string, "fromAgentId":string|null, "toAgentId":string|null, "fromName":string, "toName":string, "action":string, "text":string|null, "truncated":bool, "at":epochMs, "groupId":string|null }
C5 HTTP (device auth): GET /v1/mesh?machineId= → snapshot body; GET /v1/mesh/conversation?a=&b=&before=&limit=50 → { items:[CommView], nextBefore } ; GET /v1/mesh/agents/:agentId/comms?limit=50 → { items:[CommView] }.

=== YOUR SPECS (Rp-relay) ===
R1 Schemas: TypeBox schemas in packages/protocol for C1–C5, PROTOCOLO.md updated (agent.event table row "comm", §6 mesh messages, §7 routes), fixtures for: comm out (start+end), comm in, comm redacted, mesh.snapshot (orchestrator + 2 subordinates + subagents + todos + 1 solo), mesh.update, mesh.comm, conversation response. THIS FIRST: commit contract+fixtures early and message me (intercom to 01a14214-32a8) with the commit SHA and fixture paths, so plugin and app can sync.
R2 Persistence: migration with a `comms` table (upsert by agent_id+comm_id), indexes for (machine, at) and message_id; retention pruning (7 days, max 20k rows) hooked into the existing maintenance/backup cadence.
R3 Peer resolution → peerAgentId: exact Pi session id match; else peer.ref/sessionId prefix ≥8 chars that is unique; else unique session-name match; prefer same machine; ambiguous → null. Re-resolve unresolved rows when new agents connect.
R4 Pure topology engine (no I/O, unit-tested) over agents + comms of the last 24h: dedupe out(A,messageId m) with in(B,messageId m) as ONE message; initiation weight = send/ask/handover/message (reply is NOT an initiation); orchestrator of a component = node with the most distinct initiated peers (tie → most initiations → oldest), and must have ≥1 initiation; parentAgentId = the peer that initiated most toward this node (supports multi-level hierarchies, no cycles); groups = connected components, groupId = orchestrator agentId (or a stable hash), label = orchestrator session name, else basename of the common cwd; no comms at all → fallback grouping of agents on the same machine whose cwd descends from another agent's cwd (confidence "cwd", parent = that ancestor); remaining agents role "solo". pendingAsk = ask without a matching reply. todos derived from the latest todo_update; subagents = latest state per taskId (running first, max 10).
R5 WS mesh.* handling with per-subscriber scope, coalescing ≤2/s, cached per machine and invalidated by relevant events (comm, status, todo_update, subagent_update, agent online/offline); no work when nobody is subscribed. Redacted agents → text/lastPreview null.
R6 HTTP routes C5 with existing auth and validation; paging is stable.
R7 Tests: topology unit tests (detection, multi-level, dedupe, pendingAsk, cwd fallback, redaction, tie-breaks), integration with real ws clients (plugin sends comm → app receives mesh.comm + mesh.update), HTTP routes, migration; `npm run check` green; the load smoke test does not regress.
R8 Docs: README/INSTALACION mention the feature; follow the existing doc language (Spanish).
R9 Delivery: when everything is green → merge to main, bump minor (0.5.0), tag, PUSH main+tags, PUBLISH a GitHub release (gh release create) with notes, and publish @j3pf/rp-protocol if that is your normal flow.

EVIDENCE I REQUIRE in your final report (intercom to 01a14214-32a8): the odd/tasks doc path, the subagent task ids you used and their roles, a verdict per R#/S#, the tail of `npm run check`, commit SHAs on main, the release URL. I will verify everything myself and request corrections if anything is off.
