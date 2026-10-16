# Changelog

Todas las novedades y cambios notables de este proyecto se documentan en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto se adhiere a [Semantic Versioning](https://semver.org/lang/es/).

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
