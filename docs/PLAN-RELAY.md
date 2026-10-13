# Plan — Relay (`rp-relay`)

Ver contexto en [ARQUITECTURA.md](ARQUITECTURA.md), [COMPATIBILIDAD.md](COMPATIBILIDAD.md) (herdr, gentle-shell, separación por PC) y contrato en [PROTOCOLO.md](PROTOCOLO.md).

## 1. Responsabilidades

1. Autenticar PCs (plugins y rp-host) y dispositivos (apps) por token; emparejamiento por código.
   Cada PC tiene nombre, **contexto** (personal / empresa / …) y color: es el eje de separación en la app y en las notificaciones.
2. Mantener el **registro de agentes** (online/offline) y difundir cambios a las apps.
3. Enrutar en tiempo real: eventos agente → apps; mensajes/abort/respuestas app → agente.
4. Persistir **historial** (eventos finales) para que la app vea lo ocurrido mientras estaba cerrada.
5. Gestionar el ciclo de vida de **prompts** (preguntas/autorizaciones) con semántica "primera respuesta gana".
6. Enviar **push FCM** cifrado y retirarlo cuando la pregunta se resuelve.
7. Almacén temporal de **adjuntos** (blobs).
8. CLI de administración.

**No hace**: ejecutar nada en las máquinas, hablar con LLMs, guardar credenciales de Pi.

## 2. Stack y versiones

| Pieza | Elección |
|---|---|
| Runtime | Node.js **22 LTS** (o 24 LTS), ESM |
| Lenguaje | TypeScript 5.x, `strict` |
| HTTP | Fastify 5 + `@fastify/multipart` + `@fastify/rate-limit` |
| WebSocket | `ws` 8 (montado en el server de Fastify vía `@fastify/websocket`) |
| Esquemas | `typebox` + `@fastify/type-provider-typebox`; validación con `typebox/compiler` (`TypeCompiler`) |
| DB | SQLite vía `better-sqlite3` (modo WAL), migraciones SQL numeradas propias (`migrations/0001_init.sql`…) |
| Push | `firebase-admin` (FCM HTTP v1) |
| Cripto | `node:crypto` (randomBytes, SHA‑256, AES‑256‑GCM) |
| IDs | `ulid` |
| Logs | `pino` (JSON → journald) |
| Tests | `vitest` + cliente `ws` real contra servidor en puerto efímero |
| Lint/format | `biome` (igual que Pi) |
| Empaquetado | npm package con bin `rp-relay` + imagen Docker `ghcr.io/j3pf/rp-relay` |

## 3. Estructura del repo

```
rp-relay/
├── packages/
│   └── protocol/                 # @j3pf/rp-protocol  (compartido con rp-plugin)
│       ├── src/{envelope,agent,app,prompt,push,http}.ts   # esquemas TypeBox + tipos
│       ├── fixtures/*.json       # ejemplos válidos/ inválidos (tests de contrato de los 3 repos)
│       └── package.json
├── src/
│   ├── main.ts                   # arranque, config, señales (SIGTERM → cierre ordenado)
│   ├── config.ts                 # carga /etc/rp-relay/config.json + env RP_*
│   ├── db/{index.ts,migrate.ts,repos/*.ts}
│   ├── auth/{tokens.ts,pairing.ts,middleware.ts}
│   ├── ws/{agentGateway.ts,appGateway.ts,hub.ts}   # hub = registro en memoria de conexiones
│   ├── domain/{agents.ts,events.ts,prompts.ts,messages.ts}
│   ├── push/{fcm.ts,crypto.ts,dispatcher.ts}
│   ├── blobs/{store.ts,routes.ts,gc.ts}
│   ├── http/{routes/*.ts}
│   └── cli/{index.ts,init.ts,pair.ts,devices.ts,machines.ts,doctor.ts}
├── migrations/0001_init.sql
├── deploy/{rp-relay.service, Caddyfile, docker-compose.yml, install.sh}
├── docs/
└── test/
```
Workspaces npm: raíz = relay, `packages/protocol` = librería publicada.

## 4. Modelo de datos (SQLite)

