# Feature: 4R Hardening — `Rp-relay` (`v0.8.2`)
Branch: `fix/4r-hardening` | Delivery: `ask-on-risk` | Forecast: ~1,100 authored changed lines | Runner: `cd Rp-relay && npm run check`
Mirror: pending (workspace root is ambiguous across sibling repos in Engram)

## Specs

### S1 — Transport, WebSocket upgrade & rate-limit security/resilience (`B-01`, `W-01`, `W-06`, `W-09`, `S-01`, `R2-06`, `R2-13`)
- Guard `onUpgrade` against malformed `req.url` (`new URL()` inside `try/catch` returning `400 Bad Request` + `socket.destroy()`, with `socket.on("error", () => {})` attached first).
- Allow `config.trustProxy` / `RP_TRUST_PROXY` to accept `boolean | number | string` (default `"1"` in `deploy/docker-compose.yml`), resolve rightmost untrusted hop in WS upgrades instead of spoofable leftmost XFF, evict oldest entries instead of `failedUpgrades.clear()`, and unify duplicated WS upgrade auth checks.
- Reuse `bearer()` + `tokenKind()` from `src/auth/tokens.ts` inside `http/server.ts` `rateLimit.keyGenerator` (case-insensitive Bearer parsing).
- Enforce immediate/bounded socket termination on `hardBufferedBytes` slow-consumer breach in `WsConn.send()`.
- Attach `POST /v1/agent/poll` disconnect abort listener to `reply.raw` (`!reply.raw.writableEnded`), `.unref()` poll timer, use `CloseCode.Replaced`, and type `Conn.closed: boolean` cleanly.
- Add configurable per-device and global WS connection caps (`maxWsPerDevice`, `maxWsTotal`) in `ConfigSchema.limits`.
- Add `blobTotalMaxBytes` (default `1_073_741_824` = 1 GiB) to `ConfigSchema.limits` for `S3`.

### S2 — Runtime periodic safety, APNs HTTP/2 stream/session resilience, shutdown & observability (`C-01`, `C-02`, `W-05`, `W-08`, `S-02`, `S-03`)
- Use `Promise.resolve().then(fn)` in `Relay.every()` so synchronous throws cannot crash the process; wrap `LongPollRegistry.sweep()` in `try/catch`.
- In `src/push/apns.ts`, settle premature `req.once("close")` with `ApnsError("apns/stream-closed", ...)`, clear timeout inside `cleanup()`, evict + `destroy()` sessions on timeout/error/idle, and retry retryable 5xx/429/timeout once with jitter.
- Isolate each step in `Relay.stop()` with `try/catch`, clean up partial `Relay.start()` failures, run `backupNow()` before `pruneBackups()` in `Relay.backup()`, and `chmodSync` `-wal`/`-shm` sidecars to `0o600` when present.
- Probe SQLite `SELECT 1` in `GET /healthz` (returning `503` on failure), respect `RP_LISTEN_PORT` & `chmod 700 /var/lib/rp-relay` in `Dockerfile`, log internal async errors in `appGateway.ts`, and include `status` + `err.message` in FCM/APNs warning logs.

### S3 — Backup/restore WAL integrity, atomic ACME TLS, SQLite `busy_timeout`, BlobStore total quota & doctor hardening (`C-03`, `C-04`, `W-02`, `W-07`, `S-02`, `R2-10`)
- In `restoreBackup()`, copy + `chmod 0o600` + `verifyDb` into `.tmp` before moving live DB; move `-wal`/`-shm` alongside `previous` and restore them on rollback; in `backupNow()`, write via `.tmp` + atomic `renameSync`; keep >= 1 backup in `pruneBackups()`.
- In `src/tls/index.ts`, write ACME `fullchain.pem` & `domain.key` via `.tmp`, validate pair via `tls.createSecureContext({ key, cert })`, atomically rename, validate correspondence on startup load, and call `closeIdleConnections()`/`closeAllConnections()` in `AcmeChallengeServer.close()`.
- In `src/db/index.ts`, pass `timeout: 5000` to `new Database(...)` and set `busy_timeout = 5000` before `journal_mode = WAL`.
- In `src/blobs/store.ts` & `src/blobs/routes.ts`, enforce cumulative `blobTotalMaxBytes` quota (`SUM(size)` + in-flight bytes, running `gc()` before rejecting with `RelayError("too_large", ...)`) and per-route rate limit on `POST /v1/blobs`.
- In `src/cli/doctor.ts`, fix loopback host detection (`127.0.0.1`/`::1`/`localhost`) and check `dataDir`, `relay.db*`, and `tls.key` permissions.

