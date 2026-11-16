# rp-relay

Relay autoalojable (Ubuntu Server) que conecta tus agentes Pi (y sesiones externas vía `rp-host`) con la app móvil RP (**Android e iOS**): lista de agentes en vivo, chat, adjuntos, cuotas, notificaciones push cifradas y **Agent Mesh** (grafo animado en tiempo real de agentes interconectados vía intercom y orchestrator).

> Estado: **v0.8.2**: relay completo (Fastify + ws + SQLite; Node.js ≥ 22).
> Probado e integrado de extremo a extremo con los repos hermanos [`Rp-plugin`](https://github.com/J3pf/Rp-plugin) (extensión Pi + daemon `rp-host`) y [`Rp-app`](https://github.com/J3pf/Rp-app) (app móvil Android e iOS).

| Documento | Contenido |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Visión global de los tres componentes, decisiones, hechos verificados de Pi, fases, riesgos |
| [docs/RESILIENCIA.md](docs/RESILIENCIA.md) | Escalabilidad, resiliencia e independencia total (push sin Google, entrega interactiva sin herdr, Linux/Windows) |
| [docs/COMPATIBILIDAD.md](docs/COMPATIBILIDAD.md) | herdr, gentle-ai, gentle-shell/gentle-pi y separación por PC: hechos verificados y matriz requisito × entorno |
| [docs/PROTOCOLO.md](docs/PROTOCOLO.md) | **Contrato** de red Plugin ⇄ Relay ⇄ App (WS, HTTP, push) |
| [docs/PLAN-RELAY.md](docs/PLAN-RELAY.md) | Plan detallado del relay: stack, datos, lógica, instalación en Ubuntu, Firebase, tests, tareas (con estado) y notas de implementación |
| [docs/INSTALACION.md](docs/INSTALACION.md) | Instalación (nativa, TLS integrado, Docker, Tailscale), configuración, Firebase, CLI y operación |

Repos hermanos: [`Rp-plugin`](https://github.com/J3pf/Rp-plugin) (extensión de Pi + `rp-host`) · [`Rp-app`](https://github.com/J3pf/Rp-app) (Android e iOS).

## Novedades recientes (`v0.6.0` – `v0.8.2`)

- **Push APNs directo cifrado para iOS (`v0.7.0` / `v0.8.2`)**: Emisor HTTP/2 propio con pooling y caché de credencial `.p8`, tokens APNs validados en hexadecimal de 64 caracteres minúsculas, mismo sobre AES-256-GCM (`{k,n,c}`, AAD `rp1`) que FCM y diagnóstico integrado en `doctor`, `devices list` y `push test`.
- **Telemetría en vivo, `done` y uso de contexto (`v0.8.0`–`v0.8.2`)**: `AgentSummary` incluye `done`, `activeTask`, `gitDirty`, `contextTokens`, `contextWindow` y `contextPercent`, además de heartbeat de 240 s y deduplicación en canal `direct` para reducir batería en móvil.
- **Cuotas de IA por máquina**: Almacenamiento y reporte en vivo de cuotas (`migrations/0002_machine_quotas.sql`) alimentadas por `rp-host` (`piquota --json`).
- **Privacidad `redacted` y hardening (`v0.8.2`)**: Enmascarado completo en resúmenes, archivados y push (FCM/APNs/directo) cuando `redacted === 1`, límites de `trustProxy`/rate-limit en `/v1/pair/codes`, poda transaccional en `EventsRepo.prune()` y restauración atómica con permisos `0o600` en `rp-relay restore`.

## Agent Mesh

Agent Mesh muestra la topología viva de agentes que se comunican entre sí en tiempo real, por máquina o de forma global. Incluye:

- Detección automática del orquestador y jerarquías multinivel sin ciclos, a partir de iniciaciones de intercom y orchestrator.
- Agrupación por componentes conectados, con fallback basado en el árbol de directorios de trabajo (CWD).
- Estado en vivo por nodo: actividad, tareas TODO activas, hasta 10 subagentes lanzados (running primero) y preguntas pendientes.
- Conexiones activas animadas de los últimos 20 s y visualización de mensajes en vivo; el modo redactado oculta los textos y preserva la topología.
- Suscripción WebSocket con `mesh.subscribe` / `mesh.unsubscribe`, actualizaciones coalescidas (≤2/s) y endpoints HTTP REST: `/v1/mesh`, `/v1/mesh/conversation` y `/v1/mesh/agents/:id/comms`.

## Ciclo de vida de los agentes (herdr ⇄ app)

Cerrar un agente se refleja en los dos sentidos, y el historial nunca se pierde por accidente:

- **Cerrar el panel en herdr** → el plugin lo avisa con `agent.closed{pane_closed}` y el agente desaparece de la app (lista, mesh y notificaciones). Una caída de red o del proceso **no** borra nada: sólo lo marca offline.
- **Olvidar en la app** → `agent.forget` archiva el agente; si además corre dentro de un panel de herdr, la app pide `agent.close` y el relay cierra el panel vía `rp-host` (`host.herdr_close`) antes de archivarlo. Si el host falla o no responde, no se archiva nada y la app recibe un error tipado.
- **Archivar conserva el historial**: mensajes, eventos y comunicaciones siguen en SQLite y se pueden consultar con `agent.archived` / `GET /v1/agents/archived`, que devuelve un resumen por agente (incluido cuántos eventos conserva) paginado por cursor.
- **Purgar es la única vía destructiva**: `agent.purge` / `DELETE /v1/agents/{id}` exige un agente archivado, se niega si está conectado y borra de verdad su historial. La retención periódica tampoco toca agentes archivados.

## Inicio rápido

```bash
npm ci && npm run build
node dist/cli/index.js init --config ./config.json --data-dir ./data --public-url http://127.0.0.1:8787 --yes
RP_CONFIG=./config.json node dist/cli/index.js serve          # en otra terminal:
RP_CONFIG=./config.json node dist/cli/index.js pair device    # QR para la app
RP_CONFIG=./config.json node dist/cli/index.js doctor
```

## Despliegue en Ubuntu Server

Para un servidor en producción (Ubuntu Server 22.04 / 24.04), dispones del instalador automatizado idempotente o instalación manual:

```bash
# Opción 1: Instalador automatizado con Caddy (TLS automático; descarga el tarball de GitHub Releases)
sudo ./deploy/install.sh --public-url https://relay.midominio.com --caddy --name "Mi Relay"

# Opción 2: Instalación manual paso a paso (vía npm install -g <tarball-release-url>)
# Consulta la guía completa en docs/INSTALACION.md
```

### Rutas estándar del sistema
- **Configuración:** `/etc/rp-relay/config.json` (dueño `root:rp-relay`, permisos `640`)
- **Directorio de datos:** `/var/lib/rp-relay/` (dueño `rp-relay:rp-relay`, permisos `750`): contiene `relay.db`, `blobs/`, `backups/`, `admin.token`
- **Servicio systemd:** `/etc/systemd/system/rp-relay.service` (`Type=notify`, `WatchdogSec=30`, usuario `rp-relay`)
- **Binario CLI:** `/usr/bin/rp-relay` (o symlink)

### Comandos CLI esenciales
```bash
# Diagnóstico completo de configuración, BD, reloj y red
sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay doctor

# Generar código QR para emparejar la app móvil RP (Android / iOS)
sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay pair device

# Generar código para emparejar una PC (Pi)
sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay pair machine --name "Mi PC" --context personal

# Monitorear logs del servicio
journalctl -u rp-relay -f
```

Guía completa de instalación, opciones de TLS integrado (ACME), Docker y Tailscale: [docs/INSTALACION.md](docs/INSTALACION.md).  
Resolución de problemas comunes (puertos, certificados, SQLite, emparejamiento): [docs/INSTALACION.md#troubleshooting-resolución-de-problemas](docs/INSTALACION.md#troubleshooting-resolución-de-problemas).

## Desarrollo

Requiere **Node.js ≥ 22** (los paquetes se distribuyen vía GitHub Releases y `ghcr.io/j3pf/rp-relay`, no en npm).

| Comando | Qué hace |
|---|---|
| `npm run check` | lint (biome) + tipos + todas las pruebas |
| `npm test` | vitest: contrato (fixtures), integración con servidor y clientes `ws` reales, resiliencia, CLI, humo de carga |
| `npm run test:load` | carga completa en un proceso aparte (50 agentes × 20 ev/s × 5 min; `-- --duration 20` para una pasada corta) |
| `npm run dev` | `rp-relay serve` con `tsx` |

Estructura: `packages/protocol` (esquemas TypeBox + fixtures canónicos, `@j3pf/rp-protocol`), `src/` (`db`, `auth`, `ws`, `domain`, `push`, `blobs`, `http`, `cli`, `backup`, `tls`),
`migrations/` (`0001_init.sql`..`0006_apns_push.sql`), `deploy/` (systemd, Caddy, Docker Compose, `install.sh`), `spikes/`, `test/`.

## Referencias investigadas

- Pi (`earendil-works/pi`, base investigada v1.2.0; verificado contra **v1.5.2**): `packages/coding-agent/docs/{extensions,packages,rpc,rpc-extension-ui,json,security,sessions}.md`,
  `src/core/extensions/{types,runner}.ts`, `src/modes/{interactive/interactive-mode,rpc/rpc-mode}.ts`,
  ejemplos `permission-gate.ts`, `question.ts`, `notify.ts`, `send-user-message.ts`.
- [Remote Pi](https://github.com/jacobaraujo7/remote_pi) (Flutter + relay Rust + extensión Pi): emparejamiento QR, aprobaciones vía
  `@eko24ive/pi-ask`; **sin push real** — es la principal carencia que este proyecto cubre.
- [Happy](https://github.com/slopus/happy) / Happier (happier-dev): wrapper de CLI + servidor Fastify/Socket.IO con cifrado E2E.
- [Moshi](https://getmoshi.app/docs): terminal móvil + hook en el host que genera bandeja de aprobaciones y push.
- [gentle-shell / gentle-pi](https://github.com/Gentleman-Programming/gentle-shell) (probado hasta **4.8.0**), [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), [herdr](https://github.com/herdrdev/herdr) 0.9.3: entorno del usuario, ver `docs/COMPATIBILIDAD.md`.
