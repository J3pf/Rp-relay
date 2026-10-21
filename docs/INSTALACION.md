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
# El paquete no se publica en el registro público de npm; se instala el tarball oficial de GitHub Releases:
sudo npm install -g https://github.com/J3pf/Rp-relay/releases/download/v0.5.5/j3pf-rp-relay-0.5.5.tgz
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
- **Actualizar:** `sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.5.5/j3pf-rp-relay-0.5.5.tgz && sudo systemctl restart rp-relay`. El cierre ordenado avisa a todos los
  clientes con `1012` y reconectan de inmediato; las migraciones se aplican al arrancar.
- **Revocar:** `rp-relay devices revoke <id>` / `machines revoke <id>` (o desde la app). Cortan las conexiones al instante.
- **Privacidad:** el relay nunca ejecuta nada en las PCs ni guarda credenciales de Pi. Los tokens sólo se guardan como SHA‑256.

### Agent Mesh

Agent Mesh viene integrado en el relay y no requiere servicios externos. Usa la tabla `comms` de SQLite (`relay.db`), con retención automática de 7 días y un máximo de 20 000 filas; esta limpieza forma parte del ciclo de mantenimiento. La comunicación fluye por WebSocket (`/ws/app`, `/ws/agent`) y por la API REST (`/v1/mesh*`), lo que permite a la app Android mostrar la pantalla Mesh en tiempo real.

## Troubleshooting (Resolución de problemas)

### 1. Puerto en uso (`EADDRINUSE`)

**Síntoma:** El servicio no arranca y en los logs (`journalctl -u rp-relay -e`) aparece:
`listen EADDRINUSE: address already in use 127.0.0.1:8787` (o puerto `80`/`443`).

**Diagnóstico:**
```bash
# Identificar qué proceso está ocupando el puerto
sudo ss -tulpn | grep -E "8787|80|443"
# O con lsof:
sudo lsof -i :8787
```

**Solución:**
- Si quedó una instancia previa huérfana del relay:
  ```bash
  sudo systemctl restart rp-relay
  ```
- Si otro servicio del sistema utiliza el puerto `8787`, cambia el puerto de escucha del relay:
  1. En `/etc/rp-relay/config.json`: cambia `"listen": { "host": "127.0.0.1", "port": 8788 }`.
     *(O mediante la variable de entorno `RP_LISTEN_PORT=8788`).*
  2. Si usas Caddy como proxy inverso, ajusta `/etc/caddy/Caddyfile` para apuntar al nuevo puerto:
     `reverse_proxy 127.0.0.1:8788`
  3. Recarga y reinicia los servicios:
     ```bash
     sudo systemctl daemon-reload
     sudo systemctl restart rp-relay
     sudo systemctl reload caddy
     ```

---

### 2. Permisos del usuario `rp-relay` y rutas (`EACCES` / `EROFS`)

**Síntoma:** Errores al arrancar como `EACCES: permission denied, open '/var/lib/rp-relay/relay.db'` o avisos en `rp-relay doctor` indicando permisos laxos o inaccesibles en `admin.token` o directorios.

**Causa:** Archivos creados manualmente como `root` o permisos alterados tras copias/migraciones manuales.

**Solución:**
1. **Restablecer la propiedad de los datos al usuario del servicio:**
   ```bash
   sudo chown -R rp-relay:rp-relay /var/lib/rp-relay
   sudo chmod 750 /var/lib/rp-relay
   ```
2. **Asegurar el archivo de token administrativo (debe ser `600`):**
   ```bash
   sudo chmod 600 /var/lib/rp-relay/admin.token 2>/dev/null || true
   ```
3. **Verificar permisos del archivo de configuración (dueño `root:rp-relay`, permisos `640`):**
   ```bash
   sudo chown root:rp-relay /etc/rp-relay/config.json
   sudo chmod 640 /etc/rp-relay/config.json
   ```
4. **Aislamiento estricto en systemd (`ProtectSystem=strict`):**
   La unidad `deploy/rp-relay.service` aplica aislamiento del sistema de archivos. Sólo `/var/lib/rp-relay` tiene permisos de escritura. Si configuraste un `dataDir` personalizado en otra ruta, debes agregarla a `ReadWritePaths=` en `/etc/systemd/system/rp-relay.service`:
   ```ini
   ReadWritePaths=/var/lib/rp-relay /ruta/personalizada
   ```
   Y aplicar cambios: `sudo systemctl daemon-reload && sudo systemctl restart rp-relay`.

---

### 3. Problemas con certificados TLS / HTTPS / Caddy / Let's Encrypt

**Síntoma:** La app Android o el plugin no pueden conectar por HTTPS/WSS (`CERT_HAS_EXPIRED`, `ERR_CONNECTION_REFUSED`, `fetch failed`), o Caddy no emite el certificado.

**Diagnóstico:**
```bash
# Ver los logs del proxy Caddy
sudo journalctl -u caddy -e --no-pager
# Comprobar si Caddy o el relay escuchan en los puertos 80 y 443
sudo ss -tulpn | grep -E "80|443"
```

**Causas y soluciones comunes:**
1. **Desafío HTTP-01 bloqueado por firewall en puerto 80:**
   - Let's Encrypt requiere que el puerto `80/TCP` esté abierto y accesible desde internet para validar la propiedad del dominio (incluso si todo el tráfico final es HTTPS en el `443`).
   - Si tienes activo el firewall UFW:
     ```bash
     sudo ufw allow 80/tcp
     sudo ufw allow 443/tcp
     sudo ufw status
     ```
   - Si tu servidor está en una red local / NAT, verifica que en tu router los puertos 80 y 443 externos estén redirigidos a la IP local del servidor.
   - Si tu ISP residencial bloquea el puerto 80, utiliza la **Opción C (Tailscale)** o certificados con desafío DNS-01 en Caddy.
