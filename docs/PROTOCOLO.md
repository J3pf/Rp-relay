# RP — Protocolo v1 (contrato entre Plugin ⇄ Relay ⇄ App)

Este documento es **el contrato**. Plugin, relay y app se implementan contra él. Cualquier cambio requiere subir
`v` o añadir campos opcionales (nunca cambiar el significado de uno existente).

Implementación canónica de los esquemas: `rp-relay/packages/protocol` (TypeBox), publicado como
`@j3pf/rp-protocol`. La app Android replica los tipos en Kotlin y se valida contra los **fixtures JSON**
de `rp-relay/packages/protocol/fixtures/*.json` (tests de contrato en los tres repos).

## 1. Transporte

| Canal | URL | Quién | Auth |
|---|---|---|---|
| WS agentes | `wss://<relay>/ws/agent` | plugin | Header `Authorization: Bearer <machineToken>` |
| WS apps | `wss://<relay>/ws/app` | app | Header `Authorization: Bearer <deviceToken>`; query `?mode=foreground|direct` (`direct` = conexión del servicio en segundo plano: sólo recibe `push.*`, `prompt.*`, `agents.update` resumido) |
| HTTP | `https://<relay>/v1/...` | ambos | `Authorization: Bearer <token>` |

- Frames de texto, **un objeto JSON por frame**, UTF‑8, máx. **1 MiB** (los adjuntos van por HTTP, no por WS).
- Keep‑alive: el relay envía ping WS cada 25 s; si no hay pong en 10 s cierra. Los clientes reconectan con
  backoff exponencial 1 s → 2 → 4 … máx. 30 s, con jitter ±20 %.
- Código estándar `1012` (service restart) al actualizar el relay: reconectar de inmediato.
- Códigos de cierre propios: `4001` token inválido/revocado (no reconectar), `4002` versión de protocolo
  incompatible (no reconectar), `4003` reemplazado por otra conexión del mismo agente, `4008` frame inválido.

## 2. Sobre (envelope)

```jsonc
{
  "v": 1,                 // versión del protocolo
  "t": "agent.event",     // tipo
  "id": "01JA…",          // ULID, opcional; obligatorio si se espera respuesta (req/ack)
  "re": "01JA…",          // id del mensaje al que responde (en respuestas)
  "ts": 1760342400000,    // epoch ms del emisor
  "d": { … }              // cuerpo según el tipo
}
```
Errores: `{ "v":1, "t":"error", "re":"<id>", "d": { "code":"…", "message":"…" } }`.
Códigos: `bad_request`, `unauthorized`, `not_found`, `conflict` (p. ej. prompt ya resuelto), `agent_offline`,
`too_large`, `rate_limited`, `internal`.

## 3. Identificadores

| Id | Formato | Origen |
|---|---|---|
| `machineId` | ULID | relay, al emparejar la máquina |
| `deviceId` | ULID | relay, al emparejar el teléfono |
| `agentId` | `<machineId>:<piSessionId>` | plugin. Estable aunque el proceso se reinicie (reanudación de herdr, `pi --continue`) |
| `instance` | ULID | plugin, uno por proceso; si dos procesos abren la misma sesión, el relay mantiene el más reciente (`4003` al otro) |
| `promptId` | ULID | plugin |
| `blobId` | ULID | relay |
| `seq` | entero ≥1, por agente, monotónico | plugin (reinicia contador por `epoch`) |
| `epoch` | ULID | plugin, uno por conexión de sesión (cambia en `/new`, `/resume`, reload) |

## 4. Plugin → Relay (`/ws/agent`)

