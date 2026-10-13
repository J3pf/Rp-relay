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
| WS apps | `wss://<relay>/ws/app` | app | Header `Authorization: Bearer <deviceToken>` |
| HTTP | `https://<relay>/v1/...` | ambos | `Authorization: Bearer <token>` |

- Frames de texto, **un objeto JSON por frame**, UTF‑8, máx. **1 MiB** (los adjuntos van por HTTP, no por WS).
- Keep‑alive: el relay envía ping WS cada 25 s; si no hay pong en 10 s cierra. Los clientes reconectan con
  backoff exponencial 1 s → 2 → 4 … máx. 30 s, con jitter ±20 %.
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
| `agentId` | `<piSessionId>~<instanceTag>` | plugin. `instanceTag` = 6 hex aleatorios por proceso para distinguir dos `pi` abiertos sobre la misma sesión |
| `promptId` | ULID | plugin |
| `blobId` | ULID | relay |
| `seq` | entero ≥1, por agente, monotónico | plugin (reinicia contador por `epoch`) |
| `epoch` | ULID | plugin, uno por conexión de sesión (cambia en `/new`, `/resume`, reload) |

## 4. Plugin → Relay (`/ws/agent`)

### `agent.hello` (primer mensaje obligatorio, espera `agent.welcome`)
```jsonc
{ "agentId":"…", "epoch":"…",
  "pi": { "version":"1.2.0", "mode":"tui" },        // ctx.mode
  "plugin": { "version":"0.1.0", "features":["mirror_ui","gate","ask_user","attachments"] },
  "session": { "id":"…", "file":"/home/u/.pi/agent/sessions/…jsonl", "name":"refactor auth" },
  "host": { "hostname":"devbox", "user":"jorge", "pid":4242, "os":"linux" },
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

### `prompt.open` (espera `ack`)
```jsonc
{ "promptId":"…", "agentId":"…",
  "kind":"confirm" | "select" | "input" | "multi" ,
  "category":"permission" | "question" | "dialog",   // gate propio | ask_user | espejo de otra extensión
  "title":"⚠ Comando peligroso",
  "message":"rm -rf build/",                          // opcional, texto plano
  "options":[ {"id":"0","label":"Permitir"}, {"id":"1","label":"Permitir siempre (sesión)"}, {"id":"2","label":"Denegar"} ],
  "allowFreeText": false, "placeholder": null,
  "tool": { "name":"bash", "args": { "command":"rm -rf build/" } },  // sólo category=permission
  "danger": "high",                                   // low | medium | high → prioridad de notificación
  "expiresAt": null }                                  // epoch ms o null (sin límite)
