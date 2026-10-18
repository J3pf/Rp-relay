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

## Tasks

- T1 [done] (S1, S5): Create pure helper `agentDisplayName` with TDD (RED -> GREEN unit tests).
- T2 [done] (S2, S5): Implement deterministic duplicate disambiguation in snapshot nodes (RED -> GREEN).
- T3 [done] (S3, S5): Update group labels, comms fromName/toName, and summaries with agentDisplayName (assert no UUIDs).
- T4 [done] (S4): Verify wire contract compatibility and fixtures.
- T5 [done] (S6): English documentation: CHANGELOG.md, docs section, and GitHub release notes draft.
- T6 [done] (S7): Bump version to 0.5.3, update install.sh, lint, format, and full check gate.
- T7 [done]: Report [RELAY MESH NAMES — READY FOR REVIEW] via intercom.

## Log

- L1: (user, verbatim): "el usuario jamas va a entender esos ids, debemos darle una UX/UI cómoda"
- L2: [ORCHESTRATOR → Rp-relay] Feature: mesh-redesign (relay part). Use ODD: create odd/tasks/mesh-redesign.md (Specs quoting verbatim, Tasks, Log) + Engram mirror odd/mesh-redesign/tasks (project rp-relay) BEFORE the first source write. Test-first (observe RED, then GREEN).
- L3: Implemented agentDisplayName pure helper in src/domain/agentNames.ts and disambiguateAgentNames. Unit tests in test/agent-names.test.ts (13 tests) passed.
- L4: Integrated into buildMeshSnapshot, service comms, HTTP routes, and summaries. Topology and HTTP tests (test/topology.test.ts, test/mesh-http.test.ts) verified no UUIDs/auto-names in node names, group labels, fromName, toName.
- L5: Verified wire contract unchanged. All 317 tests in test suite pass.
- L6: Added documentation in English to docs/PROTOCOLO.md, CHANGELOG.md, and docs/RELEASE-NOTES-0.5.3.md.
- L7: Bumped version to 0.5.3 across package.json, packages/protocol/package.json, deploy/install.sh, docs/INSTALACION.md, README.md, and package-lock.json.
