# Instalación y operación del relay

Guía completa para instalar `rp-relay` en un Ubuntu Server (22.04 / 24.04), configurarlo y mantenerlo.
Resumen de arquitectura en [PLAN-RELAY.md](PLAN-RELAY.md); contrato en [PROTOCOLO.md](PROTOCOLO.md).

## Requisitos

- Ubuntu Server 22.04 o 24.04 (cualquier Linux con Node ≥ 22 sirve), 1 vCPU / 1 GB de RAM son suficientes.
- Un nombre DNS apuntando al servidor (o Tailscale, opción C) y los puertos 80/443 abiertos para TLS.
- Opcional: un proyecto de Firebase si quieres FCM (ver §Firebase). **No es necesario**: el canal de push directo funciona sin Google.

## Opción A — nativa (recomendada)

Con el instalador (idempotente; vale también para actualizar):

```bash
sudo ./deploy/install.sh --public-url https://relay.midominio.com --caddy --name "Servidor casa"
```

O a mano:

```bash
# 1. Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential   # build-essential sólo si better-sqlite3 no trae binario para tu CPU
# 2. Usuario de servicio y paquete
sudo useradd --system --home /var/lib/rp-relay --shell /usr/sbin/nologin rp-relay
sudo npm install -g @j3pf/rp-relay
sudo rp-relay init --public-url https://relay.midominio.com        # crea /etc/rp-relay/config.json y la base de datos
sudo chown -R rp-relay:rp-relay /var/lib/rp-relay
# 3. systemd
sudo cp deploy/rp-relay.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now rp-relay
# 4. TLS con Caddy
sudo apt install -y caddy && sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
sudo ufw allow 80,443/tcp
```

El servicio es `Type=notify` con `WatchdogSec=30`: el relay notifica `READY=1` al escuchar y `WATCHDOG=1` cada 10 s (sólo
si la base de datos responde), y `Restart=always` lo levanta si falla. `NoNewPrivileges`, `ProtectSystem=strict`,
`ReadWritePaths=/var/lib/rp-relay` y `PrivateTmp` lo aíslan.

Después:

```bash
sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay doctor
sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay pair device     # QR → app RP
sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay pair machine --name "Portátil personal" --context personal
# en cada PC con Pi:  /rp pair https://relay.midominio.com <código>
```

> Atajo: `export RP_CONFIG=/etc/rp-relay/config.json` (y ejecuta el CLI con `sudo -E -u rp-relay`).

## Opción A2 — sin Caddy (TLS integrado)

En `config.json`:

```json
{
  "listen": { "host": "0.0.0.0", "port": 443, "httpPort": 80 },
  "publicUrl": "https://relay.midominio.com",
  "tls": { "acme": { "domain": "relay.midominio.com", "email": "tu@correo.com" } }
}
```

El relay obtiene el certificado de Let's Encrypt (desafío HTTP-01 por el puerto 80, que además redirige a HTTPS), lo guarda
en `dataDir/acme/` y lo renueva solo (se comprueba cada 12 h; se renueva a 30 días de caducar y se recarga en caliente).
Descomenta `AmbientCapabilities=CAP_NET_BIND_SERVICE` en el servicio. Con certificados propios:
`"tls": { "cert": "/ruta/fullchain.pem", "key": "/ruta/privkey.pem" }` (se relee cada 12 h).

## Opción B — Docker Compose

```bash
cd deploy && cp .env.example .env && $EDITOR .env      # RP_DOMAIN=relay.midominio.com
docker compose up -d
docker compose exec relay node dist/cli/index.js pair device
docker compose exec relay node dist/cli/index.js doctor
```

La imagen `ghcr.io/j3pf/rp-relay` guarda los datos en el volumen `rp-data` y se configura con variables `RP_*`
(`RP_PUBLIC_URL`, `RP_RELAY_NAME`, `RP_FCM_SERVICE_ACCOUNT_FILE`, `LOG_LEVEL`, …). Caddy se encarga del TLS.

## Opción C — sin dominio público (Tailscale)

`publicUrl = https://<host>.<tailnet>.ts.net`. TLS con `tailscale serve --bg 8787` (o `tailscale cert` + `tls.cert/key`).
El teléfono necesita Tailscale activo. FCM, si lo configuras, sigue funcionando (sale por Google).

## Configuración

`/etc/rp-relay/config.json` (cada clave puede sobrescribirse con `RP_*`; todas tienen valor por defecto):

