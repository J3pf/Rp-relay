#!/usr/bin/env bash
# Instalador nativo de rp-relay para Ubuntu Server 22.04 / 24.04 (Opción A / A2).
#
#   sudo ./install.sh --public-url https://relay.midominio.com [--caddy] [--name "Servidor casa"]
#                     [--version 0.5.4] [--from ./j3pf-rp-relay-0.5.4.tgz] [--port 8787]
#
# Es idempotente: se puede volver a ejecutar para actualizar. No toca config.json si ya existe.
set -euo pipefail

PUBLIC_URL=""
NAME="Servidor casa"
VERSION="latest"
FROM=""
PORT=8787
CADDY=0
NODE_MAJOR=22
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }
log() { echo -e "\033[1;32m==>\033[0m $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --caddy) CADDY=1; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) die "opción desconocida: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "ejecuta con sudo"
[[ -n "$PUBLIC_URL" ]] || die "falta --public-url (p. ej. https://relay.midominio.com)"

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" || "${ID_LIKE:-}" == *debian* ]] || echo "aviso: sistema no probado (${PRETTY_NAME:-desconocido}); se continúa"
fi

# 1. Node.js 22 LTS
need_node=1
if command -v node >/dev/null 2>&1; then
  current="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$current" -ge "$NODE_MAJOR" ]] && need_node=0
fi
if [[ $need_node -eq 1 ]]; then
  log "Instalando Node.js ${NODE_MAJOR} (NodeSource)"
  apt-get update -y
  apt-get install -y curl ca-certificates
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
# build-essential sólo hace falta si better-sqlite3 no tiene binario precompilado para tu arquitectura
apt-get install -y build-essential python3 >/dev/null

# 2. Usuario de servicio
if ! id rp-relay >/dev/null 2>&1; then
  log "Creando el usuario de servicio rp-relay"
  useradd --system --home /var/lib/rp-relay --shell /usr/sbin/nologin rp-relay
fi
install -d -o rp-relay -g rp-relay -m 750 /var/lib/rp-relay
install -d -o root -g rp-relay -m 750 /etc/rp-relay

# 3. Paquete
if [[ -z "$FROM" ]]; then
  TAG="${VERSION}"
  if [[ "$TAG" == "latest" || "$TAG" == "0.5.4" || "$TAG" == "v0.5.4" ]]; then
    FROM="https://github.com/J3pf/Rp-relay/releases/download/v0.5.4/j3pf-rp-relay-0.5.4.tgz"
  else
    V_NUM="${TAG#v}"
    FROM="https://github.com/J3pf/Rp-relay/releases/download/v${V_NUM}/j3pf-rp-relay-${V_NUM}.tgz"
  fi
  log "Instalando rp-relay desde GitHub Releases (${FROM})"
else
  log "Instalando rp-relay desde $FROM"
fi
npm install -g "$FROM"
command -v rp-relay >/dev/null || die "rp-relay no quedó en el PATH"
RP_BIN="$(command -v rp-relay)"
if [[ "$RP_BIN" != "/usr/bin/rp-relay" ]]; then
  ln -sf "$RP_BIN" /usr/bin/rp-relay 2>/dev/null || echo "aviso: rp-relay está en $RP_BIN; ajusta ExecStart en el servicio si no existe /usr/bin/rp-relay"
fi

# 4. Configuración y base de datos
if [[ ! -f /etc/rp-relay/config.json ]]; then
  log "Creando /etc/rp-relay/config.json"
  rp-relay init --yes --config /etc/rp-relay/config.json --public-url "$PUBLIC_URL" --name "$NAME" \
    --data-dir /var/lib/rp-relay --port "$PORT"
else
  log "config.json ya existe: se conserva"
  RP_CONFIG=/etc/rp-relay/config.json rp-relay migrate
fi
chown -R rp-relay:rp-relay /var/lib/rp-relay
chown root:rp-relay /etc/rp-relay/config.json
chmod 640 /etc/rp-relay/config.json

# 5. systemd
log "Instalando el servicio systemd"
PKG_DIR="$(npm root -g)/@j3pf/rp-relay"
UNIT="$DEPLOY_DIR/rp-relay.service"
[[ -f "$UNIT" ]] || UNIT="$PKG_DIR/deploy/rp-relay.service"
install -m 644 "$UNIT" /etc/systemd/system/rp-relay.service
systemctl daemon-reload
systemctl enable rp-relay
systemctl restart rp-relay

# 6. Caddy (TLS automático) — opcional
if [[ $CADDY -eq 1 ]]; then
  DOMAIN="${PUBLIC_URL#*://}"; DOMAIN="${DOMAIN%%/*}"; DOMAIN="${DOMAIN%%:*}"
  log "Instalando Caddy para $DOMAIN"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gpg
  if [[ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
  fi
  apt-get install -y caddy
  sed "s/relay.midominio.com/${DOMAIN}/; s/127.0.0.1:8787/127.0.0.1:${PORT}/" "$DEPLOY_DIR/Caddyfile" > /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80,443/tcp
  fi
fi

# 7. Verificación
sleep 2
log "Diagnóstico"
RP_CONFIG=/etc/rp-relay/config.json rp-relay doctor || true
cat <<MSG

Listo. Siguientes pasos:
  sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay pair device     # QR para la app RP
  sudo -u rp-relay RP_CONFIG=/etc/rp-relay/config.json rp-relay pair machine    # y en cada PC: /rp pair <url> <código>
  journalctl -u rp-relay -f
MSG
