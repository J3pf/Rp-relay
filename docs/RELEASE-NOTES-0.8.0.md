# Release Notes — Rp-relay v0.8.0

## Highlights

### Telemetría de activeTask y estado Git sucio (`*`) en AgentSummary

El protocolo y el publicador de eventos ahora exponen la tarea activa del agente (`activeTask` proveniente de `toolSummary`) y el indicador de cambios sin commitear en Git (`gitDirty`), enriqueciendo la supervisión en vivo tanto en la app móvil como en las notificaciones del sistema.

- **`activeTask` en `AgentSummary`**: Se propaga dinámicamente en `agents.update` y en la lista de bienvenida (`app.welcome`), permitiendo que el cliente móvil conozca qué comando o herramienta específica está ejecutando el agente en cada momento.
- **Preservación de preview en canal directo**: El publicador de push (`Publisher.ts`) conserva `lastMessagePreview` y `activeTask` cuando el agente se encuentra en estado `working` o `compacting`, garantizando que la notificación Live Activity cuente con contexto completo.

### Optimización de batería: Heartbeat de 240s y deduplicación en push directo

- **Heartbeat adaptado**: El intervalo de ping/keepalive para conexiones de push en segundo plano (`mode: direct`) se elevó a 240 segundos, reduciendo drásticamente los wakeups de radio celular y el consumo de batería en reposo.
- **Deduplicación de `agents.update`**: Se eliden retransmisiones redundantes en el canal directo si la firma del agente (estado, activeTask, sesión) no ha cambiado respecto a la última entrega.

### Gestión segura de sesiones Herdr concurrentes

- **Prevención de cierres accidentales**: Si múltiples agentes comparten un mismo pane de Herdr o se transiciona de sesión, el relay evita enviar `herdr_close` destructivos que interrumpan al agente en línea superviviente.

## Upgrade

```bash
# imagen de contenedor
docker pull ghcr.io/j3pf/rp-relay:0.8.0

# instalador nativo (usa el tarball adjunto a este release)
sudo ./deploy/install.sh --public-url https://relay.midominio.com

# o explícito
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.8.0/j3pf-rp-relay-0.8.0.tgz
sudo systemctl restart rp-relay
```

## Compatibilidad y Requisitos

- **Rp-app >= 0.8.0** recomendado para aprovechar la visualización de `activeTask` y las notificaciones Live Activity (`ProgressStyle`).
- **Rp-plugin >= 0.4.0** para la transmisión continua de telemetría de herramientas y estado Git.
