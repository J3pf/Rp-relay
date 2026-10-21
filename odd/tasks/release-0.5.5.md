# Feature: release-0.5.5

Preparation, audit, verification, and packaging of v0.5.5 release so nothing on main stays outside a release.

## Specs

- S1: Critically review Luis's 3 commits (aacc9cf perMessageDeflate, 07f0f11, e161067 last_seen_at): perMessageDeflate memory/CPU risk (zlib concurrency limit, threshold, compression-bomb exposure — confirm maxPayload still enforced on decompressed size), that last_seen_at/lastActivityAt semantics don't regress presence/"Inactivo/Desconectado" in the app, touch throttling correct under concurrency, no extra DB writes per frame. Report findings with path:line; fix real defects test-first (RED→GREEN) in separate commits and tell me what you changed in his code.
- S2: Add missing tests for those behaviors (reconnect preserves last_seen_at, throttle only on real activity, deflate negotiated with the app's OkHttp client and frames <1KB uncompressed).
- S3: Protocol compatibility with Rp-plugin main (bedba6d: new herdr/agy/codex/claude host messages) and Rp-app main; list anything the app needs.
- S4: Quality gate: lint, typecheck, build, `npm test` 3× zero flakes, `npm outdated` (latest stable except @types/node policy as before; no alpha/beta/rc), `npm audit --omit=dev` (only the known node-forge advisory).
- S5: Bump 0.5.5 everywhere (package.json, packages/protocol, deploy/install.sh, docs, lockfile), English CHANGELOG + docs/RELEASE-NOTES-0.5.5.md crediting Luis.

## Tasks

- T1 [done] (S1): Critically review Luis's 3 commits (aacc9cf, 07f0f11, e161067) with path:line findings. Route: inline. Commit: e161067.
- T2 [done] (S1): Fix confirmed defects test-first (RED→GREEN) in separate commits (af68495 for deflate threshold, cb5a904 for touch throttling sync). Route: inline. Commits: af68495, cb5a904.
- T3 [done] (S2): Add missing tests for reconnect last_seen_at preservation, touch throttling on real activity, and perMessageDeflate negotiation/thresholds in test/deflate.test.ts and test/activity-throttling.test.ts. Route: inline. Commits: af68495, cb5a904, 0f1e8a1.
- T4 [done] (S3): Audit protocol compatibility with Rp-plugin main (bedba6d) and Rp-app main; verify launchers and snapshot schemas. Route: inline.
- T5 [done] (S4): Run full quality gate: lint, typecheck, build, npm test 3× zero flakes (335/335 passed), npm outdated, npm audit. Route: inline. Commit: 0f1e8a1.
- T6 [done] (S5): Bump version to 0.5.5 across all manifests, install script, docs, lockfile, update CHANGELOG and write docs/RELEASE-NOTES-0.5.5.md. Route: inline. Commit: 1d23359.
- T7 [done] (S1-S5): Final verification, ancestor check, and review report. Route: inline.

## Log

- L1: (user, verbatim): "si nada puede quedar fuera de la release"
- L2: [ORCHESTRATOR → Rp-relay] New task: release 0.5.5 so nothing on main stays outside a release. Use ODD: create odd/tasks/release-0.5.5.md (+ Engram mirror odd/release-0.5.5/tasks, project rp-relay) before the first write. L1 verbatim: "si nada puede quedar fuera de la release".
- L3: Reviewed commit aacc9cf (src/ws/index.ts:18). Found that perMessageDeflate: { threshold: 1024 } ignored the 1KB threshold because serverNoContextTakeover was false by default. All outgoing frames (even small 20B ACKs) were compressed. Confirmed maxPayload is strictly enforced on decompressed frames by ws InflateRaw listener.
- L4: Reviewed commits 07f0f11 and e161067 (src/domain/agents.ts, src/db/repos/agents.ts). Found that connect() set conn.lastTouchAt = now on reconnect even when last_seen_at was preserved from hours ago, causing activity in the first 15 seconds after reconnect to be throttled away and never update the DB. Same issue in onSnapshot when setting conn.lastTouchAt = Date.now(). Confirmed presence semantics in Rp-app and verified zero extra DB writes per frame during streaming.
- L5: Fixed deflate threshold defect test-first (RED→GREEN) in commit af68495 by setting serverNoContextTakeover: true and clientNoContextTakeover: true in src/ws/index.ts, and added test/deflate.test.ts.
- L6: Fixed touch throttling defect test-first (RED→GREEN) in commit cb5a904 by anchoring conn.lastTouchAt to row.last_seen_at in connect() and to clampedAt in onSnapshot(), and added test/activity-throttling.test.ts.
- L7: Audited protocol compatibility with Rp-plugin main (bedba6d) and Rp-app main. Launchers (claude, codex, agy, pi, gentle-shell) and AgentSnapshot lastActivityAt are fully compatible across the fleet.
- L8: Upgraded dev dependency @biomejs/biome to 2.6.2 in commit 0f1e8a1. Executed full quality gate: lint clean, typecheck clean, build clean, npm test 3× consecutive runs with 335/335 passing (0 flakes), npm outdated showing only @types/node per project policy, and npm audit --omit=dev showing only the known node-forge advisory.
- L9: Bumped version 0.5.5 across package.json, packages/protocol/package.json, package-lock.json, deploy/install.sh, README.md, docs/INSTALACION.md, CHANGELOG.md, and created docs/RELEASE-NOTES-0.5.5.md crediting Luis Chacón in commit 1d23359.
- L10: Fetched origin and verified origin/main is ancestor of HEAD (1d23359).
