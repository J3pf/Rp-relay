# Release Notes — Rp-relay v0.8.5

## Highlights

### Sincronización de Historial y Reconexiones
- **Sin pérdida de mensajes tras reconexiones WS (`HistoryService.build`)**: `canResume` ahora valida `sinceSeq >= snapMeta.seq` y usa el `latestSeq` en vivo (`Math.max(a.last_seq, hub.agents.get(agentId)?.lastSeq ?? 0)`), asegurando que cuando un agente reconecta y sube un `agent.snapshot` más reciente, los clientes que reabren el chat reciban el snapshot completo en lugar de saltar mensajes intermedios.
- **Push de `agent.history` en `onSnapshot`**: Cuando llega un snapshot nuevo para un agente con chats abiertos en primer plano (`hub.subscribers(agentId)`), el relay envía el historial actualizado en vivo a esos suscriptores además de actualizar la vista previa del Home.

## Upgrade

```bash
# imagen de contenedor
docker pull ghcr.io/j3pf/rp-relay:0.8.5

# instalador nativo (usa el tarball adjunto a este release)
sudo ./deploy/install.sh --public-url https://relay.midominio.com

# o explícito
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.8.5/j3pf-rp-relay-0.8.5.tgz
sudo systemctl restart rp-relay
```

## Compatibilidad y Requisitos

- **Rp-app >= 0.9.7** recomendado para emparejar la recuperación completa tras huecos de `seq`, persistencia Room sin borrado del último evento y animaciones de bajo consumo en cards.
- **Rp-plugin >= 0.4.7** recomendado para soporte bidireccional de `ask_question` en `agy` y optimizaciones del puente.
