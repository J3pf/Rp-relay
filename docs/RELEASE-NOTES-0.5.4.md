# Release Notes — Rp-relay v0.5.4

## Highlights

### Performance Optimizations (Agent Mesh & SQLite)
This release incorporates key database and runtime performance optimizations authored by collaborator Luis Chacón (@lchaconw), along with test suite determinism improvements:

- **Composite Indexes (Migration `0004_perf_indexes.sql`):**
  Added 4 composite indexes to optimize event and communication querying:
  - `events_agent_epoch_type_seq` ON `events(agent_id, epoch, type, seq DESC)`
  - `comms_agent_at` ON `comms(agent_id, at DESC, comm_id DESC)`
  - `comms_peer_at` ON `comms(peer_agent_id, at DESC, comm_id DESC) WHERE peer_agent_id IS NOT NULL`
  - `comms_pair_at` ON `comms(agent_id, peer_agent_id, at DESC, comm_id DESC) WHERE peer_agent_id IS NOT NULL`
  The migration is safe and idempotent (`CREATE INDEX IF NOT EXISTS`) and executes within the SQLite migration runner's transaction without table rewrites.
- **Optimized Prompt Label Disambiguation:**
  Eliminated full mesh snapshot rebuilds when generating prompt summaries. `Summaries.openPrompts()` now batches agent names by machine, computing disambiguation once per machine rather than on every prompt row.
- **Topology & Comms Optimization:**
  Topology connected components now use `Set.has()` lookups for constant-time member checks, and edge message counts (`aToB`, `bToA`, `replies`, `asks`) are calculated in a single linear pass. `resolveUnresolvedComms` exits early when no unresolved records exist.

### Test Architecture Improvements
- **Deterministic CI Smoke Tests:**
  `test/load-smoke.test.ts` (executed during `npm test` and CI) now asserts functional correctness invariants: zero lost final events (`lostFinals === 0`), delivery ratio `>= 99%`, and SQLite persistence of `message_end` events. Wall-clock performance checks that fluctuate under host scheduling contention have been moved to the dedicated benchmark runner.
- **Dynamic Load Benchmark:**
  `npm run test:load` derives required throughput dynamically from command-line arguments: `aggregateEventsPerSec >= agents * rate * TARGET_THROUGHPUT_RATIO` (where `TARGET_THROUGHPUT_RATIO = 0.95`).
- **Dynamic Disambiguation Verification:**
  Added integration test proving prompt labels and communication views dynamically resolve to newly connected duplicate agent names without stale cache issues.

## Known Issues
- `npm audit` reports GHSA-86w9-cpqp-85rv (high) in `node-forge` via optional dependency `acme-client` 5.4.0. Both packages are at their latest stable releases, and no patched upstream version of `node-forge` exists. npm's suggested downgrade to `acme-client` 2.1.0 breaks modern ACME features and is intentionally not applied. Only relevant when ACME automatic TLS certificate provisioning is enabled.

## Upgrade
To upgrade an existing installation:

```bash
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.5.4/j3pf-rp-relay-0.5.4.tgz && sudo systemctl restart rp-relay
```

Migration `0004` will be executed automatically on startup. The graceful shutdown signals connected clients with code `1012`, prompting them to reconnect immediately and seamlessly.
