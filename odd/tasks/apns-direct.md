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

## Log

- L1 (orchestrator, 2026-11-06): GO for relay slice; no push, no deploy to 192.168.18.138, no merge; tests use a FAKE sender ("no real .p8 exists, the user will supply it later"); ADR 0002 stays the contract.
- L2 (explorer mw58ir8c-9-mxzp, 2026-11-06): full map with file:line evidence recorded above in the map message (devices 0001_init.sql:5-9; setPush devices.ts:50-56; dispatcher fanOut 241-257, FCM send 259-275, clearFcm; re-push domain/prompts.ts:157-164; crypto.ts:12-19; PushChannelReq packages/protocol/src/http.ts:30-33; route devices.ts:23-32; tests FakeFcm helpers.ts:14-21 + push.test.ts/contract.test.ts/migration-000x.test.ts; docs lines PROTOCOLO.md:346/475-495).