| Clave | Por defecto | Variable | Descripción |
|---|---|---|---|
| `listen.host` / `listen.port` | `127.0.0.1` / `8787` | `RP_LISTEN_HOST` / `RP_LISTEN_PORT` | Dónde escucha. Detrás de proxy en loopback se confía en `X-Forwarded-For` |
| `listen.httpPort` | `80` | `RP_HTTP_PORT` | Puerto del desafío ACME |
| `publicUrl` | `http://127.0.0.1:8787` | `RP_PUBLIC_URL` | URL que verán app y plugins (QR de emparejamiento) |
| `dataDir` | `/var/lib/rp-relay` | `RP_DATA_DIR` | `relay.db`, `blobs/`, `backups/`, `admin.token`, `acme/` |
| `relayName` | `rp-relay` | `RP_RELAY_NAME` | Nombre mostrado en la app |
| `logLevel` | `info` | `LOG_LEVEL` | `trace` incluiría contenido; el resto sólo tamaños e ids |
| `trustProxy` | auto | `RP_TRUST_PROXY` | Confiar en `X-Forwarded-For` (auto si escucha en loopback) |
| `fcm.serviceAccountFile` | — | `RP_FCM_SERVICE_ACCOUNT_FILE` | Activa FCM (opcional) |
| `tls` | — | `RP_TLS_CERT`+`RP_TLS_KEY` / `RP_ACME_DOMAIN`+`RP_ACME_EMAIL` | TLS integrado |
| `backup` | `{enabled:true, intervalMinutes:60, keepDays:7}` | | Copias `VACUUM INTO` |
| `limits.blobMaxBytes` | 26214400 | | Tamaño máx. de un adjunto |
| `limits.blobTtlDays` | 7 | | Caducidad de adjuntos |
| `limits.eventRetentionDays` / `eventsPerAgent` | 7 / 5000 | | Retención del historial |
| `limits.offlineAgentRetentionDays` / `promptRetentionDays` | 7 / 30 | | Retención de agentes offline y prompts cerrados |
| `limits.promptGraceSeconds` | 120 | | Gracia antes de cancelar prompts de un agente desconectado |
| `limits.userMessageTimeoutMs` | 10000 | | Espera del `user.message.ack` del plugin |
| `limits.maxBufferedBytes` / `hardBufferedBytes` | 1 MiB / 16 MiB | | Contrapresión por cliente (descarta deltas / cierra con 1013) |
| `limits.pairAttemptsPerMinute` | 5 | | Intentos de emparejamiento por IP y minuto |

## Firebase (opcional: sólo mejora la batería del teléfono)

1. https://console.firebase.google.com → *Add project* (sin Analytics).
2. *Add app* → Android → package `dev.j3pf.rp` (debe coincidir con el `applicationId` de la app) → descarga
   `google-services.json` y colócalo en `rp-app/app/` (no se commitea).
3. *Project settings → Service accounts → Generate new private key* → cópialo a `/etc/rp-relay/firebase-sa.json`
   (`chmod 600`, dueño `rp-relay`) y añade `"fcm": { "serviceAccountFile": "/etc/rp-relay/firebase-sa.json" }`.
4. `rp-relay doctor` debe marcar FCM ✓ y `rp-relay push test` enviar por ambos canales.

El cuerpo de cada push se cifra con AES‑256‑GCM con una clave por dispositivo: Google sólo ve datos opacos.

## CLI de administración

| Comando | Acción |
|---|---|
| `rp-relay init` | Crea config, `dataDir`, DB y migra (interactivo o con flags `--yes --public-url … --name … --data-dir … --port … --fcm-file … --tls-cert/--tls-key | --acme-domain/--acme-email`) |
| `rp-relay serve` | Arranca el servidor (lo usa systemd) |
| `rp-relay pair device` | Código de 10 min + QR en la terminal: `rp://pair?u=<publicUrl>&c=<código>` |
| `rp-relay pair machine [--name N] [--context personal\|work]` | Código para una PC; en Pi: `/rp pair <publicUrl> <código>` |
| `rp-relay machines list \| set <id> --name/--context/--color \| revoke <id>` | Gestión de PCs (con el relay en marcha se difunde a las apps y se cortan las conexiones) |
| `rp-relay devices list \| revoke <id>` | Gestión de dispositivos |
| `rp-relay push test [deviceId]` | Notificación de prueba por los canales activos |
| `rp-relay backup now \| list` | Copia de seguridad inmediata / listado |
| `rp-relay restore <archivo> [--force]` | Verifica `PRAGMA integrity_check` y restaura (relay parado; la base anterior se conserva como `relay.db.pre-restore-…`) |
| `rp-relay migrate` | Migraciones (con copia previa) |
| `rp-relay doctor` | Config, permisos, DB, disco, copias, FCM, TLS, `publicUrl` alcanzable y reloj |

## Operación

- **Logs:** `journalctl -u rp-relay -f` (JSON de pino). Salud: `GET /healthz`.
- **Copias:** cada hora (`VACUUM INTO dataDir/backups/rp-AAAAMMDD-HHMMSS.db`, 7 días). Antes de cada migración sobre una base
  con datos se hace una copia adicional. Para réplica continua usa Litestream sobre `relay.db` (opcional).
  Restaurar: `systemctl stop rp-relay && rp-relay restore <archivo> && systemctl start rp-relay`.
- **Actualizar:** `sudo npm i -g @j3pf/rp-relay@latest && sudo systemctl restart rp-relay`. El cierre ordenado avisa a todos los
  clientes con `1012` y reconectan de inmediato; las migraciones se aplican al arrancar.
- **Revocar:** `rp-relay devices revoke <id>` / `machines revoke <id>` (o desde la app). Cortan las conexiones al instante.
- **Privacidad:** el relay nunca ejecuta nada en las PCs ni guarda credenciales de Pi. Los tokens sólo se guardan como SHA‑256.