```
### `prompt.resolved` — `{ "promptId":"…", "by":"local"|"remote"|"timeout"|"cancelled", "answer": Answer|null }`
### `prompt.ack` — `{ "promptId":"…", "accepted": true }` (respuesta a `prompt.answer`; `false` si ya estaba resuelto/no existe)
### `user.message.ack` — `{ "clientMsgId":"…", "disposition":"sent"|"queued_steer"|"queued_followup"|"rejected", "error":null }`

## 5. Relay → Plugin

| Tipo | Cuerpo |
|---|---|
| `agent.welcome` | `{ "serverTime":…, "lastSeq":56 | null, "pendingAnswers":[prompt.answer…] }` (si `lastSeq` del mismo `epoch` < actual, el plugin no necesita reenviar; el snapshot se manda siempre) |
| `agent.resync` | `{}` → el plugin envía `agent.snapshot` |
| `user.message` | `{ "clientMsgId":"…", "deviceId":"…", "text":"…", "attachments":[{"blobId","name","mime","size"}], "delivery":"auto"|"steer"|"followUp" }` |
| `agent.abort` | `{}` → `ctx.abort()` |
| `prompt.answer` | `{ "promptId":"…", "answer": Answer, "deviceId":"…" }` |
| `prompt.cancel` | `{ "promptId":"…" }` (expirado por el relay) |

`Answer` = `{ "optionIds":["0"] }` | `{ "confirmed":true }` | `{ "text":"…" }` | `{ "cancelled":true }`.

## 6. App ⇄ Relay (`/ws/app`)

App → Relay:

| Tipo | Cuerpo | Respuesta |
|---|---|---|
| `app.hello` | `{ "deviceId", "app":{"version"}, "subscriptions":"all" }` | `app.welcome { agents:[AgentSummary], openPrompts:[Prompt] }` |
| `agent.subscribe` | `{ "agentId", "sinceSeq": 120 | null, "epoch": "…" | null }` | `agent.history { agentId, epoch, entries:[…], events:[…], liveFromSeq }` y luego eventos en vivo |
| `agent.unsubscribe` | `{ "agentId" }` | — |
| `user.message` | igual que §5 + `agentId` | `user.message.ack` (reenviado del plugin) o `error agent_offline` |
| `agent.abort` | `{ "agentId" }` | `ack` |
| `prompt.answer` | `{ "promptId", "answer" }` | `prompt.answer.result { ok, reason? }` (`reason`: `already_resolved` / `agent_offline_queued`) |
| `agent.forget` | `{ "agentId" }` (borrar agente offline de la lista) | `ack` |

Relay → App: `agents.update { upsert:[AgentSummary], remove:[agentId] }`, `agent.event { agentId, epoch, seq, e }`,
`prompt.opened { Prompt }`, `prompt.resolved { promptId, by, answer, byDeviceId? }`, `terminal_wait {agentId,…}`.

`AgentSummary` = `{ agentId, machineId, machineName, sessionName, cwd, gitBranch, model, status, online, lastSeenAt, openPromptCount, lastMessagePreview (≤140 chars) }`.

## 7. HTTP API (`/v1`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `POST` | `/v1/pair/device` | código | `{ code, name, fcmToken? }` → `{ deviceId, deviceToken, pushKey (base64 32 B), relayName }` |
| `POST` | `/v1/pair/machine` | código | `{ code, hostname }` → `{ machineId, machineToken }` |
| `POST` | `/v1/pair/codes` | device | crear código para emparejar una máquina desde la app → `{ code, expiresAt }` |
| `PUT` | `/v1/devices/me/push` | device | `{ fcmToken }` (onNewToken) |
| `POST` | `/v1/devices/me/push-test` | device | envía una notificación de prueba a este dispositivo |
| `GET` | `/v1/devices` / `DELETE /v1/devices/{id}` | device | listar / revocar |
| `GET` | `/v1/machines` / `DELETE /v1/machines/{id}` | device | listar / revocar |
| `GET` | `/v1/agents` | device | lista (fallback sin WS) |
| `GET` | `/v1/prompts?state=open` | device | preguntas abiertas |
| `POST` | `/v1/prompts/{id}/answer` | device | `{ answer }` → `200 {ok:true}` / `409 already_resolved` — **usado por los botones de la notificación** |
| `POST` | `/v1/agents/{id}/messages` | device | igual que `user.message` (para RemoteInput "responder" en notificación de agente terminado) |
| `POST` | `/v1/blobs` | device | multipart `file` (≤25 MiB) → `{ blobId, sha256, size, mime }` |
| `GET` | `/v1/blobs/{id}` | machine/device | descarga (TTL 7 días) |
| `GET` | `/healthz` | — | `{ ok, version, uptime }` |

## 8. Push (FCM)

Mensaje **data-only**, `android.priority = "high"` para `prompt` y `"normal"` para el resto, `ttl` 1 h (prompt) / 10 min.
`collapse_key` = `promptId` / `agentId`.

```jsonc
// data (todos los valores string, límite FCM 4 KB)
{ "v":"1", "k":"prompt"|"cancel"|"settled"|"error"|"terminal_wait",
  "n": "<base64 nonce 12B>", "c": "<base64 AES-256-GCM(JSON del cuerpo, key=pushKey del dispositivo, aad='rp1')>" }
```
Cuerpo descifrado para `k=prompt`: `{ promptId, agentId, agentLabel, kind, category, title, message (≤500 chars), options:[{id,label}] (≤3 para botones), allowFreeText, danger }`.
Para `k=cancel`: `{ promptId }`. Para `k=settled`: `{ agentId, agentLabel, preview }`.
Si el cuerpo supera 3 KB se recorta `message`; la app siempre puede pedir el detalle por `GET /v1/prompts`.

## 9. rp-host (fase 3) — `wss://<relay>/ws/host`, auth `machineToken`

| Dirección | Tipo | Cuerpo |
|---|---|---|
| host → relay | `host.hello` | `{ machineId, hostname, roots:["/home/u/proyectos"], tmux:"3.4", pi:"1.2.0" }` |
| app → relay → host | `host.list_dirs` | `{ machineId, path }` → `host.dirs { path, dirs:[nombre…] }` (sólo dentro de `roots`) |
| app → relay → host | `host.spawn` | `{ machineId, cwd, name?, initialPrompt? }` → `host.spawned { tmuxSession, pid }` o `error` |
| app → relay → host | `host.kill` | `{ machineId, tmuxSession }` (sólo sesiones `rp-*` creadas por el host) |
| relay → app | `hosts.update` | `{ upsert:[{machineId, hostname, roots, online}], remove:[machineId] }` |

`initialPrompt` lo retiene el relay hasta 60 s y lo entrega como `user.message` al primer `agent.hello` que traiga el mismo `spawnId`: rp-host lanza Pi con la variable de entorno
`RP_SPAWN_ID=<ulid>` y el plugin la incluye en `agent.hello` como `"spawnId"` (campo opcional).
