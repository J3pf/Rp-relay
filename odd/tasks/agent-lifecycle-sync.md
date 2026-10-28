# Feature: Agent lifecycle sync (herdr ⇄ app)

Bidirectional lifecycle between herdr panes and the RP app: closing a pane forgets the agent, forgetting it in the app closes the pane.
Archiving preserves history; purge is the only destructive path. Contract shared with Rp-plugin and Rp-app (see L5).

## Specs

### Cross-repo contract (frozen by the orchestrator, do not rename)

- S1: `agent.hello` (agent→relay) already carries the optional additive field `herdr: { paneId: string, tabId?: string|null, workspaceId?: string|null }`; the relay persists it on the agent row (existing `agents.herdr` column) and no rename is allowed. A pane binding exists only when `herdr.paneId` is a non-empty string.
- S2: `host.herdr_close` (relay→host): `{ machineId, paneId }` → reply `host.herdr_closed`: `{ paneId, ok: boolean, error?: string|null }`.
- S3: `agent.closed` (agent→relay, sent by the plugin right before it closes a bridged agent socket): `{ reason: "pane_closed" }`.
- S4: `agent.close` (app→relay WS): `{ agentId }`. The relay routes it to the owning host when a pane binding exists; error code `agent_close_unsupported` when the agent has no pane binding.
- S5: Archive semantics: `agent.forget` becomes a SOFT delete (archive) that preserves messages. A way to list archived agents (with a display summary) and `agent.purge` for permanent deletion are added, following the repo's existing WS/REST conventions.

### Behaviour

- S6 Archive migration: `archived_at` on `agents` (new migration following the `migrations/` convention), no data loss, backward compatible with existing rows (existing rows are active, `archived_at IS NULL`).
- S7 `agent.forget` keeps working for the app but archives; archived agents are excluded from list/mesh/push.
- S8 `agent.close`: reject when the agent is unknown or has no pane binding (`agent_close_unsupported`); otherwise dispatch `host.herdr_close` to the owner machine, honour host timeout, and on `ok:true` archive the agent and publish removal; on host failure surface a typed error and change nothing.
- S9 `agent.closed{reason:"pane_closed"}` from a bridged agent archives it and publishes removal. A plain socket loss (network/crash) never archives; it only marks the agent offline, exactly as today.
- S10 Archived listing + `agent.purge` (deletes messages/history for real), with tests proving purge is the only path that destroys history.
- S11 Quality: `npm run check` green (biome, typecheck, tests), no regressions in existing suites, docs/CHANGELOG updated in the repo's own language conventions (Spanish docs, English commit messages).

### Point 3 — zombie notification (investigate; fix only if the cause is server-side)

- S12 Report findings with `file:line` evidence: whether the relay re-pushes or fails to broadcast prompt resolution (resolved prompts must not be re-pushed, and other devices must learn about the resolution). If, and only if, the cause is server-side, add the fix as S13 in the same feature document with tests.

## Tasks