### S4 — Domain, redaction, history & mesh correctness (`C-05`, `C-06`, `C-07`, `W-03`, `W-04`, `W-10`, `W-11`, `W-12`, `W-13`, `W-14`)
- Call `messages.forget(id)` and `hub.clearAgentSubscribers(id)` in `EntityService.revokeMachine()` and `runRetention()`; cap `MessageService.done` outer map size.
- Fix redaction leaks: persist `text: null` when sender or receiver is redacted, scrub `comms` rows referencing deleted redacted agent (`WHERE peer_agent_id=?`), redact when `sender?.redacted || receiver?.redacted`, mask `terminal_wait` title when redacted (and broadcast `{ mode: "foreground" }`), mask `todos.current` & strip `subagents` sensitive fields (`label`, `error`, `result`) when redacted.
- Fix `HistoryService.build()` silent tail gap: fetch most recent `limit + 1` events (`ORDER BY seq DESC LIMIT ?` then reverse) and set `truncated = true` on overflow.
- Fix `MeshService`: call `mesh.invalidate()` before `mesh.onComm(storedComm)`, validate `machineId` before caching, cap `MeshService.cache` size, add SQLite index migration `migrations/0007_mesh_events_idx.sql`, store `{ a, b }` explicitly on `InternalEdge` keyed with `"\u0000"`, bound `resolveUnresolvedComms()` by recency + limit scoped to newly connected/renamed agent.
- Fix `MachinesRepo.patch(id, {})` returning `200` on revoked machines, remove redundant `decodeURIComponent()` on Fastify params (`routes/agents.ts:37`, `routes/mesh.ts:89`), and guarantee monotonic `archived_at` in `AgentsRepo.archive()`.

### S5 — Protocol/TypeBox alignment, package lockstep, CI permissions & test reliability (`C-08`, `C-09`, `W-15`, `W-16`, `W-17`, `S-04`)
- Align `"@j3pf/rp-protocol": "0.8.2"` in `package.json` & `package-lock.json` and enforce dependency lockstep in `.github/workflows/release.yml` & `test/release-workflow.test.ts`.
- Export `TypeBoxFastifyInstance` in `src/http/server.ts` and remove unsafe `as never` route casts; align `packages/protocol/src/{http,push,app}.ts` (`apnsToken` pattern, optional `pushId`/`redacted`/`relayTime`, remove double `Type.Optional`); deduplicate `settled`/`agentError`/`terminalWait` in `dispatcher.ts`; convert positional `?` bindings in `AgentsRepo.upsertFromHello` & `CommsRepo.upsert` to named `@param` bindings; remove dead code (`config.ts:117-119`, redundant `messages.forget`).
- Scope top-level `permissions: { contents: read }` in `.github/workflows/ci.yml` and `.github/workflows/release.yml` with minimal per-job write permissions.
- Fix `test/push.test.ts` 23:59 UTC quiet-hours flake, fix tautological assertion in `test/cli.test.ts:267`, and clean up `/tmp` fixtures in `test/resilience.test.ts:297-314`.

## Tasks

- [x] **T1** (`S1`) — Transport, WS upgrade DoS, proxy/rate-limit, slow-consumer eviction & long-poll disconnect | Route: delegated (`odd-writer`, parallel with T4) | Status: done | Commit: `4252fe3` (37 files / 465 tests green)
- [x] **T2** (`S2`) — Periodic safety, APNs HTTP/2 hardening, shutdown & healthcheck observability | Route: delegated (`odd-writer`, parallel with T3) | Status: done | Commit: `27e6d8a` (39 files / 492 tests green)
- [x] **T3** (`S3`) — Backup/restore WAL integrity, atomic ACME TLS, SQLite `busy_timeout`, BlobStore quota & doctor | Route: delegated (`odd-writer`, parallel with T2) | Status: done | Commit: `9696a0b` (39 files / 492 tests green)
- [x] **T4** (`S4`) — Domain, redaction, history tail gap, mesh & repo correctness | Route: delegated (`odd-writer`, parallel with T1) | Status: done | Commit: `c0111ec` (37 files / 465 tests green)
- [x] **T5** (`S5`) — Protocol/TypeBox typing, package lockstep, CI permissions & test determinism | Route: delegated (`odd-writer`) | Status: done | Commit: pending-final-commit (39 files / 495 tests green)

## Log

- **L1 (2026-11-24)**: User request verbatim: `"OK si hagamole, hasta suggestion o warnings si son reales"` (following the 3-repo 4R audit ledgers in order `Rp-relay` -> `Rp-plugin` -> `Rp-app`).
- **L2 (2026-11-24)**: Created feature branch `fix/4r-hardening` from `main` (`3cc6065`) in `Rp-relay`. Split into 5 cohesive work-unit commits (`T1`–`T5`). Launching Wave 1 (`T1` + `T4`, strictly disjoint edit surfaces).
- **L3 (2026-11-24)**: Wave 1 verified (`npm run check`: 37 passed / 465 tests passed, biome + tsc + build clean). Committed `T1` (`4252fe3`) and `T4` (`c0111ec`). Launching Wave 2 (`T2` + `T3`, strictly disjoint edit surfaces).
- **L4 (2026-11-24)**: Wave 2 verified (`npm run check`: 39 passed / 492 tests passed, biome + tsc + build clean). Committed `T2` (`27e6d8a`) and `T3` (`9696a0b`). Launching final unit `T5` (protocol/TypeBox, package lockstep, CI permissions, test determinism).
- **L5 (2026-11-24)**: `T5` verified (`npm run check`: 39 passed / 495 tests passed, biome + tsc + build clean). All 5 work-unit commits complete on `fix/4r-hardening`; launching independent feature-end verifier on `3cc6065..HEAD`.
