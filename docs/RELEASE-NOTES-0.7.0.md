# Release Notes — Rp-relay v0.7.0

## Highlights

### Push para iOS por APNs, con el mismo sobre cifrado que FCM

Hasta ahora el relay sólo sabía hablar FCM, así que un iPhone no podía recibir notificaciones en segundo plano. Esta versión añade un emisor APNs propio: HTTP/2 contra Apple, con el mismo sobre opaco AES-256-GCM que ya se usa en Android, de modo que el contenido sigue cifrado de extremo a extremo y el relay nunca ve el texto claro.

- **Mismo sobre, otro transporte.** El payload APNs lleva el sobre cifrado tal cual (`{k,n,c}`, AES-256-GCM, nonce de 12 B, AAD `rp1`). La app lo descifra en su Notification Service Extension con la `pushKey` del Keychain compartido; el relay no necesita ninguna clave de la app.
- **Prioridad y agrupación.** El envío admite prioridad y `collapse-id` por canal; el `apns-collapse-id` se trunca de forma determinista como prefijo en un límite de punto de código, con un máximo de 64 B UTF-8, para no partir un carácter multibyte ni romper el límite de Apple.
- **Tokens por plataforma.** El registro de dispositivo pasa a distinguir plataforma: conviven `apnsToken` + `apnsEnvironment` y el `fcmToken` de Android, sin romper a los clientes actuales. Una asignación de token APNs sin entorno borra el entorno anterior, y `apnsToken:null` limpia ambos campos.
- **Validación estricta del token.** Un `apnsToken` presente y no vacío debe ser hexadecimal en minúsculas, de exactamente 64 caracteres (32 bytes, la forma nativa del device token de APNs), sin separadores; cualquier otra forma se rechaza con `400` antes de tocar la base. La cadena vacía limpia el token. El relay nunca decodifica ni transforma el valor: lo que recibe es lo que entrega a APNs.
- **Tokens inválidos.** Cuando Apple responde que un token ya no es válido, el relay lo limpia en lugar de reintentar contra un dispositivo fantasma.
- **Caché de la credencial del proveedor.** El JWT del proveedor APNs se cachea y se reutiliza hasta su expiración, en vez de firmarse en cada notificación.
- **Configuración.** Todo se activa por variables `RP_APNS_*`. La clave privada `.p8` la aporta el operador: no se incluye en el relay ni en esta entrega.

### Presupuesto de payload explícito por canal

Apple limita el payload completo a 4096 B y FCM a 4096 B de datos con su propio margen práctico. El relay no recorta a ciegas: ajusta con un orden fijo y documentado.

| Canal | Presupuesto del JSON | Presupuesto de cuerpo |
| --- | --- | --- |
| APNs | 4096 B | 2900 B |
| FCM | — | 3000 B (sin cambios) |

Orden de ajuste, idéntico en ambos canales:

1. se conserva `message`, luego hasta tres `options`, luego `title` (120 caracteres);
2. se recortan cadenas en el orden `detail`, `preview`, `agentLabel`, `machineContext`, `machineName` y después por clave ascendente;
3. como último recurso se eliminan campos opcionales en ese mismo orden y, si aún no cabe, por clave ascendente.

Ningún campo obligatorio se elimina y el resultado es determinista: el mismo contenido produce el mismo payload en cualquier ejecución.

### Sin cambios de contrato para Android

Esta versión es compatible hacia atrás con los clientes que ya hablan el contrato actual: `PushChannelReq` sigue aceptando `fcmToken` y el modo `direct`, y el envío APNs es opcional y sólo se activa cuando el operador lo configura. Una instalación que no toque `RP_APNS_*` se comporta exactamente como 0.6.1.

## Upgrade

```bash
# imagen de contenedor
docker pull ghcr.io/j3pf/rp-relay:0.7.0

# instalador nativo (usa el tarball adjunto a este release)
sudo ./deploy/install.sh --public-url https://relay.midominio.com

# o explícito
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.7.0/j3pf-rp-relay-0.7.0.tgz
sudo systemctl restart rp-relay
```

`deploy/install.sh` pasa a 0.7.0, así que `--version latest` resuelve al tarball de este release. No hay migraciones nuevas: el esquema sigue en `0005_agent_archive.sql`.

## Notas de actualización

- **Android no requiere nada.** Con o sin `RP_APNS_*`, los clientes Android siguen recibiendo por FCM o por el servicio directo, sin cambios de configuración ni de protocolo.
- **iOS necesita dos piezas más, además de este release:** la Notification Service Extension en la app (la que descifra el sobre) y la credencial APNs del relay (clave `.p8`, key id y team id) configurada en el servidor. Sin la credencial el relay no envía a iOS; sin la extensión el dispositivo recibe la notificación sin contenido descifrado.
- **Nada se despliega solo.** Este release no toca ninguna instalación en producción: la actualización del servidor es una acción manual del operador.

## Known limitations

- Los paquetes npm siguen sin publicarse (404). La imagen de ghcr y el tarball del GitHub Release son los únicos canales de entrega; `RP_PUBLISH_NPM` sigue sin definir y nada se publica al registro.
- La imagen Docker se publica sólo en ghcr; no hay espejo en Docker Hub.
- `npm audit` mantiene el aviso GHSA-86w9-cpqp-85rv (alto) en `node-forge` vía `acme-client` 5.4.0, sin parche upstream disponible; sólo aplica cuando se habilita el aprovisionamiento ACME de certificados.