- T1 [done] (S6, S7): migration `0005_agent_archive.sql` (`archived_at` + partial index), repo archive/active/archived queries, `AgentsRepo.list()` returns active only, `purgeOffline` never touches archived rows, `AgentService.forget` archives instead of deleting, publisher/push/mesh/count exclusions. Route: gentle-ai-worker. Commit: 43df97d.
- T2 [done] (S1, S2, S3, S4, S8, S9): protocol schemas + registry (`agent.closed`, `agent.close`, `host.herdr_close`, `host.herdr_closed`, `agent_close_unsupported` error code), `HostService.request` for relay-initiated host RPC, `AgentService.onClosed`, app gateway `agent.close`, agent gateway `agent.closed`, fixtures. Route: gentle-ai-worker. Commit: ece5eca.
- T3 [done] (S10): archived listing (`agent.archived` WS + `GET /v1/agents/archived`), `agent.purge` (WS + `DELETE /v1/agents/:id`), archived display summary, tests proving purge is the only destructive path. Route: gentle-ai-worker. Commit: b321de3.
- T4 [done] (S11): docs — `docs/PROTOCOLO.md` (new messages, archive semantics, routes), `README.md`, `CHANGELOG.md` entry. Route: parent inline.
- T5 [done] (S11, S12): independent verification of T1–T3 by a subagent that did not write them (`npm run check`, S# coverage, purge-only-destroys-history), plus the zombie-notification investigation report. Route: gentle-ai-verify. Commit: 6550400 (verification fixes).

## Log

- L1: "que si uno elimina un agente de herdr el man también lo borre de la app"
- L2: "basicamente es que si por la app se elimna (olvida) un agente, este debe desparecer de herdr y en el sentido contrario tambien"
- L3 (user decision): "Matar con confirmacion" — forgetting a live agent in the app must close its Herdr pane, but only after an explicit confirmation dialog in the app.
- L4 (user decision): "Ocultar + archivar historial" — closed agents disappear from the app list, history is archived, not destroyed.
- L5 (orchestrator brief, verbatim contract): "1. `agent.hello` (agent→relay): optional additive field `herdr: { paneId: string, tabId?: string|null, workspaceId?: string|null }`. Relay persists pane binding on the agent row. 2. `host.herdr_close` (relay→host): `{ machineId, paneId }` → reply `host.herdr_closed`: `{ paneId, ok: boolean, error?: string|null }`. 3. `agent.closed` (agent→relay, frame sent by the plugin right before it closes a bridged agent socket): `{ reason: "pane_closed" }`. 4. `agent.close` (app→relay WS): `{ agentId }`. Relay routes it to the owning host when a pane binding exists; error code `agent_close_unsupported` when the agent has no pane binding. 5. Archive semantics: `agent.forget` becomes a SOFT delete (archive) that preserves messages. Add a way to list archived agents (with a display summary) and `agent.purge` for permanent deletion, following the repo's existing WS/REST conventions." Constraints from the same brief: "DO NOT: push tags, publish npm, deploy the production relay, bump versions, or merge to main."
- L6 (investigation, point 3 — zombie notification): server-side is clean on the two claims. (a) Resolved prompts are never re-pushed: `src/db/repos/prompts.ts:126-131` `repushDue` requires `state='open'`, `src/push/dispatcher.ts:298-303` `flushDirect` acks and skips pending `prompt` deliveries whose row is not `open`. (b) Resolution is broadcast to every app connection (foreground and direct): `src/domain/prompts.ts:157` `hub.broadcastApps(envelope("prompt.resolved", body))` with no mode filter, plus `src/domain/prompts.ts:159` → `dispatcher.promptCancelled` → `src/push/dispatcher.ts:107-112` (outbox drop + `cancel` fan-out). Two real server-side gaps exist, neither a re-push: the answering device is deliberately excluded from the `cancel` push (`src/domain/prompts.ts:159`, `src/push/dispatcher.ts:115`), and a queued answer while the agent is offline (`src/domain/prompts.ts:76-84`) broadcasts no state change at all. The visible zombie is app-side: `Rp-app/.../NotificationFactory.kt` posts a per-agent group summary (`postAgentSummary`, SUMMARY_TAG) that neither `cancelPrompt` nor the action handler cancels (`Rp-app/.../NotificationFactory.kt:405-409`, `Rp-app/.../PromptActionReceiver.kt:136-150`), so the summary survives after the prompt child is removed. Cause is not server-side → S13 not opened; reported to the orchestrator instead.
- L8 (work-unit slice boundary): T1 landed as its own slice — commit 43df97d, 417 authored changed lines (source + tests + the three legacy expectations it had to update). T2 checks out from 43df97d with a disjoint surface (packages/protocol, hosts/app/agent gateways) and lands as the next slice; T3 and T4 follow as separate slices, so no single commit exceeds the ~400 authored-line review slice.

- L7 (verification verdict, T5): `npm run check` green — lint clean, typecheck clean, 24 files / 268 tests passed. S6–S10 covered by dedicated tests (migration 0005, archive/purge/close/closed paths, purge-only-destroys-history). Two defects found and fixed: (1) `AgentsRepo.delete()` was not transactional against `deleteTx` construction order and left `blob_grants` untouched; (2) `agent.closed` (`pane_closed`) from an agent whose socket then dropped re-published an `agents.update` upsert instead of staying removed — guarded in `Publisher.agent` by the archived check.