```sql
CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash BLOB NOT NULL UNIQUE,
  push_key BLOB NOT NULL,            -- 32 bytes AES-256-GCM
  fcm_token TEXT, notify_prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);

CREATE TABLE machines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT, token_hash BLOB NOT NULL UNIQUE,
  context TEXT NOT NULL DEFAULT 'personal',   -- personal | work | texto libre
  color TEXT NOT NULL DEFAULT '#4F7DF3', icon TEXT, quiet_hours TEXT,          -- JSON {from,to,tz}
  host_info TEXT,                              -- último host.hello (rp-host) en JSON
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);

CREATE TABLE pairing_codes (
  code_hash BLOB PRIMARY KEY, kind TEXT CHECK(kind IN ('device','machine')) NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER, created_by TEXT);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id),
  instance TEXT NOT NULL, epoch TEXT NOT NULL, session_id TEXT NOT NULL, session_name TEXT, session_file TEXT,
  launcher TEXT, herdr TEXT, gentle TEXT, statuses TEXT, redacted INTEGER NOT NULL DEFAULT 0, spawn_id TEXT,
  cwd TEXT, git_branch TEXT, model TEXT, thinking TEXT, status TEXT NOT NULL,
  online INTEGER NOT NULL, pid INTEGER, pi_version TEXT, plugin_version TEXT, features TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0, last_preview TEXT,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);

CREATE TABLE events (                -- sólo eventos "persistidos" (ver PROTOCOLO §4)
  agent_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (agent_id, epoch, seq));

CREATE TABLE snapshots (agent_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY(agent_id, epoch));

CREATE TABLE prompts (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL,
  payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','answered','resolved','cancelled','expired')),
  answer TEXT, resolved_by TEXT, answered_by_device TEXT,
  created_at INTEGER NOT NULL, resolved_at INTEGER, push_attempts INTEGER NOT NULL DEFAULT 0);
CREATE INDEX prompts_open ON prompts(state) WHERE state IN ('open','answered');

CREATE TABLE blobs (id TEXT PRIMARY KEY, sha256 TEXT, name TEXT, mime TEXT, size INTEGER,
  uploaded_by TEXT, created_at INTEGER, expires_at INTEGER);
```
Retención (job cada hora): eventos > 7 días o > 5 000 por agente → borrar; agentes offline > 7 días → borrar
(con sus eventos); blobs expirados → borrar archivo + fila; prompts cerrados > 30 días → borrar.

Estado `answered` = respuesta recibida pero el plugin aún no confirmó (`prompt.ack`); pasa a `resolved` con el ack.

## 5. Lógica clave

### 5.1 Hub de conexiones
- `Map<agentId, AgentConn>`; una sola conexión viva por `agentId` (= `machineId:piSessionId`): si llega otra con distinto
  `instance`, la anterior se cierra con `4003`. Como el `agentId` es estable, un agente reanudado por herdr o
  `pi --continue` conserva su historial en la app.
- `Map<machineId, HostConn>` para `rp-host` (`/ws/host`); `host.*` de la app se enrutan por `machineId`.
- Conexiones long-poll del plugin (`/v1/agent/send|poll`) se registran en el mismo hub con un adaptador que
  implementa la misma interfaz `AgentConn` (cola por agente; `poll` mantiene la petición abierta ≤25 s).
- `Set<AppConn>` con suscripciones por agente (todas las apps reciben `agents.update` y `prompt.*`; sólo las suscritas
  reciben `agent.event` de ese agente).
- Desconexión de agente → `online=0`, `agents.update`; sus prompts abiertos **se mantienen 2 min** (por si reconecta,
  p. ej. reload) y luego pasan a `cancelled` + push `cancel`.

### 5.2 Prompts ("primera respuesta gana")
```
on prompt.open (plugin):     INSERT state=open; broadcast prompt.opened; dispatcher.push(prompt)
on answer (app WS o HTTP):   UPDATE prompts SET state='answered', answer=?, answered_by_device=?
                               WHERE id=? AND state='open'           -- atómico
                             changes==0 → 409 already_resolved
                             agent online → enviar prompt.answer; offline → queda 'answered' y se entrega en agent.welcome.pendingAnswers
on prompt.ack accepted=true: state='resolved', resolved_by='remote'; broadcast prompt.resolved; push cancel a OTROS dispositivos
on prompt.ack accepted=false:state='resolved' (lo resolvió la terminal en paralelo); broadcast; responder a la app 'already_resolved'
on prompt.resolved (plugin): UPDATE ... state='resolved' WHERE state IN ('open','answered'); broadcast; push cancel a todos
```
Re‑push: si un prompt `danger=high` sigue `open` a los 5 y 10 min → re‑enviar push (máx. 3 total).