### `agent.hello` (primer mensaje obligatorio, espera `agent.welcome`)
```jsonc
{ "agentId":"…", "kind":"pi", "instance":"…", "epoch":"…",   // kind: tipo de agente (hoy sólo "pi"; extensible)
  "pi": { "version":"1.2.0", "mode":"tui" },        // ctx.mode
  "plugin": { "version":"0.1.0", "features":["mirror_ui","adapters:gentle-ask","gate","rp_ask_user","attachments","deliver_terminal"] },
  "session": { "id":"…", "file":"/home/u/.pi/agent/sessions/…jsonl", "name":"refactor auth" },
  "host": { "hostname":"devbox", "user":"jorge", "pid":4242, "os":"linux" },
  "launcher":"gentle-shell",                         // pi | gentle-shell
  "herdr": { "paneId":"p3", "tabId":"t1", "workspaceId":"w2", "session":null },   // null si no corre en herdr
  "gentle": { "version":"4.1.0", "mode":"normal" },  // null si gentle-pi no está; mode: normal|auto|yolo|unknown
  "transport":"ws",                                  // ws | longpoll
  "redacted": false,                                 // true → no se envían message_*/resultados
  "cwd":"/home/jorge/proyectos/api", "spawnId": null,   // RP_SPAWN_ID si lo lanzó rp-host
  "git": { "branch":"main", "dirty":true },
  "model": { "provider":"anthropic", "id":"…" }, "thinking":"medium",
  "status":"idle",                                   // idle | working | waiting_input | compacting | error
  "openPrompts":[ /* prompts abiertos de esta instancia, ver prompt.open */ ] }
```
### `agent.snapshot` (tras `welcome`, y cuando el relay lo pide con `agent.resync`)
Historial de la rama activa (últimas **200** entradas de `getBranch()`), ya normalizado:
```jsonc
{ "epoch":"…", "seq": 57, "entries":[ Entry… ], "truncated": true }
```
`Entry` = `{ "eid": "<entryId de Pi>", "kind": "user"|"assistant"|"tool_result"|"bash"|"custom"|"compaction"|"branch_summary"|"model_change",
"at": epochMs, "msg": { …mensaje de Pi tal cual (AgentMessage), con imágenes reemplazadas por {type:"image_ref",mimeType,bytes} } }`.

### `agent.event` (streaming)
```jsonc
{ "epoch":"…", "seq": 58, "e": { "type":"message_end", … } }
```
Tipos de `e` reenviados (forma idéntica a la de `docs/json.md` de Pi, con las reglas siguientes):

| Evento Pi | Se reenvía | Persistido en relay |
|---|---|---|
| `agent_start`, `agent_settled{aborted}` | sí | sí |
| `turn_start`, `turn_end` | sí (sin `message`/`toolResults`, que ya llegan por `message_end`) | no |
| `message_start` | sí | no |
| `message_update` | **coalescido**: el plugin agrupa deltas cada **100 ms** en `{type:"message_delta", contentIndex, kind:"text"|"thinking"|"toolcall", delta}` | no |
| `message_end` | sí (mensaje completo, autoritativo) | **sí** |
| `tool_execution_start` | sí | sí |
| `tool_execution_update` | throttled 500 ms; `partialResult` truncado a 8 KiB | no |
| `tool_execution_end` | sí; `result.content` texto truncado a **32 KiB** con marca `truncated:true` | sí |
| `session_info_changed`, `model_select`, `thinking_level_select` | sí | sí |
| `session_compact` | sí (sólo resumen) | sí |
| `ui_prompt_start/end` con `kind:"custom"|"editor"` | sí, como `{type:"terminal_wait", kind, title, active:bool}` | no |

### `agent.status` — `{ "status":"working", "detail":"bash: npm test" }` (cambios de estado derivados)
### `agent.statuses` — `{ "items": { "gentle:mode":"Permissions: AUTO", "rp":"📱", … } }` (estado completo de `setStatus` de todas las extensiones, coalescido ≤1/s; `gentle.mode` se deriva de aquí)

