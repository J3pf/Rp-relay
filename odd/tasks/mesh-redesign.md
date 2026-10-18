# Feature: mesh-redesign (relay part)

Human-friendly agent display names and group labels across Agent Mesh, Comms, and Summaries.

## Specs

- S1: One shared pure helper `agentDisplayName(agent)` used by topology node names, group labels, comm fromName/toName and summaries. Precedence: session_name if it is human (NOT a UUID/ULID/hex id, NOT equal to session_id/agent id, NOT an auto name like "subagent-chat-<hex>") → basename(cwd) → "Agent" fallback. Never return a raw id.
- S2: Disambiguate duplicates within one snapshot (same display name on the same machine → "Rp-app (2)"; same name on different machines stays distinct by machine in the app, so keep it unsuffixed). Deterministic order (stable by created/first-seen, not by map iteration).
- S3: Group label = display name of the orchestrator (or common cwd basename), never an id.
- S4: Wire contract unchanged (same fields/types); only values change. Update fixtures shared with Rp-app if their name values change and tell me the fixture SHA.
- S5: Tests: unit tests for the helper with real-looking inputs ("01a14fbb-44e3-765f-99e1-970655bf47bf", "subagent-chat-01a14fbb-44e3-765f", null name + cwd "/home/x/Workspace/RP/Rp-app", root cwd "/", empty), topology/service tests asserting no node name / group label / fromName / toName matches a UUID regex.
- S6: Docs in ENGLISH: CHANGELOG entry + docs section describing display-name rules; GitHub release notes in English.
- S7: Version 0.5.3. Latest stable deps only; if you touch deps, verify against the npm registry (no alpha/beta/rc). No deprecated APIs.
- S8 (C1): Every name emitted for a known agent across comms (`fromName`/`toName` in WS `mesh.comm` and HTTP `/v1/mesh/conversation`, `/v1/mesh/agents/:id/comms`) and prompt `agentLabel` must match the agent's disambiguated node name in the snapshot. Test: two agents with the same cwd on one machine exchanging a comm → fromName/toName equal their node names, both via WS mesh.comm and HTTP /v1/mesh/conversation.
- S9 (C2): Move group-label precedence into ONE pure `groupDisplayLabel(orchestrator, members)` in `src/domain/agentNames.ts` with explicit precedence (human orchestrator session_name → common cwd basename → orchestrator display name → "Mesh Group") and unit-test it, including the real case: orchestrator cwd /home/drift/Workspace/RP with members in RP/Rp-app, RP/Rp-plugin, RP/Rp-relay → "RP".
- S10 (C3): Ensure legitimate human names containing hex-like words (e.g. "cafe-api", "add-feed", "Rp-app", "dead-beef") are kept by the hex ID heuristic; unit-test them and adjust heuristic if needed.

## Tasks

- T1 [done] (S1, S5): Create pure helper `agentDisplayName` with TDD (RED -> GREEN unit tests).
- T2 [done] (S2, S5): Implement deterministic duplicate disambiguation in snapshot nodes (RED -> GREEN).
- T3 [done] (S3, S5): Update group labels, comms fromName/toName, and summaries with agentDisplayName (assert no UUIDs).
- T4 [done] (S4): Verify wire contract compatibility and fixtures.
- T5 [done] (S6): English documentation: CHANGELOG.md, docs section, and GitHub release notes draft.
- T6 [done] (S7): Bump version to 0.5.3, update install.sh, lint, format, and full check gate.
- T7 [done]: Report [RELAY MESH NAMES — READY FOR REVIEW] via intercom.
- T8 [done] (S10, C3): Unit test for human names with hex-like words ("cafe-api", "add-feed", "Rp-app", "dead-beef") and refined heuristic (RED -> GREEN).
- T9 [done] (S9, C2): Implement and unit test pure `groupDisplayLabel(orchestrator, members)` helper, used in `commsGroup` and `cwdGroups` (RED -> GREEN).
- T10 [done] (S8, C1): Ensure comm fromName/toName and prompt agentLabel use the disambiguated snapshot node name; test two agents with same cwd on one machine via WS mesh.comm and HTTP conversation (RED -> GREEN).
- T11 [done] (C4): Fix load-smoke test timing flakiness in `test/load/generator.ts` by measuring event generation throughput during active sending window.
- T12 [done] (C5): Upgrade dependencies to latest stable across coherent groups (fastify plugins, db, logging+firebase, toolchain) with tests passing.
- T13 [done]: Run final quality gate, commit corrections on local main, and report [RELAY MESH NAMES — READY FOR REVIEW] via intercom.

