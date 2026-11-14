# Release Notes — Rp-relay v0.8.2

## Highlights

### Privacidad (`redacted`) y Seguridad HTTP/WS/CLI
- **Enmascarado completo para sesiones `redacted`**: `Summaries.agent()`, `Summaries.archived()`, `AgentService` y `PushDispatcher` (FCM, APNs y canal directo) suprimen `lastMessagePreview`, `activeTask`, mensajes de prompt, opciones y detalles de error cuando `agent.redacted === 1`, enviando `redacted: true`.
- **Límites de autenticación y proxy**: `trustProxy` se acota a loopback salvo proxies locales, `POST /v1/pair/codes` aplica rate-limiting y tope por `kind`, las rutas `/admin` fallan cerradas sin `remoteAddress`, y el store de blobs sanea MIME y acota el espacio total.
- **Restauración atómica (`rp-relay restore`)**: Propaga timeouts/errores de `/admin` salvo que se pase `--force` explícito y restaura sobre archivo temporal con permisos `0o600` antes del reemplazo atómico y limpieza de WAL/SHM.

### Resiliencia APNs, WebSockets y Dominio
- **Pooling HTTP/2 y observabilidad APNs**: `ApnsHttp2Client` reutiliza sesiones HTTP/2 por host de Apple, valida la firma `.p8` al iniciar el relay, cierra sesiones ordenadamente en `Relay.stop()` y reporta su estado en `admin/status`, `doctor`, `devices list` y `push test`.
- **Limpieza inmediata de estado en desconexión/archivo**: Prompts en estado `'answered'`, waiters de `MessageService`, RPCs de `HostService` y conexiones `AgentConn` archivadas o reemplazadas se limpian de inmediato, eliminando locks de `LongPollConn.waiter` y duplicados en `push_outbox`.
- **Protocolo y rendimiento**: Incorpora `"done"` en `AGENT_STATUSES`, poda transaccional en `EventsRepo.prune()` y proyección unificada `buildCommView` en malla.

## Upgrade

```bash
# imagen de contenedor
docker pull ghcr.io/j3pf/rp-relay:0.8.2

# instalador nativo (usa el tarball adjunto a este release)
sudo ./deploy/install.sh --public-url https://relay.midominio.com

# o explícito
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.8.2/j3pf-rp-relay-0.8.2.tgz
sudo systemctl restart rp-relay
```

## Compatibilidad y Requisitos

- **Rp-app >= 0.9.2** recomendado para aprovechar toda la paridad de estado, privacidad y reintentos.
- **Rp-plugin >= 0.4.2** recomendado para sincronización `model_select`, estado `done` y entregas serializadas.