### `prompt.open` (espera `ack`)
```jsonc
{ "promptId":"…", "agentId":"…",
  "kind":"confirm" | "select" | "input" | "questionnaire",
  "category":"permission" | "question" | "dialog",   // gate propio | ask_user | espejo de otra extensión
  "title":"⚠ Comando peligroso",
  "message":"rm -rf build/",                          // opcional, texto plano
  "options":[ {"id":"0","label":"Permitir"}, {"id":"1","label":"Permitir siempre (sesión)"}, {"id":"2","label":"Denegar"} ],
  "allowFreeText": false, "placeholder": null,
  "questions": null,  // sólo kind=questionnaire: [{ "question", "header", "multiSelect":false, "allowFreeText":false,
                      //   "options":[{"id","label","description","preview"}] }]  (1–4 preguntas, como ask_user_question de gentle-pi)
  "source": { "extension":"gentle-pi", "tool":"ask_user_question", "subagent": false },  // informativo
  "tool": { "name":"bash", "args": { "command":"rm -rf build/" } },  // sólo category=permission
  "danger": "high",                                   // low | medium | high → prioridad de notificación
  "expiresAt": null }                                  // epoch ms o null (sin límite)
```
### `prompt.resolved` — `{ "promptId":"…", "by":"local"|"remote"|"timeout"|"cancelled", "answer": Answer|null }`
### `prompt.ack` — `{ "promptId":"…", "accepted": true }` (respuesta a `prompt.answer`; `false` si ya estaba resuelto/no existe)
### `user.message.ack` — `{ "clientMsgId":"…", "disposition":"sent"|"queued_steer"|"queued_followup"|"typed"|"typed_after_dialog"|"command"|"duplicate"|"rejected", "method":"api"|"interactive"|"herdr", "error":null|"agent_blocked"|"herdr_unavailable"|"interactive_unavailable" }`

## 5. Relay → Plugin

| Tipo | Cuerpo |
|---|---|
| `agent.welcome` | `{ "serverTime":…, "lastSeq":56 | null, "pendingAnswers":[prompt.answer…] }` (si `lastSeq` del mismo `epoch` < actual, el plugin no necesita reenviar; el snapshot se manda siempre) |
| `agent.resync` | `{}` → el plugin envía `agent.snapshot` |
| `user.message` | `{ "clientMsgId":"…", "deviceId":"…", "text":"…", "attachments":[{"blobId","name","mime","size"}], "delivery":"auto"|"steer"|"followUp", "method":"auto"|"api"|"interactive"|"herdr", "asCommand": false }` (`interactive` = el plugin lo teclea dentro del proceso de Pi → `source:"interactive"`; `herdr` = vía `herdr agent prompt`; `api` = `sendUserMessage`; `auto` = interactive si gentle está en AUTO, si no api — ver RESILIENCIA §2; `asCommand` = texto `/…` ejecutado como comando). `clientMsgId` es clave de idempotencia (el relay y el plugin descartan repetidos) |
| `agent.abort` | `{}` → `ctx.abort()` |
| `prompt.answer` | `{ "promptId":"…", "answer": Answer, "deviceId":"…" }` |
| `prompt.cancel` | `{ "promptId":"…" }` (expirado por el relay) |

`Answer` = `{ "optionIds":["0"] }` | `{ "confirmed":true }` | `{ "text":"…" }` | `{ "cancelled":true }` |
`{ "answers":[ { "questionIndex":0, "optionIds":["1"] } | { "questionIndex":1, "text":"…" } ] }` (questionnaire; varias `optionIds` si `multiSelect`).

## 6. App ⇄ Relay (`/ws/app`)

App → Relay:

| Tipo | Cuerpo | Respuesta |
|---|---|---|
| `app.hello` | `{ "deviceId", "app":{"version"}, "subscriptions":"all" }` | `app.welcome { machines:[MachineSummary], agents:[AgentSummary], openPrompts:[Prompt] }` |
| `agent.subscribe` | `{ "agentId", "sinceSeq": 120 | null, "epoch": "…" | null }` | `agent.history { agentId, epoch, entries:[…], events:[…], liveFromSeq }` y luego eventos en vivo |
| `agent.unsubscribe` | `{ "agentId" }` | — |
| `user.message` | igual que §5 + `agentId` | `user.message.ack` (reenviado del plugin) o `error agent_offline` |
| `agent.abort` | `{ "agentId" }` | `ack` |
| `prompt.answer` | `{ "promptId", "answer" }` | `prompt.answer.result { ok, reason? }` (`reason`: `already_resolved` / `agent_offline_queued`) |
| `agent.forget` | `{ "agentId" }` (borrar agente offline de la lista) | `ack` |

