# rp-relay

Relay autoalojable (Ubuntu Server) que conecta tus agentes [Pi](https://github.com/earendil-works/pi) con la app Android
**RP**: lista de agentes en vivo, chat, adjuntos y **notificaciones push de preguntas/autorizaciones respondibles desde el móvil**.

> Estado: **planeación**. Todavía no hay código.

| Documento | Contenido |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Visión global de los tres componentes, decisiones, hechos verificados de Pi, fases, riesgos |
| [docs/COMPATIBILIDAD.md](docs/COMPATIBILIDAD.md) | herdr, gentle-ai, gentle-shell/gentle-pi y separación por PC: hechos verificados y matriz requisito × entorno |
| [docs/PROTOCOLO.md](docs/PROTOCOLO.md) | **Contrato** de red Plugin ⇄ Relay ⇄ App (WS, HTTP, push) |
| [docs/PLAN-RELAY.md](docs/PLAN-RELAY.md) | Plan detallado del relay: stack, datos, lógica, instalación en Ubuntu, Firebase, tests, tareas |

Repos hermanos: [`rp-plugin`](https://github.com/j3pf/rp-plugin) (extensión de Pi) · [`rp-app`](https://github.com/j3pf/rp-app) (Android).

## Referencias investigadas

- Pi (`earendil-works/pi`, v1.2.0): `packages/coding-agent/docs/{extensions,packages,rpc,rpc-extension-ui,json,security,sessions}.md`,
  `src/core/extensions/{types,runner}.ts`, `src/modes/{interactive/interactive-mode,rpc/rpc-mode}.ts`,
  ejemplos `permission-gate.ts`, `question.ts`, `notify.ts`, `send-user-message.ts`.
- [Remote Pi](https://github.com/jacobaraujo7/remote_pi) (Flutter + relay Rust + extensión Pi): emparejamiento QR, aprobaciones vía
  `@eko24ive/pi-ask`; **sin push real** — es la principal carencia que este proyecto cubre.
- [Happy](https://github.com/slopus/happy) / Happier (happier-dev): wrapper de CLI + servidor Fastify/Socket.IO con cifrado E2E.
- [Moshi](https://getmoshi.app/docs): terminal móvil + hook en el host que genera bandeja de aprobaciones y push.
- [gentle-shell / gentle-pi](https://github.com/Gentleman-Programming/gentle-shell) 4.1.0, [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), [herdr](https://github.com/herdrdev/herdr) 0.9.3: entorno del usuario, ver `docs/COMPATIBILIDAD.md`.
