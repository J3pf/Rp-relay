# Release Notes — Rp-relay v0.6.1

## Highlights

### Forgetting an agent whose herdr pane is already gone now succeeds

Forgetting an agent was a dead end whenever its pane had disappeared: `agent.close` asked the host to close the pane, herdr answered `pane_not_found`, the relay turned that into `conflict` with `reason: "herdr_close_failed"`, and the app showed **"No se pudo cerrar el agente"**. The agent could never be forgotten, from any device.

A pane that does not exist already satisfies the close, so that case is now success: the relay archives the agent and answers `ack`. Archiving in the relay — rather than answering `not_found` — is what makes every client converge, because the app treats `not_found` as Closed while only dropping its own local row.

Genuine failures are untouched and still change nothing:

| Host answer | Result |
| --- | --- |
| `pane_not_found` | agent archived, `ack` |
| any other error, including `herdr_unavailable` | `conflict`, `reason: "herdr_close_failed"`, nothing archived |
| pane id mismatch / `host_offline` / `timeout` | unchanged from 0.6.0 |

The host code is matched exactly, never a human-readable sentence. Archiving keeps history: events, snapshots, prompts and comms stay until an explicit `agent.purge`.

### No contract change

Message shapes for `agent.closed`, `agent.close`, `host.herdr_close` and `host.herdr_closed` are the same as 0.6.0. 0.6.1 is a drop-in replacement for clients already speaking the 0.6.0 contract.

## Upgrade

```bash
# container image
docker pull ghcr.io/j3pf/rp-relay:0.6.1

# native installer (uses the tarball attached to this release)
sudo ./deploy/install.sh --public-url https://relay.midominio.com

# or explicitly
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.6.1/j3pf-rp-relay-0.6.1.tgz
sudo systemctl restart rp-relay
```

`deploy/install.sh` now defaults to 0.6.1, so `--version latest` resolves to this release's tarball. No migration runs in this release; the schema stays at `0005_agent_archive.sql`.

## Known limitations

- npm packages remain unpublished (404). The GitHub Release tarball and the ghcr image are the only delivery channels; `RP_PUBLISH_NPM` stays unset and nothing is published to the registry.
- The Docker image is published to ghcr only; no Docker Hub mirror.