Relay → App: `machines.update { upsert:[MachineSummary], remove:[machineId] }`, `agents.update { upsert:[AgentSummary], remove:[agentId] }`, `agent.event { agentId, epoch, seq, e }`,
`prompt.opened { Prompt }`, `prompt.resolved { promptId, by, answer, byDeviceId? }`, `terminal_wait {agentId,…}`.

`AgentSummary` = `{ agentId, machineId, machineName, machineContext, machineColor, sessionName, cwd, gitBranch, model, status, online, lastSeenAt, openPromptCount, lastMessagePreview (≤140 chars), launcher, herdr, gentleMode, redacted, spawnedByHost }`.

`MachineSummary` (en `app.welcome.machines` y `machines.update`) = `{ machineId, name, context:"personal"|"work"|string, color:"#RRGGBB", icon, online, agentCount, openPromptCount, hostOnline }`.

## 7. HTTP API (`/v1`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `POST` | `/v1/pair/device` | código | `{ code, name, fcmToken? }` → `{ deviceId, deviceToken, pushKey (base64 32 B), relayName }` |
| `POST` | `/v1/pair/machine` | código | `{ code, hostname, name?, context? }` → `{ machineId, machineToken }` |
| `POST` | `/v1/pair/codes` | device | crear código para emparejar una máquina desde la app → `{ code, expiresAt }` |
| `PUT` | `/v1/devices/me/push` | device | `{ fcmToken?: string|null, direct: boolean }` — canales de push activos del dispositivo (FCM opcional; `direct` = servicio en primer plano con WS) |
| `POST` | `/v1/devices/me/push-test` | device | envía una notificación de prueba a este dispositivo |
| `GET` | `/v1/devices` / `DELETE /v1/devices/{id}` | device | listar / revocar |
| `GET` | `/v1/machines` / `DELETE /v1/machines/{id}` | device | listar / revocar |
| `PATCH` | `/v1/machines/{id}` | device | `{ name?, context?, color?, icon?, quietHours? }` |
| `PUT` | `/v1/devices/me/prefs` | device | preferencias de notificación globales y por PC: `{ categories:{…}, machines:{ "<machineId>": { mute:false, categories:{…}, quietHours:{from:"20:00",to:"08:00",tz:"America/Bogota"} } } }` |
| `POST` | `/v1/agent/send` · `/v1/agent/poll` | machine | transporte de respaldo long-poll del plugin: `send` recibe un array de mensajes del §4; `poll` espera hasta 25 s y devuelve un array de mensajes del §5 |
| `GET` | `/v1/agents` | device | lista (fallback sin WS) |
| `GET` | `/v1/prompts?state=open` | device | preguntas abiertas |
| `POST` | `/v1/prompts/{id}/answer` | device | `{ answer }` → `200 {ok:true}` / `409 already_resolved` — **usado por los botones de la notificación** |
| `POST` | `/v1/agents/{id}/messages` | device | igual que `user.message` (para RemoteInput "responder" en notificación de agente terminado) |
| `POST` | `/v1/blobs` | device | multipart `file` (≤25 MiB) → `{ blobId, sha256, size, mime }` |
| `GET` | `/v1/blobs/{id}` | machine/device | descarga (TTL 7 días) |
| `GET` | `/healthz` | — | `{ ok, version, uptime }` |

### 7.1 Transporte long-poll (detalle de v1)

Mismos mensajes del §4 (plugin → relay) y §5 (relay → plugin), en lotes JSON:

- `POST /v1/agent/send` — cuerpo: array de sobres (≤200). Un `agent.hello` crea la sesión (o reemplaza la anterior del
  mismo `agentId`: la antigua recibe `410` en su siguiente `poll`). Respuesta: `{ ok, accepted, rejected }`. **Todo lo
  que el relay envía al plugin —incluidos `agent.welcome` y los `error` de mensajes inválidos— sale por `poll`**, con
  `re` = `id` del mensaje original.
- `POST /v1/agent/poll` con `{ agentId, instance?, timeout? }` (también `GET` con esos parámetros en la query) — espera hasta `timeout` ms (≤25 000) y devuelve
  `{ messages: [sobres…] }` (vacío al agotar el tiempo). `instance` es opcional pero recomendado: si no coincide con
  la sesión vigente → `410`.
- `404` → no hay sesión (enviar `agent.hello` primero). `410 { closeCode }` → la sesión se cerró (`4003` = reemplazada;
  el plugin no debe reconectar si es `4001`/`4002`). Una sesión sin actividad durante 60 s se da por desconectada
  (el agente pasa a offline).
- Autenticación: `Authorization: Bearer <machineToken>`. La PC sólo puede operar agentes cuyo `agentId` empiece por su `machineId`.

### 7.2 Convenciones adicionales de la implementación (compatibles con v1)

Campos y comportamientos añadidos sin cambiar el significado de ninguno existente:

- **Cierre por autenticación:** con token inválido o revocado el relay *completa* el upgrade WS y cierra con `4001`
  (así el cliente recibe el código); `4008` también para frames binarios, JSON inválido, `hello` ausente en 10 s o
  inválido (un frame de más de 1 MiB lo corta la librería WS con `1009`); `4002` si `v` no está soportada. Sólo se admiten frames de texto.
- **Errores HTTP:** `{ "error": { "code", "message", "reason"? } }` con el estado HTTP equivalente
  (`bad_request` 400, `unauthorized` 401, `not_found` 404, `conflict` 409, `too_large` 413, `rate_limited` 429).
  `POST /v1/prompts/{id}/answer` devuelve `409 { "ok": false, "reason": "already_resolved", "error": {…} }`.
- **Códigos de error nuevos:** `agent_timeout` (el plugin no confirmó el `user.message` en 10 s), `host_offline`,
  `timeout` (el host no respondió).
- **`agent.welcome`:** `pendingAnswers` son cuerpos de `prompt.answer` (`{ promptId, answer, deviceId }`, sin sobre) y se
  añade `relayId`. `lastSeq` es el último `seq` **persistido** del mismo `epoch` (null si el epoch cambió).
- **`app.welcome`:** se añaden `relayId`, `relayName`, `serverTime`. `MachineSummary` lleva `relayId`; `AgentSummary`, `kind`.
  `lastMessagePreview` puede ser `null` (en el canal `direct` siempre lo es).
- **`agent.history`:** puede incluir `truncated: true` si el historial no cabía en un frame de 1 MiB (se descartan los
  más antiguos). `liveFromSeq` es el último `seq` visto del agente.
- **`user.message` repetido** (mismo `clientMsgId`): el relay no lo reenvía; responde con el `user.message.ack` original.
- **Push:** el cuerpo de toda notificación incluye `pushId`; `push.notify` es `{ pushId, k, body }` y la app responde
  `push.ack { pushId }`. `k` admite además `test`. Las entregas del canal directo no acusadas se reenvían al reconectar.
- **Preferencias:** `PUT /v1/devices/me/prefs` acepta `criticalAlways: boolean` (las autorizaciones `danger=high`
  ignoran silencio y horas silenciosas) y `GET /v1/devices/me/prefs` las devuelve. Categorías: `permission`, `question`,
  `settled`, `error`, `terminal_wait`.
- **Adjuntos:** una PC sólo puede descargar (`GET /v1/blobs/{id}`) los adjuntos referenciados por mensajes que el relay
  le ha enrutado.
