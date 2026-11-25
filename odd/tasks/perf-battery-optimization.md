# Feature: System Performance, Mobile Battery & SQLite Optimization (`Rp-relay`)
- **Branch:** `perf/system-optimization` · **Base:** `main` (`0474c3d`) · **Delivery strategy:** `ask-on-risk`
- **Test runner:** `npm run check` (`biome check .` + `tsc -b` + `vitest run`) & `npm run build` · **Forecast:** ~750 authored changed lines (2 work-unit commits + seam commit)

## Specs

### S1 — Mobile Battery, Wire Coalescing, Heartbeats & Protocol (`RLY-PERF-01`, `RLY-PERF-07`, `RLY-PERF-09`, `RLY-PERF-10`)
- User request verbatim: `"ahora auditemos el sistema en terminos de rendimiento, bateria, performance"` → `"si atacando las 4 fases completas en orden"`
- Add additive, backward-compatible `app.state` (`{ screenOn: boolean }`) to `packages/protocol/src/app.ts`, `registry.ts` (`appUp`), `packages/protocol/fixtures/` (valid + invalid fixtures), and `docs/PROTOCOLO.md`.
- `Publisher.agent()`: skip `directSig` computation when no `mode: "direct"` sockets are connected; on `mode: "direct"`, emit critical state transitions (`online`, `status`, `openPromptCount`) immediately, coalesce cosmetic progress (`activeTask`, `lastMessagePreview`) into a trailing batch window (default 5 s, configurable/flushable for tests), suppress cosmetic progress while a direct socket has `screenOn === false`, and immediately send a fresh `agents.update` to that socket when `app.state { screenOn: true }` arrives; pass `m` into `summaries.agent(row, m)`.
- `PromptService`: scope `prompt.opened` and `prompt.resolved` broadcasts to `{ mode: "foreground" }` (direct sockets already receive `push.notify` + `agents.update`).
- `PushDispatcher`: track delivered `deviceIds` per `promptId` so `promptCancelled()` only fans out `cancel` to devices that actually received `promptOpened` (preventing muted/quiet-hours wakeups); pre-fit push body once per fan-out; wrap `flushDirect` stale acks in a transaction.
- `WsConn` / `Hub` / `ws/index.ts`: add `WsConn.sendSerialized(raw: string)` and pre-serialize broadcast payloads once in `Hub.broadcastApps()`; set `zlibDeflateOptions: { level: 1 }` in `perMessageDeflate`.
- Activity-aware heartbeats & server tuning: make direct ping interval configurable via `RP_DIRECT_PING_MS` (default `300_000` ms, pong timeout `20_000` ms) and reset/skip ping when `lastRxAt` is within the ping interval; use `stmt(db, "SELECT 1")` in `health.ts`; early-exit `LongPollRegistry.sweep()` when `sessions.size === 0`; set `WatchdogSec=60` in `deploy/rp-relay.service`; pass raw `frameBytes` in `validateGatewayEnvelope` (no debug `JSON.stringify`); skip `stat()` for known valid blobs in `BlobStore.gc()`; cap `MessageService` `KEEP = 100`.
- Risk: `item 3 (additive wire protocol app.state, prompt.* mode scoping, heartbeat & push cancel fan-out contracts)`.

### S2 — Non-Blocking Backup, Mesh Materialization, History Streaming & SQLite Optimization (`RLY-PERF-02`, `RLY-PERF-03`, `RLY-PERF-04`, `RLY-PERF-05`, `RLY-PERF-06`, `RLY-PERF-08`)
- `backup/index.ts`: add non-blocking `backupNowAsync(db, dir, at)` using `better-sqlite3`'s asynchronous `db.backup(tmp)` + async `pruneBackupsAsync()` using `fs/promises` (preserving sync `backupNow()` for CLI callers).
- `MeshService`: materialize latest `todo_update` and `subagent_update` per `(agentId, epoch)` in memory (lazy-hydrated once on cache miss); decouple `onComm()` from synchronous `getSnapshot(null)` (use lightweight cached node names/groupId); pass `machineId` to `repos.comms.listSince(now - DAY, machineId)`; stop clearing cache in `activeExpiryTimer`; throttle/early-exit `pruneSeen()`; pre-serialize `mesh.update` frames per group.
- `HistoryService.build()`: check lightweight `snapshotMeta` (seq + pruned) before loading/parsing the full snapshot blob on resume; iterate newest events via `stmt.iterate()` stopping as soon as `FRAME_BUDGET` (900 KB) is reached instead of loading up to 5,001 rows into RAM.
- SQLite & N+1 fixes:
  - Additive migration `migrations/0008_perf_indexes.sql` adding `push_outbox_acked` and `comms_peer_unresolved_at` partial indexes.
  - Set `PRAGMA journal_size_limit = 67108864` in `src/db/index.ts`.
  - Pre-compile `CommEvent` via `TypeCompiler.Compile(CommEvent)`, use `RETURNING *` in `CommsRepo.upsert()`, wrap `resolveUnresolvedComms()` updates in a single transaction, and throttle redundant `agents.setSeq()` writes on hot event bursts while preserving disconnect/stop durability.
  - Eliminate N+1 queries in `Summaries.archived()` (single batched `GROUP BY agent_id` event count) and `Summaries.machine()` (single grouped open-prompt count query per machine).
- Risk: `item 1 & item 3 (additive SQLite migration 0008, backup path, history/mesh hot paths)`.

## Tasks

- [x] **T1** (`S1`, delegated parallel writer, `Risk: item 3`, commit `e6dd58d`) — Protocol `app.state`, `Publisher` direct coalescing & screen-state suppression, `prompt.*` mode scoping, targeted `cancel` push, broadcast pre-serialization, activity-aware heartbeats & secondary hot-path fixes.
- [x] **T2** (`S2`, delegated parallel writer, `Risk: item 1, 3`, commit `98066fa`) — Non-blocking `backupNowAsync`, `MeshService` incremental materialization & throttle fix, streaming `HistoryService.build()`, migration `0008_perf_indexes.sql`, WAL size limit & `Summaries` N+1 fixes.
- [x] **T3** (`S1, S2`, inline parent seam, commits `98066fa`, `a3e41cc`) — Wired `src/relay.ts` (`backupNowAsync`, `stmt(db, "SELECT 1")`, `publisher.dispose()`), fixed all 3 independent-verifier blockers (`a3e41cc`), verified `npm run check`: 41/41 test files, 530/530 tests passed, biome 0 errors, tsc 0 errors. Independent verifier verdict: **PASS (`S1: PASS`, `S2: PASS`)**.

## Log

- **L1 (2026-11-24):** User request verbatim: `"ahora auditemos el sistema en terminos de rendimiento, bateria, performance"` → `"si atacando las 4 fases completas en orden"`. Starting Repo 1 (`Rp-relay`) on branch `perf/system-optimization`. T1 and T2 satisfy the Writer trigger (two independent units with disjoint edit surfaces, ~350+ lines each); launching in parallel with Parent owning `src/relay.ts` and git.