2. **Registro DNS no apunta a la IP pública actual:**
   - Verifica con `dig +short relay.midominio.com` o `nslookup relay.midominio.com` que el registro `A` resuelve a tu IP pública.
3. **Modo TLS integrado (Opción A2 sin Caddy) en puertos privilegiados (<1024):**
   - En Linux, un proceso sin privilegios de root (`rp-relay`) no puede enlazar los puertos 80 y 443 a menos que cuente con capacidades del kernel.
   - En `/etc/systemd/system/rp-relay.service`, descomenta las líneas:
     ```ini
     AmbientCapabilities=CAP_NET_BIND_SERVICE
     CapabilityBoundingSet=CAP_NET_BIND_SERVICE
     ```
   - Aplica los cambios: `sudo systemctl daemon-reload && sudo systemctl restart rp-relay`.

---

### 4. Base de datos SQLite: Locks, WAL y verificación de integridad

**Síntoma:** Error `SqliteError: database is locked` o `SQLITE_BUSY`, o fallos de lectura/escritura.

**Causa:**
- `rp-relay` utiliza SQLite en modo **WAL** (`Write-Ahead Logging`), creando `relay.db-wal` y `relay.db-shm` en `/var/lib/rp-relay/`.
- Si el usuario `rp-relay` no tiene permisos para crear archivos en el directorio contenedor, o si un proceso externo (por ejemplo un CLI ejecutado como otro usuario) bloqueó la base.

**Solución:**
1. **Garantizar permisos de escritura en el directorio contenedor:**
   SQLite necesita crear archivos temporales auxiliares junto a `relay.db`. Si el directorio no tiene permisos de escritura para `rp-relay`, fallará con `database is locked`.
   ```bash
   sudo chown -R rp-relay:rp-relay /var/lib/rp-relay
   sudo chmod 750 /var/lib/rp-relay
   ```
2. **Verificar integridad física de la base de datos:**
   ```bash
   sudo -u rp-relay sqlite3 /var/lib/rp-relay/relay.db "PRAGMA integrity_check;"
   # Debe responder exactamente: ok
   ```
3. **Identificar procesos bloqueantes:**
   ```bash
   sudo fuser -v /var/lib/rp-relay/relay.db
   ```
4. **Restaurar una copia de seguridad si hubiese corrupción:**
   `rp-relay` crea copias automáticas con `VACUUM INTO` cada hora en `/var/lib/rp-relay/backups/`. Para restaurar:
   ```bash
   # Listar copias disponibles
   sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay backup list

   # Detener el servicio antes de restaurar
   sudo systemctl stop rp-relay

   # Restaurar la copia verificada
   sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay restore /var/lib/rp-relay/backups/rp-YYYYMMDD-HHMMSS.db

   # Iniciar el servicio
   sudo systemctl start rp-relay
   ```
   *(La base anterior queda siempre respaldada como `relay.db.pre-restore-TIMESTAMP`).*

---

### 5. Timeout o fallos en el emparejamiento (`pair device` / `pair machine`)

**Síntoma:** La app Android muestra "Código inválido o expirado" o Pi indica error al ejecutar `/rp pair`.

**Causas y soluciones:**
1. **Código expirado (validez de 10 minutos y un solo uso):**
   - Los códigos generados tienen una validez de 10 minutos. Si expiran, genera uno nuevo:
     ```bash
     sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay pair device
     # o para máquina:
     sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay pair machine --name "Mi PC" --context personal
     ```
2. **Límite de tasa por IP (`rate limiting`):**
   - Por seguridad contra fuerza bruta, el relay limita los intentos a **5 emparejamientos por minuto por IP** (`limits.pairAttemptsPerMinute`). Si se excede, el relay responde `HTTP 429`. Espera 60 segundos antes de reintentar.
3. **Desincronización de reloj del servidor (NTP):**
   - Los códigos y tokens dependen de timestamps UTC. Un desfase de reloj puede invalidar los códigos inmediatamente.
   - Ejecuta `rp-relay doctor` para verificar el desfase:
     ```bash
     sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay doctor
     ```
   - Si indica desfase, sincroniza con `systemd-timesyncd`:
     ```bash
     sudo timedatectl set-ntp on
     sudo timedatectl status
     ```
4. **URL pública inalcanzable (`publicUrl`):**
   - El código QR contiene la `publicUrl` configurada en `/etc/rp-relay/config.json`.
   - Si se configuró como `http://127.0.0.1:8787`, el teléfono móvil no podrá conectar porque intentará comunicarse consigo mismo.
   - La `publicUrl` debe ser el dominio público (ej. `https://relay.tudominio.com`) o la dirección Tailscale accesible desde el móvil.
   - Corrige el valor en `/etc/rp-relay/config.json` y reinicia el relay: `sudo systemctl restart rp-relay`.

---

### 6. Diagnóstico integrado con `rp-relay doctor`

Ante cualquier duda o incidente, ejecuta la herramienta de diagnóstico integrada:

```bash
sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay doctor
```

El asistente evaluará automáticamente:
- ✓ Versión del runtime de Node.js (requiere Node ≥ 22).
- ✓ Lectura y sintaxis de `/etc/rp-relay/config.json`.
- ✓ Directorio de datos y permisos seguros de `admin.token` (`600`).
- ✓ Integridad física y versión del esquema de `relay.db`.
- ✓ Espacio libre en disco.
- ✓ Estado y presencia de copias de seguridad horarias.
- ✓ Configuración de Firebase Cloud Messaging (si está activo).
- ✓ Accesibilidad y latencia hacia la `publicUrl`.
- ✓ Sincronización del reloj del sistema contra el servidor HTTP.