### 5.3 Enrutamiento de mensajes de usuario
App → relay valida que el agente esté online (si no: `error agent_offline`; **no** se encolan mensajes de chat, para
evitar que un agente reciba órdenes viejas). Reenvía `user.message` y espera `user.message.ack` del plugin (timeout 10 s →
error `agent_timeout`).

### 5.4 Historial para la app
`agent.subscribe{sinceSeq, epoch}`:
- Si `epoch` coincide y `sinceSeq` ≥ primer seq retenido → enviar eventos persistidos `> sinceSeq`.
- Si no → enviar último `snapshot` del epoch actual + eventos posteriores.
- Después, el agente queda suscrito en vivo (incluye `message_delta` no persistidos).

### 5.5 Push dispatcher
- Selecciona dispositivos no revocados con `fcm_token` y cuyas `notify_prefs` permitan la categoría **para esa PC**
  (`prefs.machines[machineId]` sobrescribe a `prefs.categories`; PC silenciada o en horas silenciosas → no se envía,
  salvo `danger=high` si el usuario activó "autorizaciones críticas siempre"). Por defecto: `permission` y `question`
  siempre; `settled` sólo si ningún dispositivo tiene la app en primer plano viendo ese agente; `error` siempre;
  `terminal_wait` sí.
- El cuerpo incluye `machineName`/`machineContext` para que la app elija el canal de notificación de esa PC.
- Cifra cuerpo con `pushKey` del dispositivo (AES‑256‑GCM, nonce 12 B aleatorio, AAD `"rp1"`).
- `messaging.send({ token, data, android: { priority, ttl, collapseKey } })`.
- Error `messaging/registration-token-not-registered` → borrar `fcm_token`.
- Sin `config.fcm` → dispatcher no‑op (log de advertencia una vez).

## 6. Configuración

`/etc/rp-relay/config.json` (o env `RP_*`):
```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "publicUrl": "https://relay.midominio.com",
  "dataDir": "/var/lib/rp-relay",
  "fcm": { "serviceAccountFile": "/etc/rp-relay/firebase-sa.json" },
  "limits": { "blobMaxBytes": 26214400, "blobTtlDays": 7, "eventRetentionDays": 7 },
  "relayName": "Servidor casa"
}
```

## 7. CLI `rp-relay`

| Comando | Acción |
|---|---|
| `rp-relay init` | Crea config, `dataDir`, DB y migra. Interactivo o con flags. |
| `rp-relay serve` | Arranca el servidor (lo usa systemd). |
| `rp-relay pair device` | Crea código de 10 min y muestra **QR en la terminal** con `rp://pair?u=<publicUrl>&c=<code>` |
| `rp-relay pair machine [--name N] [--context personal|work]` | Código para una PC: el usuario ejecuta en Pi `/rp pair <publicUrl> <code>` |
| `rp-relay machines set <id> --name/--context/--color` | Editar PC |
| `rp-relay devices|machines list|revoke <id>` | Gestión |
| `rp-relay push test [deviceId]` | Envía notificación de prueba |
| `rp-relay doctor` | Comprueba config, DB, permisos, FCM, `publicUrl` alcanzable, reloj |
| `rp-relay migrate` | Migraciones |

## 8. Instalación en Ubuntu Server (22.04 / 24.04)

### Opción A — nativa (recomendada)
```bash
# 1. Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential   # build-essential por better-sqlite3 si no hay binario precompilado
# 2. Usuario de servicio y paquete
sudo useradd --system --home /var/lib/rp-relay --shell /usr/sbin/nologin rp-relay
sudo npm install -g @j3pf/rp-relay        # o: deploy/install.sh desde el release
sudo rp-relay init --public-url https://relay.midominio.com
# 3. systemd
sudo cp deploy/rp-relay.service /etc/systemd/system/ && sudo systemctl enable --now rp-relay
# 4. TLS con Caddy
sudo apt install -y caddy && sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
`deploy/rp-relay.service`: `User=rp-relay`, `ExecStart=/usr/bin/rp-relay serve`, `Restart=always`,
`NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/rp-relay`, `PrivateTmp=yes`.

`deploy/Caddyfile`:
```
relay.midominio.com {
  reverse_proxy 127.0.0.1:8787     # Caddy maneja Upgrade de WebSocket automáticamente
}
```
Requisitos: DNS A/AAAA apuntando al servidor, puertos 80/443 abiertos (`ufw allow 80,443/tcp`).

### Opción B — Docker Compose
`deploy/docker-compose.yml` con servicios `relay` (volumen `/var/lib/rp-relay`) y `caddy` (volúmenes de datos).

### Opción C — Sin dominio público (Tailscale)
`publicUrl = https://<host>.<tailnet>.ts.net`, TLS con `tailscale cert` o `tailscale serve --bg 8787`.
El teléfono necesita Tailscale activo. FCM sigue funcionando (sale por Google).

