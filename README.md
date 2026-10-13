# rp-relay

Relay autoalojable (Ubuntu Server) que conecta tus agentes [Pi](https://github.com/earendil-works/pi) con la app Android
**RP**: lista de agentes en vivo, chat, adjuntos y **notificaciones push de preguntas/autorizaciones respondibles desde el móvil**.

> Estado: **implementado** (v0.1.0): relay completo (R0–R16 del [plan](docs/PLAN-RELAY.md)). Faltan por construir `rp-plugin` y `rp-app`,
> y confirmar en un servidor real los puntos marcados «a confirmar» (Caddy, proxy de la empresa, FCM).

| Documento | Contenido |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Visión global de los tres componentes, decisiones, hechos verificados de Pi, fases, riesgos |
| [docs/RESILIENCIA.md](docs/RESILIENCIA.md) | Escalabilidad, resiliencia e independencia total (push sin Google, entrega interactiva sin herdr, Linux/Windows) |
| [docs/COMPATIBILIDAD.md](docs/COMPATIBILIDAD.md) | herdr, gentle-ai, gentle-shell/gentle-pi y separación por PC: hechos verificados y matriz requisito × entorno |
| [docs/PROTOCOLO.md](docs/PROTOCOLO.md) | **Contrato** de red Plugin ⇄ Relay ⇄ App (WS, HTTP, push) |
| [docs/PLAN-RELAY.md](docs/PLAN-RELAY.md) | Plan detallado del relay: stack, datos, lógica, instalación en Ubuntu, Firebase, tests, tareas (con estado) y notas de implementación |
| [docs/INSTALACION.md](docs/INSTALACION.md) | Instalación (nativa, TLS integrado, Docker, Tailscale), configuración, Firebase, CLI y operación |

Repos hermanos: [`rp-plugin`](https://github.com/j3pf/rp-plugin) (extensión de Pi) · [`rp-app`](https://github.com/j3pf/rp-app) (Android).

## Inicio rápido

```bash
npm ci && npm run build
node dist/cli/index.js init --config ./config.json --data-dir ./data --public-url http://127.0.0.1:8787 --yes
RP_CONFIG=./config.json node dist/cli/index.js serve          # en otra terminal:
RP_CONFIG=./config.json node dist/cli/index.js pair device    # QR para la app
RP_CONFIG=./config.json node dist/cli/index.js doctor
```

Instalación en producción (systemd + Caddy, TLS integrado o Docker): [docs/INSTALACION.md](docs/INSTALACION.md).

## Desarrollo

| Comando | Qué hace |
|---|---|
| `npm run check` | lint (biome) + tipos + todas las pruebas |
| `npm test` | vitest: contrato (fixtures), integración con servidor y clientes `ws` reales, resiliencia, CLI, humo de carga |
| `npm run test:load` | carga completa en un proceso aparte (50 agentes × 20 ev/s × 5 min; `-- --duration 20` para una pasada corta) |
| `npm run dev` | `rp-relay serve` con `tsx` |

Estructura: `packages/protocol` (esquemas TypeBox + fixtures, publicado como `@j3pf/rp-protocol`), `src/` (db, auth, ws, domain, push, blobs, http, cli, backup, tls),
`migrations/`, `deploy/` (systemd, Caddy, Docker Compose, `install.sh`), `spikes/`, `test/`.

## Referencias investigadas

- Pi (`earendil-works/pi`, v1.2.0): `packages/coding-agent/docs/{extensions,packages,rpc,rpc-extension-ui,json,security,sessions}.md`,
  `src/core/extensions/{types,runner}.ts`, `src/modes/{interactive/interactive-mode,rpc/rpc-mode}.ts`,
  ejemplos `permission-gate.ts`, `question.ts`, `notify.ts`, `send-user-message.ts`.
- [Remote Pi](https://github.com/jacobaraujo7/remote_pi) (Flutter + relay Rust + extensión Pi): emparejamiento QR, aprobaciones vía
  `@eko24ive/pi-ask`; **sin push real** — es la principal carencia que este proyecto cubre.
- [Happy](https://github.com/slopus/happy) / Happier (happier-dev): wrapper de CLI + servidor Fastify/Socket.IO con cifrado E2E.
- [Moshi](https://getmoshi.app/docs): terminal móvil + hook en el host que genera bandeja de aprobaciones y push.
- [gentle-shell / gentle-pi](https://github.com/Gentleman-Programming/gentle-shell) 4.1.0, [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), [herdr](https://github.com/herdrdev/herdr) 0.9.3: entorno del usuario, ver `docs/COMPATIBILIDAD.md`.
