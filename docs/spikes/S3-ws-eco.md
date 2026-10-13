# Spike S3 — WebSocket con auth Bearer detrás de Caddy (tarea R0)

**Objetivo:** comprobar, antes de depender de él, que un WebSocket autenticado con `Authorization: Bearer` atraviesa
Caddy (y el proxy de la PC de empresa) con TLS, que `Upgrade` funciona, que los *ping/pong* mantienen la conexión y que
el código de cierre propio `4001` llega al cliente.

Código: [`spikes/s3-echo.ts`](../../spikes/s3-echo.ts) (Fastify + `ws` en modo `noServer`, el mismo patrón que usa el
relay) y su prueba automática `test/spike-s3.test.ts` (eco con token correcto, `4001` con token incorrecto).

## Pasos

1. En el servidor Ubuntu: `npx tsx spikes/s3-echo.ts --port 8788 --token secreto`
2. `Caddyfile`:
   ```
   relay.midominio.com {
     reverse_proxy 127.0.0.1:8788
   }
   ```
3. Desde cada entorno (PC personal Linux, PC de empresa Windows, teléfono con datos móviles):
   ```
   npx wscat -c wss://relay.midominio.com/ws/echo -H "Authorization: Bearer secreto"
   ```
   - Debe llegar `{"t":"hello",…}` y cada línea escrita volver como eco.
   - Con token erróneo: cierre con código `4001`.
   - Dejar abierto 5 minutos sin tráfico: la conexión no debe caer (el relay real envía ping WS cada 25 s).
4. En la PC de empresa, repetir con `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` si hay proxy. Si el `Upgrade` se bloquea,
   anotarlo: el plugin usará el transporte long-poll (`/v1/agent/send` + `/v1/agent/poll`, R13), ya implementado.

## Resultado

| Comprobación | Estado |
|---|---|
| Eco + auth Bearer en local (prueba automática) | ✅ |
| `4001` visible para el cliente | ✅ |
| Atraviesa Caddy con TLS | a confirmar en el servidor real (pasos 2–3) |
| Atraviesa el proxy de la empresa | a confirmar en la PC Windows (spike S6) |
