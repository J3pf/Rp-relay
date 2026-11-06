# Feature: APNs direct push (relay side of ADR 0002)

Branch `unify/apns-relay` in `~/Projects/J3pf/Rp-relay-wt/apns-relay` (worktree of main @ 775c770).
Contract: Rp-app `docs/adr/0002-apns-direct-push.md` (O2 owner; user decision logged as L6 in Rp-app
`odd/tasks/unified-kmp.md`, commit 83a9827). Apple is treated like Google: the relay ships only the
opaque `(k,n,c)` AES-256-GCM envelope; Apple never sees prompt text in clear.

## Specs (from ADR 0002 + relay AGENTS.md)

- S1 Platform-typed registration: `PUT /v1/devices/me/push` keeps `{fcmToken?, direct}` working 1:1; new optional fields `platform:"ios"`, `apnsToken`, `apnsEnvironment:"sandbox"|"production"`. Schema additive in `packages/protocol/src/http.ts`.
- S2 Additive reversible migration `migrations/0006_apns_push.sql`: devices columns `apns_token TEXT` + `apns_env TEXT` (check sandbox/production|null); existing data preserved (repo migration conventions, src/db/migrate.ts).
- S3 `ApnsSender` interface injectable exactly like `FcmSender` (src/push/apns.ts): HTTP/2 provider API behind a fake in tests until the user supplies the real `.p8` (key id, team id, bundle id/topic via env `RP_APNS_*`).
- S4 Payload: reuses `encryptPush` (src/push/crypto.ts, AAD "rp1") + `fitBody` trimming order; APNs container `aps`: `"mutable-content":1`, alert static generic template, plus envelope `{v,k,n,c}` verbatim; headers `apns-topic`, `apns-collapse-id=promptId`, `apns-push-type:alert`, priority 10 prompt/test / 5 other.
- S5 Environment routing per device: sandbox `api.development.push.apple.com`, production `api.push.apple.com` (chosen by `apns_env`).
- S6 Bad-token cleanup: APNs `410 Unregistered` or `400 reason BadDeviceToken` → clear token+env (parity with FCM_UNREGISTERED cleanup).
- S7 `PushResult` gains `apns:"sent"|"failed"|"off"`; `push-test` success includes the APNs channel.
- S8 Re-push 5/10-min parity: unchanged `promptOpened/promptRepush` path; the APNs send rides the same device fan-out.
- S9 Quality gate: `npm run check` (biome + tsc -b + vitest) green; no push/deploy; docs update (PROTOCOLO §8.2, ARQUITECTURA, CHANGELOG).
- S10 Spec-limit note: relay body cap stays 3000 B (fitBody, dispatcher.ts:34-46); NSE tolerates truncation documented in ADR 0002 §2.

## Tasks

- T1 (S1, S2): migration + DeviceRepo (`apns_token`/`apns_env`, setPush extended, clearApns) + PushChannelReq additive schema + devices.ts route/present() + fixture validation. Commit: tests `test/migration-0006.test.ts` (new), `test/contract.test.ts` additions.
- T2 (S3-S7, S9): `src/push/apns.ts` (interface + real sender factory behind env config) + FakeApns in test/helpers.ts + dispatcher injection + payload builder + environment routing + cleanup + push-test result + docs (PROTOCOLO/ARQUITECTURA/CHANGELOG). Tests in `test/push.test.ts` new suite.
- Verification: gentle-ai-verify with Risk item 3 (API/schema contract) + Risk item 2 (push payload crypto), after T2.

## Tasks (added after independent verify mw5b6hel-e-wbi0)

