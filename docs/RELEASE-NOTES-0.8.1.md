# Release Notes — Rp-relay v0.8.1

## Highlights

### Reintentos reales de mensajes rechazados
- **`MessageService.onAck`**: Ya no cachea en memoria (`this.done`) los ACKs con `disposition: "rejected"` o `error`, de modo que cuando el usuario toca **Reintentar** en la app móvil reutilizando el mismo `clientMsgId`, el relay reenvía el mensaje al host/agente en lugar de devolver el rechazo anterior cacheado.

### Protocolo: estado `done` y uso de contexto
- **`AgentStatus`**: Incorpora el estado `"done"` en `@j3pf/rp-protocol`.
- **`AgentSummary`**: Incorpora los campos opcionales `contextTokens`, `contextWindow` y `contextPercent` para mostrar el porcentaje y uso de tokens en la app móvil.

## Upgrade

```bash
# imagen de contenedor
docker pull ghcr.io/j3pf/rp-relay:0.8.1

# instalador nativo (usa el tarball adjunto a este release)
sudo ./deploy/install.sh --public-url https://relay.midominio.com

# o explícito
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.8.1/j3pf-rp-relay-0.8.1.tgz
sudo systemctl restart rp-relay
```

## Compatibilidad y Requisitos

- **Rp-app >= 0.9.0** recomendado para visualizar el estado `done` y la telemetría de contexto.
- **Rp-plugin >= 0.4.0** para el envío de métricas de contexto y manejo de `done`.
