# Release Notes — Rp-relay v0.5.5

## Highlights

### WebSocket Performance & Compression
This release incorporates WebSocket compression and presence optimizations authored by collaborator Luis Chacón (@lchaconw), along with concurrency fixes and comprehensive test coverage:

- **WebSocket perMessageDeflate (credit: Luis Chacón):**
  Enabled RFC 7692 `perMessageDeflate` on `/ws/app`, `/ws/agent`, and `/ws/host` to compress WebSocket payloads, significantly reducing network bandwidth and latency on mobile networks.
- **Threshold Enforcement & Context Takeover Management:**
  Fixed a defect in initial `perMessageDeflate` configuration where `ws` ignored the 1KB threshold unless context takeover was disabled. By negotiating `serverNoContextTakeover: true` and `clientNoContextTakeover: true`, frames under 1KB (such as small events, ACKs, and ping/pong frames) remain uncompressed to avoid zlib CPU churn, while larger frames (such as `mesh.snapshot`, full agent snapshots, and large message deltas) are efficiently compressed. This also releases zlib compression contexts between frames, avoiding long-term memory accumulation per client.
- **Compression-Bomb Protection Verified:**
  Verified and pinned with automated tests that `maxPayload: MAX_FRAME_BYTES` (1MB) is strictly enforced on decompressed payloads by `ws`'s `InflateRaw` stream listener. Payloads that decompress beyond 1MB are rejected immediately with WebSocket close code 1009 (`WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`), preventing memory exhaustion.

### Agent Presence & Activity Throttling
- **Preserve `last_seen_at` on Reconnect (credit: Luis Chacón):**
  When an agent reconnects without changing epoch (transient connection drop or network switch), `last_seen_at` in SQLite is preserved rather than overwritten with current time. In the mobile app, this ensures idle agents accurately display their real last activity time ("hace 20 min") rather than falsely resetting to "activo ahora".
- **Snapshot `lastActivityAt` Preservation (credit: Luis Chacón):**
  `AgentSnapshot` accepts an optional `lastActivityAt` timestamp and parses historical entry timestamps (`entry.at`). When an agent connects with an existing conversation, `last_seen_at` is set to the latest historical activity timestamp (clamped to `Date.now()`), avoiding false active status for dormant sessions.
- **Activity-Only Touch Throttling (credit: Luis Chacón):**
  Database touch updates to `last_seen_at` are throttled to at most once every 15 seconds, and are strictly restricted to real activity events (`message_start`, `message_delta`, `message_end`, `user_message`, `tool_execution_start`, `tool_execution_end`, `agent_start`, `comm`). Non-activity frames (`agent.status`, `session_info_changed`, `model_select`, `todo_update`) do not touch `last_seen_at`.
- **Immediate Activity Resumption on Reconnect & Snapshot:**
  Fixed a defect where `conn.lastTouchAt` was initialized to `now` upon reconnect and snapshot ingestion, which mistakenly throttled legitimate activity events occurring in the first 15 seconds after reconnection. `conn.lastTouchAt` is now synchronized with the actual persisted `last_seen_at` / `clampedAt` timestamp.

### Protocol Compatibility
- **Rp-plugin & Rp-app Compatibility:**
  Fully compatible with `Rp-plugin` v0.5.5 (`bedba6d`) including bridged non-pi agents (`claude`, `codex`, `agy`), dynamic launcher reporting in `HostHello`, and `Rp-app` v0.5.5 dynamic slash-command catalogs and OkHttp WebSocket compression.

## Known Issues
- `npm audit` reports GHSA-86w9-cpqp-85rv (high) in `node-forge` via optional dependency `acme-client` 5.4.0. Both packages are at their latest stable releases, and no patched upstream version of `node-forge` exists. npm's suggested downgrade to `acme-client` 2.1.0 breaks modern ACME features and is intentionally not applied. Only relevant when ACME automatic TLS certificate provisioning is enabled.

## Upgrade
To upgrade an existing installation:

```bash
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.5.5/j3pf-rp-relay-0.5.5.tgz && sudo systemctl restart rp-relay
```

The graceful shutdown signals connected clients with code `1012`, prompting them to reconnect immediately and seamlessly.