- **Relay ⇄ CLI:** `/admin/*` (token en `dataDir/admin.token`, sólo sin cabecera `X-Forwarded-For`) no forma parte del contrato.
- **Fixtures:** `packages/protocol/fixtures/<canal>__<tipo>__<etiqueta>.(valid|invalid).json`, con los canales
  `up`, `down`, `appUp`, `appDown`, `hostUp`, `hostDown` y `envelope`; `push-vector.json` es el vector de cifrado.

## 8. Push

Canales: **directo** (WS `mode=direct`, mensaje `push.notify { k, body }` con el mismo cuerpo descifrado que abajo, sin
cifrado adicional porque ya va por TLS a tu relay; la app responde `push.ack {pushId}`) y **FCM** (opcional, abajo).
El relay envía por todos los canales activos; la app deduplica por `promptId`/`pushId`.

### 8.1 FCM (opcional)

Mensaje **data-only**, `android.priority = "high"` para `prompt` y `"normal"` para el resto, `ttl` 1 h (prompt) / 10 min.
`collapse_key` = `promptId` / `agentId`.

```jsonc
// data (todos los valores string, límite FCM 4 KB)
{ "v":"1", "k":"prompt"|"cancel"|"settled"|"error"|"terminal_wait",
  "n": "<base64 nonce 12B>", "c": "<base64 AES-256-GCM(JSON del cuerpo, key=pushKey del dispositivo, aad='rp1')>" }
```
Cuerpo descifrado para `k=prompt`: `{ promptId, agentId, agentLabel, machineId, machineName, machineContext, kind, category, title, message (≤500 chars), options:[{id,label}] (≤3 para botones), allowFreeText, danger }`.
`questionnaire` nunca lleva botones: la notificación abre la hoja de respuesta.
Para `k=cancel`: `{ promptId }`. Para `k=settled`: `{ agentId, agentLabel, preview }`.
Si el cuerpo supera 3 KB se recorta `message`; la app siempre puede pedir el detalle por `GET /v1/prompts`.

## 9. rp-host (fase 3) — `wss://<relay>/ws/host`, auth `machineToken`

| Dirección | Tipo | Cuerpo |
|---|---|---|
| host → relay | `host.hello` | `{ machineId, hostname, roots:["/home/u/proyectos"], backends:{ herdr:"0.9.3"|null, tmux:"3.4"|null, wt:true|false, console:true|false }, defaultBackend:"herdr", launchers:["gentle-shell","pi"], defaultLauncher:"gentle-shell" }` |
| app → relay → host | `host.list_dirs` | `{ machineId, path }` → `host.dirs { path, dirs:[nombre…] }` (sólo dentro de `roots`) |
| app → relay → host | `host.herdr_layout` | `{ machineId }` → `host.herdr_layout.result { workspaces:[{id,label,cwd,tabs:[{id,label,panes:[{id,agent?}]}]}] }` |
| app → relay → host | `host.spawn` | `{ machineId, cwd, name?, launcher?, backend?: "herdr"|"tmux"|"wt"|"console", herdrTarget?: {type:"workspace"} | {type:"tab", workspaceId} | {type:"split", paneId, direction:"right"|"down"}, initialPrompt? }` → `host.spawned { spawnId, backend, herdr:{workspaceId,paneId}|null, tmuxSession|null }` o `error` |
| app → relay → host | `host.kill` | `{ machineId, spawnId }` (sólo agentes creados por el host) |
| relay → app | `hosts.update` | `{ upsert:[{machineId, hostname, roots, online}], remove:[machineId] }` |

`initialPrompt` lo retiene el relay hasta 60 s y lo entrega como `user.message` al primer `agent.hello` que traiga el mismo `spawnId`: rp-host lanza Pi con la variable de entorno
`RP_SPAWN_ID=<ulid>` (herdr/tmux) o con el flag `--rp-spawn-id <ulid>` (Windows Terminal/consola, que no pasan
variables de entorno; el plugin registra ese flag con `pi.registerFlag`) y el plugin lo incluye en `agent.hello` como
`"spawnId"` (campo opcional).