- T3 (S10 fix, O1): APNs payload budget FAILED the 4 KB Apple limit with the shared 3000 B cap (probe: 4177 B). Give the APNs path its own budget so the FINAL JSON payload is <= 4096 B (fitBody order preserved); keep the FCM cap unchanged; pin with a regression test built from a 9000-byte message asserting Buffer.byteLength(JSON.stringify(msg.payload)) <= 4096.
- T4 (S6/S7/O3): tests for the exact 410 `Unregistered` and 400 `BadDeviceToken` cleanup mappings (both columns null), a configured-but-failing push-test returning apns="failed" + ok:false, and registration symmetry: apnsToken + no apnsEnvironment clears apns_env (Apple tokens are per-environment; iOS always sends its environment), apnsToken:null clears both columns. Decide + tests first co-generic with setPush semantics (undefined=keep, null=clear).
- T5 (verify O2, both halves):
  Scope A - provider-token cache in src/push/apns.ts:
  - Cache the signed ES256 provider token in the real sender factory: reuse the SAME JWT for ~40 minutes (inside Apple's "not more than once per 20 min" refresh contract, before the 60-min expiry); regenerate lazily when older than 40 min or when invalidated by a 403 ExpiredProviderToken response (then ONE regeneration + ONE retry of the same send; a second failure surfaces as ApnsError; no infinite loop).
  - Injectable clock (default Date.now) driving the threshold.
  - The .p8 is read only at factory creation, never logged.

  Scope B - real-sender mapping pinned WITHOUT network:
  - Add a minimal HTTP/2-client seam to createApnsSender (options/client-factory parameter) so tests can inject a fake client returning raw status/reason pairs.
  - RED tests in NEW test/apns.test.ts: (1) first send signs a JWT and issues an HTTP/2 request with headers apns-topic/collapse-id/push-type/priority; (2) two sends <40 min apart reuse the SAME provider token (captured by the fake); (3) a send after simulated 50 min signs a NEW token; (4) 403 ExpiredProviderToken → exactly one retry within the same send, one new token signed, send succeeds; (5) 410 → Unregistered mapping; (6) 400 reason BadDeviceToken → BadDeviceToken; (7) other 5xx → generic reject.
- T6 (verify mw5ddg31-k-d4g4, final advisories):
  1. collapseId clamp (covers O4 + S4): every apns-collapse-id sent must be <= 64 bytes per Apple's header limit. Truncate deterministically when over (e.g. hash or prefix slice; documented choice) — production change in dispatcher/apns payload builder + RED regression test from the verify: settled/error/terminal_wait flows assert Buffer.byteLength(headers.collapseId) <= 64 (test passes today only coincidence? verify says today unsigned may fail if agent ids exceed 64 chars — write the test with a synthetic >64-byte agent id to force RED, e.g. an agent whose id is a 70-character string).
  2. Long-field budget hole (covers S10 + carried-over advisory): fitBody only trims message/options/title; an error push with a 6000-char `detail` produced an 8252 B APNs payload (>4096 → Apple 413 PracticalityPayloadTooLarge). Fix WITHOUT changing channel budgets: fitBody (or its callers) must bound UNSPECIFIED fields too — add a deterministic guard: after the existing trims, if the body still exceeds the per-channel maxBytes, drop/serialize-clip non-essential fields in a fixed order (document in the function doc: e.g. clip long string fields down to fit, last resort drop optional fields like detail), preserving the existing trim order and FCM/apns budgets. RED regression test from the verify: `error con detail largo cabe en 4096 B` (6000-char detail) - fails today, must pass; plus same guard for FCM path (detail push at 6000 chars stays <= 4KB envelope after encryption? assert body JSON <= 3000 B to preserve FCM budget) - shows both channels respect their budgets.
  3. Update PROTOCOLO.md §8.2 + CHANGELOG (trim rules + collapse clamp; repo language conventions).
  Then `npm test` full (expect ≥ 423+2 tests), `npm run lint`, `npm run typecheck`. Report RED evidence, commands+counts, per-file diff summary, S#/investment covered. No commit.

## Log

- L1 (orchestrator, 2026-11-06): GO for relay slice; no push, no deploy to 192.168.18.138, no merge; tests use a FAKE sender ("no real .p8 exists, the user will supply it later"); ADR 0002 stays the contract.
- L2 (explorer mw58ir8c-9-mxzp, 2026-11-06): full map with file:line evidence recorded above in the map message (devices 0001_init.sql:5-9; setPush devices.ts:50-56; dispatcher fanOut 241-257, FCM send 259-275, clearFcm; re-push domain/prompts.ts:157-164; crypto.ts:12-19; PushChannelReq packages/protocol/src/http.ts:30-33; route devices.ts:23-32; tests FakeFcm helpers.ts:14-21 + push.test.ts/contract.test.ts/migration-000x.test.ts; docs lines PROTOCOLO.md:346/475-495).

- L3 (verify mw5b6hel-e-wbi0, 2026-11-06): overall PASS; O1 HIGH (APNs payload 4177 B > 4096 B limit with the shared 3000 B body cap), O2 medium (real-sender mapping untested; provider JWT refreshed every send - TooManyProviderTokenUpdates risk), O3 low (stale env when re-registering without apnsEnvironment; schema accepts platform:"android" while docs say "ios"), O4 low (collapseId for non-prompt kinds = agentId, untested; 64 B Apple limit not measured). Suggested regression tests recorded above as T3/T4 scope.
- L4 (parent-approved continuation): T5 (verify O2, both halves):
  Scope A - provider-token cache in src/push/apns.ts:
  - Cache the signed ES256 provider token in the real sender factory: reuse the SAME JWT for ~40 minutes (inside Apple's "not more than once per 20 min" refresh contract, before the 60-min expiry); regenerate lazily when older than 40 min or when invalidated by a 403 ExpiredProviderToken response (then ONE regeneration + ONE retry of the same send; a second failure surfaces as ApnsError; no infinite loop).
  - Injectable clock (default Date.now) driving the threshold.
  - The .p8 is read only at factory creation, never logged.

  Scope B - real-sender mapping pinned WITHOUT network:
  - Add a minimal HTTP/2-client seam to createApnsSender (options/client-factory parameter) so tests can inject a fake client returning raw status/reason pairs.
  - RED tests in NEW test/apns.test.ts: (1) first send signs a JWT and issues an HTTP/2 request with headers apns-topic/collapse-id/push-type/priority; (2) two sends <40 min apart reuse the SAME provider token (captured by the fake); (3) a send after simulated 50 min signs a NEW token; (4) 403 ExpiredProviderToken → exactly one retry within the same send, one new token signed, send succeeds; (5) 410 → Unregistered mapping; (6) 400 reason BadDeviceToken → BadDeviceToken; (7) other 5xx → generic reject.
- L5 (verify mw5ddg31-k-d4g4, final advisories; parent-approved continuation): “T6 items:
1. collapseId clamp (covers O4 + S4): every apns-collapse-id sent must be <= 64 bytes per Apple's header limit. Truncate deterministically when over (e.g. hash or prefix slice; documented choice) — production change in dispatcher/apns payload builder + RED regression test from the verify: settled/error/terminal_wait flows assert Buffer.byteLength(headers.collapseId) <= 64 (test passes today only coincidence? verify says today unsigned may fail if agent ids exceed 64 chars — write the test with a synthetic >64-byte agent id to force RED, e.g. an agent whose id is a 70-character string).
2. Long-field budget hole (covers S10 + carried-over advisory): fitBody only trims message/options/title; an error push with a 6000-char `detail` produced an 8252 B APNs payload (>4096 → Apple 413 PracticalityPayloadTooLarge). Fix WITHOUT changing channel budgets: fitBody (or its callers) must bound UNSPECIFIED fields too — add a deterministic guard: after the existing trims, if the body still exceeds the per-channel maxBytes, drop/serialize-clip non-essential fields in a fixed order (document in the function doc: e.g. clip long string fields down to fit, last resort drop optional fields like detail), preserving the existing trim order and FCM/apns budgets. RED regression test from the verify: `error con detail largo cabe en 4096 B` (6000-char detail) - fails today, must pass; plus same guard for FCM path (detail push at 6000 chars stays <= 4KB envelope after encryption? assert body JSON <= 3000 B to preserve FCM budget) - shows both channels respect their budgets.
3. Update PROTOCOLO.md §8.2 + CHANGELOG (trim rules + collapse clamp; repo language conventions).
Then `npm test` full (expect ≥ 423+2 tests), `npm run lint`, `npm run typecheck`. Report RED evidence, commands+counts, per-file diff summary, S#/investment covered. No commit.”
