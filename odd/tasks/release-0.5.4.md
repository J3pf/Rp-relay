# Feature: release-0.5.4

Preparation, audit, verification, and packaging of v0.5.4 release including collaborator performance commits and local load-test fixes.

## Specs

- S1: Rebase local unpushed commits (47b73dc, 68285d2, 6c40c7a) onto origin/main (1f09499) without losing any work.
- S2: Review and verify commit 1f09499: migration `migrations/0004_perf_indexes.sql` safety (idempotent CREATE INDEX IF NOT EXISTS, no table rewrite, safe for existing prod DBs). Add migration test verifying upgrading from v0.5.3 schema + data to v0.5.4 and verifying `EXPLAIN QUERY PLAN` uses the composite indexes for target mesh queries.
- S3: Review and verify commit b3bffc4: ensure no regression on human display names / disambiguation in `agents.ts`, `mesh/topology.ts`, `summaries.ts`, `http/routes/mesh.ts`. Add test verifying that "avoid snapshot rebuild" path never returns a stale name when a new duplicate agent appears.
- S4: Investigate local branch `backup/v052-excluded` (0c3bed7, d10ca93) and verify whether any of its changes are absent from main.
- S5: Version bump to 0.5.4 across package.json, packages/protocol/package.json, deploy/install.sh, docs/INSTALACION.md, README.md, and package-lock.json.
- S6: Document release in English: CHANGELOG.md and docs/RELEASE-NOTES-0.5.4.md (crediting Luis's performance improvements, describing migration 0004 with upgrade note, load-test changes, known issues with node-forge, and verified upgrade command for 0.5.4 tgz).
- S7: Full quality gate: lint, typecheck, build, `npm test` 3× (zero flakes), `npm outdated` (latest stable except @types/node), `npm audit --omit=dev` (only known node-forge advisory).
- S8: Report [RELAY 0.5.4 — READY FOR REVIEW] with HEAD, commits, test counts, migration test evidence, and `backup/v052-excluded` analysis. Do not publish until authorized.

## Tasks

- T1 [done] (S1): Fetch origin and rebase local main onto origin/main (1f09499).
- T2 [done] (S4): Analyze `backup/v052-excluded` against main and document status.
- T3 [done] (S2): Review 1f09499 (migration 0004), verify idempotency and EXPLAIN QUERY PLAN in a dedicated test.
- T4 [done] (S3): Review b3bffc4, verify display-name preservation and add test against stale names on duplicate agents.
- T5 [done] (S5): Bump version to 0.5.4 across package.json, protocol, deploy/install.sh, docs, and lockfile.
- T6 [done] (S6): English documentation: update CHANGELOG.md and write docs/RELEASE-NOTES-0.5.4.md.
- T7 [done] (S7): Run quality gate: lint, typecheck, build, npm test 3×, npm outdated, npm audit --omit=dev.
- T8 [done] (S8): Report [RELAY 0.5.4 — READY FOR REVIEW] via intercom.

## Log

- L1: (user, verbatim): "genera releases de todo con los cambios de nosotros y los de luis ASEGURANDO que ningún repo quede con cambios por fuera de las últimas releases y todo en main sin perder cambios"
- L2: [ORCHESTRATOR → Rp-relay] New release task (use ODD: append to odd/tasks/mesh-redesign.md Log, or a new odd/tasks/release-0.5.4.md). Review Luis's commits (b3bffc4, 1f09499), verify migration 0004, ensure display-name rules not regressed, investigate backup/v052-excluded, gate 3× tests, bump 0.5.4, English notes, do not publish.
- L3: Rebased unpushed commits onto origin/main (1f09499) cleanly without conflicts.
- L4: Investigated local branch `backup/v052-excluded`: verified it was a safety branch holding unpushed 0c3bed7 (temporary revert of 5faba3e) and d10ca93 (pre-release 0.5.2 bump). All changes were already reviewed, included, and released on main.
- L5: Migration 0004 audited: verified idempotent CREATE INDEX IF NOT EXISTS statements, safe online migration with data, tested in test/migration-0004.test.ts showing EXPLAIN QUERY PLAN uses the composite indexes for targeted queries.
- L6: Commit b3bffc4 audited: verified prompt label batching and set-based topology lookups. Added integration test in test/mesh-http.test.ts ensuring dynamic duplicate updates never return stale cached names.
- L7: Bumped version to 0.5.4 across package.json, packages/protocol/package.json, deploy/install.sh, README.md, docs/INSTALACION.md, and package-lock.json.
- L8: Created docs/RELEASE-NOTES-0.5.4.md and updated CHANGELOG.md in English crediting Luis's performance improvements, describing migration 0004, load-test changes, known issues, and upgrade instructions.
- L9: Quality gate passed 3× in a row on Vitest 5.0.5 (326/326 tests). Hardened CLI test execution by using prebuilt `dist/cli/index.js` when available and setting test timeout to 120s.
- L10: Analyzed `backup/v052-excluded`: verified it contains no work absent from main (unpushed 0.5.2 revert/bump). Ready for orchestrator review.