## Log

- L1: (user, verbatim): "el usuario jamas va a entender esos ids, debemos darle una UX/UI cómoda"
- L2: [ORCHESTRATOR → Rp-relay] Feature: mesh-redesign (relay part). Use ODD: create odd/tasks/mesh-redesign.md (Specs quoting verbatim, Tasks, Log) + Engram mirror odd/mesh-redesign/tasks (project rp-relay) BEFORE the first source write. Test-first (observe RED, then GREEN).
- L3: Implemented agentDisplayName pure helper in src/domain/agentNames.ts and disambiguateAgentNames. Unit tests in test/agent-names.test.ts (13 tests) passed.
- L4: Integrated into buildMeshSnapshot, service comms, HTTP routes, and summaries. Topology and HTTP tests (test/topology.test.ts, test/mesh-http.test.ts) verified no UUIDs/auto-names in node names, group labels, fromName, toName.
- L5: Verified wire contract unchanged. All 317 tests in test suite pass.
- L6: Added documentation in English to docs/PROTOCOLO.md, CHANGELOG.md, and docs/RELEASE-NOTES-0.5.3.md.
- L7: Bumped version to 0.5.3 across package.json, packages/protocol/package.json, deploy/install.sh, docs/INSTALACION.md, README.md, and package-lock.json.
- L8: [ORCHESTRATOR Review of 45da03c — NOT approved yet]. Corrections: C1 (consistency), C2 (groupDisplayLabel readability), C3 (hex-like names), C4 (flaky load test), C5 (outdated dependencies).
- L9: C3 fixed: hyphenated hex regex requires `/\d/`, allowing words like "dead-beef" and "add-feed" to pass as human names. Tested in `test/agent-names.test.ts`.
- L10: C2 implemented: pure `groupDisplayLabel(orchestrator, members)` helper in `src/domain/agentNames.ts` with explicit precedence (human orchestrator session_name → common cwd basename → orchestrator display name → "Mesh Group"). Tested in `test/agent-names.test.ts` including real monorepo case `RP` with members in `RP/Rp-app`, `RP/Rp-relay`.
- L11: C1 fixed: `src/domain/mesh/service.ts`, `src/http/routes/mesh.ts`, and `src/domain/summaries.ts` resolve `fromName`/`toName`/`agentLabel` from the snapshot's disambiguated node name. Verified via integration test `emits fromName/toName matching disambiguated node names for duplicate agents via WS mesh.comm and HTTP /v1/mesh/conversation`.
- L12: C4 fixed: `test/load/generator.ts` measures `sendDurationSec = (sendEnded - started) / 1000` before the drain delay.
- L13: C5 implemented: upgraded all dependencies to latest stable versions across 4 groups: Fastify plugins (@fastify/multipart 10.1.4, @fastify/rate-limit 11.2.1, @fastify/type-provider-typebox 6.3.0), DB (better-sqlite3 13.0.3, @types/better-sqlite3 9.6.0), Logging & Push (pino 10.4.0, firebase-admin 14.5.0), Toolchain (typescript 7.0.2, vitest 5.0.5). Configured `maxWorkers: 4` in `vitest.config.ts`. Retained `@types/node` on v22 matching `"engines": { "node": ">=22" }`. All 324 tests passing.
