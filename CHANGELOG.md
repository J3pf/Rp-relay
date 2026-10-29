# Changelog

Todas las novedades y cambios notables de este proyecto se documentan en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto se adhiere a [Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

### Release sin npm (publicación diferida)
- **El GitHub Release ya no depende del job `npm`:** `github-release` espera sólo a `docker` (la imagen de ghcr es la entrega real hoy), y `verify` sigue siendo el gate obligatorio con el chequeo etiqueta ⇄ versión de los paquetes, lint, build, typecheck y tests. Antes, `needs: [npm, docker]` con un `NPM_TOKEN` inexistente dejaba el siguiente tag `v*` **sin GitHub Release**.
- **Publicación en npm diferida:** `@j3pf/rp-relay` y `@j3pf/rp-protocol` nunca se publicaron (404 en el registro). El job `npm` queda detrás de la variable de repositorio `RP_PUBLISH_NPM=true` y de un secreto `NPM_TOKEN` real; por defecto no corre y no bloquea nada.
- **Guarda contra regresiones:** `test/release-workflow.test.ts` falla si una edición futura vuelve a acoplar `github-release` al job de npm, si saca `verify` del grafo de dependencias del release o si el token de npm aparece fuera del job opt-in.
- **Documentado en** `docs/INSTALACION.md` (operación): canales de entrega actuales = imagen ghcr + GitHub Release.

### Agent Lifecycle Sync (herdr ⇄ app)
- **Cierre bidireccional:** cerrar un panel de herdr emite `agent.closed { reason:"pane_closed" }` y retira el agente de la app; olvidar/cerrar un agente desde la app (`agent.close`) manda `host.herdr_close` al `rp-host` de la máquina y sólo archiva cuando herdr confirma `ok:true`. Una pérdida de socket normal (red, caída del proceso) sigue marcando el agente como offline sin archivar nada, y un `agent.hello` posterior lo vuelve a hacer visible.
- **Archivar en vez de borrar:** `agent.forget` ahora archiva (`archived_at`, migración `0005_agent_archive.sql`). Los agentes archivados salen de la lista, del mesh, de los contadores de máquina y de las notificaciones push, pero conservan eventos, snapshots, prompts y comunicaciones. La retención periódica no los toca.
- **Historial archivado y purga explícita:** `agent.archived` / `GET /v1/agents/archived` lista los agentes archivados con un resumen para mostrar (incluye `messageCount`) y cursor `nextBefore`; `agent.purge` / `DELETE /v1/agents/{id}` es la única vía que destruye historial y exige un agente archivado y desconectado.
- **Nuevos mensajes de protocolo (aditivos):** `agent.closed`, `agent.close`, `agent.archived`, `agent.archived.list`, `agent.purge`, `host.herdr_close`, `host.herdr_closed` y el código de error `agent_close_unsupported` (HTTP 409). Fixtures de contrato para todos ellos.

## [0.5.5] - 2026-10-21

### WebSocket Performance & Compression
- **perMessageDeflate Compression (credit: Luis Chacón):** Enabled RFC 7692 `perMessageDeflate` on WebSocket endpoints to compress communication frames, reducing network egress and latency on mobile connections.
- **Deflate Threshold Enforcement & Context Takeover:** Negotiate `serverNoContextTakeover: true` and `clientNoContextTakeover: true` so `ws` strictly enforces the 1KB threshold. Messages under 1024 bytes (ACKs, event deltas, heartbeat pings) bypass zlib to avoid CPU churn and contention on the zlib limiter, while frames >= 1KB (mesh snapshots, message history) are compressed. Zlib contexts are freed between frames to prevent memory leaks.
- **Decompressed Size Bomb Guard:** Verified and pinned that `maxPayload: MAX_FRAME_BYTES` (1MB) is enforced on decompressed payloads, closing connections that exceed 1MB decompressed with close code 1009.

### Agent Presence & Activity Throttling
- **Preserve last_seen_at on Reconnect (credit: Luis Chacón):** Transient transport reconnects with matching epochs preserve the database `last_seen_at` timestamp. Prevents idle agents from falsely resetting to "activo ahora" in the Android app.
- **Snapshot lastActivityAt (credit: Luis Chacón):** Supports `lastActivityAt` in `AgentSnapshot` and historical `entry.at` timestamps, initializing `last_seen_at` to the agent's real last activity when connecting with an existing chat history.
- **Touch Throttling to Real Activity (credit: Luis Chacón):** Throttles `last_seen_at` database updates to at most once every 15 seconds during streaming, restricted to real activity events (`message_start`, `message_delta`, `message_end`, `user_message`, `tool_execution_start`, `tool_execution_end`, `agent_start`, `comm`). Non-activity events do not trigger database updates.
- **Touch Resumption Fix:** Synchronized `conn.lastTouchAt` with the actual database timestamp on reconnect and snapshot ingestion, ensuring immediate activity events in the first 15 seconds after reconnect are not erroneously throttled away.

### Protocol Compatibility
- **Rp-plugin & Rp-app Interoperability:** Compatible with `Rp-plugin` v0.5.5 non-pi bridged launchers (`claude`, `codex`, `agy`) and `Rp-app` v0.5.5 dynamic slash catalogs and OkHttp WebSocket compression.

### Known Issues & Security
- **Node-Forge Vulnerability:** `npm audit` reports GHSA-86w9-cpqp-85rv (high) in `node-forge` via optional dependency `acme-client` 5.4.0 (both packages are at their latest stable releases; no upstream patch exists yet in node-forge). Only relevant when ACME automatic TLS certificate provisioning is enabled.

### Upgrade
- Upgrade existing installations via:
  ```bash
  sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.5.5/j3pf-rp-relay-0.5.5.tgz && sudo systemctl restart rp-relay
  ```

## [0.5.4] - 2026-10-19

### Performance & Database
- **Composite Indexes for Mesh & Comms (credit: Luis Chacón):** Added migration `0004_perf_indexes.sql` creating composite indexes (`events_agent_epoch_type_seq`, `comms_agent_at`, `comms_peer_at`, `comms_pair_at`) to optimize mesh event streaming, conversation queries, and peer comm lookups. Uses `CREATE INDEX IF NOT EXISTS` for safe, idempotent online schema migrations without table rewrites.
- **Optimized Mesh Rebuilds & Prompt Batching (credit: Luis Chacón):** Avoids full snapshot recalculations when deriving prompt agent labels. Prompt lookups now batch agent disambiguation per machine (`Summaries.openPrompts`). Optimized topology connected components with set-based lookups and single-pass edge message counts.
- **Unresolved Comms Scan Optimization (credit: Luis Chacón):** Added early exit in `resolveUnresolvedComms` to skip scanning the full agent list when no pending unresolved communications exist.

### Test Architecture & Reliability
- **Deterministic CI Smoke Suite:** Scoped `test/load-smoke.test.ts` to functional correctness invariants (zero lost final messages, delivery integrity >= 99%, SQLite persistence) to guarantee 100% deterministic CI runs under high host CPU contention (load average >= 16).
- **Dynamic Throughput Benchmark:** Moved wall-clock throughput and latency thresholds to dedicated benchmark `npm run test:load`, deriving target throughput dynamically (`aggregateEventsPerSec >= expected * TARGET_THROUGHPUT_RATIO`, with `TARGET_THROUGHPUT_RATIO = 0.95`).
- **Dynamic Prompt Label Verification:** Added integration test proving that newly registered duplicate agents immediately update prompt labels and comm names dynamically without returning stale cached values.

### Known Issues & Security
- **Node-Forge Vulnerability:** `npm audit` reports GHSA-86w9-cpqp-85rv (high) in `node-forge` via optional dependency `acme-client` 5.4.0 (both packages are at their latest stable releases; no upstream patch exists yet in node-forge; npm's suggested downgrade to acme-client 2.1.0 is not applied). Only relevant when ACME automatic TLS certificate provisioning is enabled.

### Upgrade
- Upgrade existing installations via:
  ```bash
  sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.5.4/j3pf-rp-relay-0.5.4.tgz && sudo systemctl restart rp-relay
  ```
  Migration `0004` will be applied automatically on service startup.

## [0.5.3] - 2026-10-18

### Improvements & Fixes (Agent Mesh & Display Names)
- **Human-Friendly Agent Display Names:** Introduced shared pure helper `agentDisplayName(agent)` applied consistently across topology node names, group labels, communication `fromName`/`toName`, and prompt summaries. Raw session IDs, UUIDs, ULIDs, hex hashes, and automated subagent names (`subagent-chat-<hex>`) are strictly rejected in favor of human session names, `basename(cwd)`, or the `"Agent"` fallback.
- **Consistent Display Names Across Graph and Comms:** Resolved consistency bug so `fromName`/`toName` in live WebSocket `mesh.comm` events, HTTP `/v1/mesh/conversation`, `/v1/mesh/agents/:agentId/comms`, and prompt `agentLabel` match the agent's disambiguated node name in the snapshot (`"Rp-app (2)"`).
- **Deterministic Duplicate Disambiguation:** Duplicate agent display names residing on the same machine within a snapshot are deterministically disambiguated (`"Rp-app"`, `"Rp-app (2)"`, `"Rp-app (3)"`) ordered stably by `first_seen_at` ascending and tie-broken by `agentId`. Agents on separate machines remain unsuffixed.
- **Unified Pure Group Display Helper:** Refactored group label resolution into pure `groupDisplayLabel(orchestrator, members)` helper in `src/domain/agentNames.ts` with explicit precedence: human orchestrator session name → common cwd basename → orchestrator display name → `"Mesh Group"`. Supports monorepo structures (e.g. orchestrator in `RP` with members in `RP/Rp-app`, `RP/Rp-relay` → `"RP"`).
- **Preserve Hex-Like Human Names:** Adjusted hex identifier heuristics to require digits for hyphenated hex strings, ensuring legitimate words like `cafe-api`, `add-feed`, `Rp-app`, and `dead-beef` are not misclassified as machine IDs.
- **Deterministic Load Smoke Test:** Fixed load generator throughput calculation to measure elapsed time strictly during active event generation rather than including the post-generation socket drain delay, preventing load-sensitive CI flakiness.
- **Dependency Upgrades to Latest Stable:**
  - Fastify plugins: `@fastify/multipart` (9.4.0 → 10.1.4), `@fastify/rate-limit` (10.3.0 → 11.2.1), `@fastify/type-provider-typebox` (5.2.0 → 6.3.0).
  - Database: `better-sqlite3` (12.11.1 → 13.0.3), `@types/better-sqlite3` (7.6.13 → 9.6.0).
  - Logging & Push: `pino` (9.14.0 → 10.4.0), `firebase-admin` (13.10.0 → 14.5.0).
  - Toolchain: `typescript` (5.9.3 → 7.0.2), `vitest` (3.2.7 → 5.0.5). Configured `maxWorkers: 4` in `vitest.config.ts`.
  - Node engine alignment: `@types/node` maintained on v22 (`^22.20.5`) aligned with `"engines": { "node": ">=22" }`.
- **Wire Contract Preservation:** All protocol schemas and payload structures remain 100% backward-compatible with unchanged field types.
- **Known Issues:** `npm audit` reports GHSA-86w9-cpqp-85rv (high) in `node-forge` via optional dependency `acme-client` 5.4.0 (both already latest stable; no upstream patch exists yet in node-forge; npm's suggested downgrade to acme-client 2.1.0 is not applied). Only relevant when ACME automatic TLS is configured.
- **Upgrade:** `sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.5.3/j3pf-rp-relay-0.5.3.tgz && sudo systemctl restart rp-relay`.

## [0.5.2] - 2026-10-17

### Mejoras y Correcciones (Agent Mesh & Infraestructura)
- **Deduplicación y paginación de comunicaciones:** Deduplicación y fusión de filas pareadas out/in antes de aplicar límites de página en `/v1/mesh/conversation` y `/v1/mesh/agents/:agentId/comms`, deduciendo `peer_agent_id` cuando el registro saliente no lo tenía resuelto.
- **Validación de eventos y confirmación de secuencia:** Validación de esquemas `CommEvent` antes de persistencia en SQLite y avance diferido de `conn.lastSeq` sólo tras escrituras exitosas en base de datos.
- **Invalidación reactiva y robustez en Mesh:** Invalidación de caché en Mesh ante cambios en prompts, agentes, revocación/edición de máquinas y purgas de retención. Ajuste del temporizador de aristas activas a `lastAt + 20_001` y refresco de `generatedAt` en snapshots cacheados.
- **Persistencia de estado de agentes y subagentes:** Consulta indexada por tipo (`EventsRepo.listByTypes`) para preservar tareas TODO y eventos de subagentes frente a deltas de streaming de alta frecuencia.
- **Suscripciones WebSocket y cuotas:** Rechazo explícito de `mesh.subscribe` en conexiones directas de push, confirmación `ack` a `mesh.unsubscribe` con `env.id`, y reseteo adecuado de cuotas cuando rp-host reconecta sin cuotas.
- **Optimización de Dockerfile y Compose:** Contenedor optimizado con `tini` como supervisor PID 1, ejecución con usuario no root (`node`), healthcheck activo sobre `/healthz`, binario `rp-relay` en el PATH y `.dockerignore` refinado.
- **Checklist de release / instalador:** Se documenta que el mapeo por defecto de `"latest"` en `deploy/install.sh` debe actualizarse obligatoriamente en cada release para resolver el tarball correspondiente de GitHub Releases (`j3pf-rp-relay-<version>.tgz`).

## [0.5.1] - 2026-10-16

### Corregido
- **Versión dinámica en `/healthz` y CLI:** Se deriva `VERSION` directamente desde `package.json` en tiempo de ejecución (`src/http/routes/health.ts`), eliminando la versión hardcodeada y evitando desincronizaciones en `/healthz` y `rp-relay version`.
- **Compatibilidad con `Rp-app` en `MeshSubscribe`:** Se cambia `machineId` a `OptNullable(Id)` en el esquema `mesh.subscribe` de `@j3pf/rp-protocol` y se normaliza en el relay (`d.machineId ?? null`), permitiendo que clientes con `explicitNulls=false` que envían `{}` se suscriban a todas las máquinas (`machineId: null`).
- **Instalación y actualización standalone:** Se actualiza `deploy/install.sh`, `docs/INSTALACION.md` y `README.md` para instalar desde el artefacto oficial de GitHub Releases (empaquetado con `@j3pf/rp-protocol`), evitando errores 404 al no estar publicado en npm.

### Auditoría
- Auditoría exhaustiva de los 14 esquemas `appUp` confirmando que ningún otro campo de tipo `Nullable` corre riesgo de omisión por parte de la app.

## [0.5.0] - 2026-10-15

### Añadido
- **Agent Mesh:** Grafo animado en tiempo real de agentes interconectados por intercom y orchestrator.
- Topología pura con detección de orquestador, dependencias multinivel y componentes conectados.
- Suscripción WebSocket (`mesh.subscribe`, `mesh.unsubscribe`, `mesh.snapshot`, `mesh.update`, `mesh.comm`).
- Rutas HTTP REST para mesh (`/v1/mesh`, `/v1/mesh/conversation`, `/v1/mesh/agents/:agentId/comms`).
- Persistencia en SQLite con tabla `comms` y retención automática.

## [0.4.0] - 2026-10-15

### Añadido
- Soporte para inicialización remota mediante `rp-host` con `sessionId` e `initialPrompt`.
- Mejoras en la contrapresión y gestión de buffers en canales WebSocket.

## [0.3.0] - 2026-10-15

### Añadido
- Cuotas de máquinas y monitor de uso por ventanas en tiempo real.
- Integración completa con `Rp-app` y notificaciones push directas y FCM.
