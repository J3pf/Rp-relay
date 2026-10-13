# Fixtures de contrato

Cada archivo es un **sobre completo** (PROTOCOLO §2). El nombre indica canal, tipo y validez:

```
<canal>__<t>__<etiqueta>.valid.json     debe validar
<canal>__<t>__<etiqueta>.invalid.json   debe ser rechazado
```

Canales: `up` (plugin → relay), `down` (relay → plugin), `appUp` (app → relay), `appDown` (relay → app),
`hostUp` (rp-host → relay), `hostDown` (relay → rp-host) y `envelope` (sólo el sobre, sin cuerpo).

`push-vector.json` es el vector de prueba del cifrado de push (AES‑256‑GCM, AAD `rp1`): la app debe descifrar
`ciphertext` (base64 de `cifrado || tag de 16 B`) con `key` y `nonce` y obtener `plaintext`.

Los tres repos (`rp-relay`, `rp-plugin`, `rp-app`) ejecutan estos fixtures en sus tests de contrato.
