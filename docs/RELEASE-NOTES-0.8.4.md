# Release Notes — Rp-relay v0.8.4

## Highlights

### Rendimiento, Batería y Escalabilidad
- **Coalescencia directa y `app.state`**: Soporte para señalización de estado de pantalla (`app.state`) desde la app móvil, coalescencia de actualizaciones cosméticas cuando la pantalla está apagada, eliminación de eventos `prompt.opened` redundantes en canal directo y cadencia de heartbeats alineada para reducir despertares de radio.
- **Malla pre-serializada e incremental**: `MeshService` pre-serializa mensajes compartidos y envía deltas incrementales en lugar de retransmitir snapshots completos en cada cambio.
- **SQLite, historial en streaming y backups asíncronos**: Backups asíncronos sin bloquear el event loop, lectura en streaming para historiales largos, throttling de escrituras `setSeq` con flush inmediato en `agent_settled` e índices SQLite optimizados.

### Endurecimiento, Estabilidad y Refactorización (4R)
- **Cierre ordenado HTTP y long-poll abortado (Node 22+)**: Activa `forceCloseConnections: true` en Fastify para cerrar sockets HTTP residuales durante el apagado del relay y evita responder sobre sockets ya cerrados cuando un cliente aborta `POST /v1/agent/poll`.
- **WebSockets, HTTP y long-poll**: Validación defensiva de URLs de upgrade WS, resolución segura de IPs detrás de proxy, control de backpressure y aborto limpio de conexiones long-poll.
- **Almacenamiento, TLS, APNs y dominio**: Backups/restauraciones y ACME atómicos, cuota de blobs aplicada, aislamiento del ciclo de vida de streams APNs, cierre de fugas de redacción/revocación y descomposición modular de rutas críticas.

## Upgrade

```bash
# imagen de contenedor
docker pull ghcr.io/j3pf/rp-relay:0.8.4

# instalador nativo (usa el tarball adjunto a este release)
sudo ./deploy/install.sh --public-url https://relay.midominio.com

# o explícito
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.8.4/j3pf-rp-relay-0.8.4.tgz
sudo systemctl restart rp-relay
```

## Compatibilidad y Requisitos

- **Rp-app >= 0.9.6** recomendado para aprovechar `app.state`, ahorro de batería, vista previa/recorte/rotación de fotos y miniaturas en burbujas.
- **Rp-plugin >= 0.4.7** recomendado para optimizaciones de puente/keepalive y soporte bidireccional de `ask_question` en `agy`.