## 9. Configurar Firebase (una vez)

1. https://console.firebase.google.com → *Add project* (sin Analytics).
2. *Add app* → Android → package `dev.j3pf.rp` (debe coincidir con `applicationId` de la app) → descargar
   `google-services.json` → va en `rp-app/app/` (no se commitea; ver PLAN-APP §10).
3. *Project settings → Service accounts → Generate new private key* → copiar a `/etc/rp-relay/firebase-sa.json`
   (`chmod 600`, dueño `rp-relay`).
4. `rp-relay doctor` → debe marcar FCM OK. `rp-relay push test`.

## 10. Observabilidad y operación
- `/healthz`; logs pino con `agentId`, `promptId`; nunca loguear contenido de mensajes (sólo tamaños) salvo `LOG_LEVEL=trace`.
- Backup: `sqlite3 /var/lib/rp-relay/rp.db ".backup /backups/rp-$(date +%F).db"` por cron diario.
- Actualización: `npm i -g @j3pf/rp-relay@latest && systemctl restart rp-relay` (migraciones automáticas al arrancar).

## 11. Tests

| Nivel | Qué |
|---|---|
| Unit | tokens/hash, cifrado push (vector conocido compartido con la app), máquina de estados de prompts, retención |
| Contrato | cada fixture de `packages/protocol/fixtures` valida (o falla) según su nombre `*.valid.json` / `*.invalid.json` |
| Integración | servidor real + plugin simulado + app simulada (clientes `ws`): hello → snapshot → mensaje → prompt → respuesta HTTP → ack → cancel; carrera "dos respuestas simultáneas" → exactamente una gana |
| Push | `FcmSender` inyectable; test con fake; prueba manual con `push test` |
| Carga | 50 agentes × 20 eventos/s durante 5 min: p99 de reenvío < 50 ms en VPS 1 vCPU |

CI (GitHub Actions): lint, typecheck, test, build Docker, publicar `@j3pf/rp-protocol` y `@j3pf/rp-relay` en tag `v*`.

## 12. Tareas (orden de implementación)

| # | Tarea | Fase | Est. |
|---|---|---|---|
| R0 | Spike S3: Fastify + ws eco con auth Bearer detrás de Caddy | 0 | 0,5 d |
| R1 | Monorepo, biome, vitest, CI | 1 | 0,5 d |
| R2 | `packages/protocol`: esquemas + fixtures de todo PROTOCOLO §2–§8 | 1 | 1,5 d |
| R3 | DB + migraciones + repos | 1 | 1 d |
| R4 | Tokens, pairing (device/machine), CLI `init`, `pair`, QR en terminal (`qrcode-terminal`) | 1 | 1,5 d |
| R5 | Gateway agentes: hello/welcome, snapshot, eventos, persistencia, reconexión | 1 | 2 d |
| R6 | Gateway apps: hello, agents.update, subscribe/historial, user.message, abort | 1 | 2 d |
| R7 | Prompts: estado, HTTP answer, WS answer, ack, cancel, expiración por desconexión | 2 | 2 d |
| R8 | Push: cifrado, FCM, prefs, re‑push, cancel | 2 | 1,5 d |
| R9 | Blobs: upload/download/GC, límites | 3 | 1 d |
| R10 | Retención, `doctor`, systemd/Caddy/Docker, install.sh, docs de instalación | 3 | 1,5 d |
| R11 | `/ws/host` + enrutamiento `host.*` (PROTOCOLO §9) | 3 | 1 d |
| R12 | PCs: contexto/color/horas silenciosas, `PATCH`, prefs por PC en dispatcher, `machines.update` | 1–2 | 1 d |
| R13 | Transporte long-poll para plugins tras proxy corporativo | 2 | 1 d |
