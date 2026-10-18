# Changelog

Todas las novedades y cambios notables de este proyecto se documentan en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto se adhiere a [Semantic Versioning](https://semver.org/lang/es/).

## [0.5.3] - 2026-10-18

### Improvements & Fixes (Agent Mesh & Display Names)
- **Human-Friendly Agent Display Names:** Introduced shared pure helper `agentDisplayName(agent)` applied consistently across topology node names, group labels, communication `fromName`/`toName`, and prompt summaries. Raw session IDs, UUIDs, ULIDs, hex hashes, and automated subagent names (`subagent-chat-<hex>`) are strictly rejected in favor of human session names, `basename(cwd)`, or the `"Agent"` fallback.
- **Deterministic Duplicate Disambiguation:** Duplicate agent display names residing on the same machine within a snapshot are deterministically disambiguated (`"Rp-app"`, `"Rp-app (2)"`, `"Rp-app (3)"`) ordered stably by `first_seen_at` ascending and tie-broken by `agentId`. Agents on separate machines remain unsuffixed.
- **Human Group Labels:** Group chip labels resolve to the orchestrator's display name or common working directory basename, never falling back to a raw UUID or session ID.
- **Wire Contract Preservation:** All protocol schemas and payload structures remain 100% backward-compatible with unchanged field types.

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
