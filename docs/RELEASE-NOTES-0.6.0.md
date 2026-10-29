# Release Notes — Rp-relay v0.6.0

## Highlights

### Agent lifecycle: herdr ⇄ app, in both directions
Closing an agent now works from either side, and forgetting an agent no longer destroys its history.

- **Closing a herdr pane removes the agent from the app.** The plugin sends `agent.closed { reason: "pane_closed" }` before it drops a bridged socket; the relay archives the agent and publishes the removal. A network drop or a crashed process is *not* a pane close: it still only marks the agent offline.
- **Closing from the app closes the pane.** `agent.close { agentId }` asks the owning `rp-host` to run `host.herdr_close { machineId, paneId }`, honouring `hostRequestTimeoutMs`. The agent is archived only when herdr answers `ok: true`; a refusal, a disconnected host or a timeout changes nothing and returns a typed error (`agent_close_unsupported` when the agent has no pane binding, `conflict` with `reason: "herdr_close_failed"`, `host_offline`, `timeout`).
- **A resumed session comes back.** A live `agent.hello` clears the archive, so `pi --continue` or a herdr restart makes the agent visible again instead of leaving it hidden while it runs.

### Archive instead of delete: history is preserved until you purge it
- Migration `0005_agent_archive.sql` adds a nullable `archived_at`. `agent.forget` now archives: the agent leaves the list, the live updates, the mesh and every push notification, while its events, snapshots, prompts and comms stay in SQLite.
- The periodic maintenance pass also respects the archive: event, comm and closed-prompt retention skip archived agents, so archiving really does keep everything until an explicit purge.
- `agent.archived` (WS) and `GET /v1/agents/archived` list archived agents with a display summary, a cursor (`nextBefore`) and the number of events each one still holds.
- `agent.purge` (WS) and `DELETE /v1/agents/{id}` are the only destructive path: they require an archived, disconnected agent and delete its row together with its events, snapshots, prompts and comms.

### Notifications: no more zombie prompts on other devices
- Resolved prompts are never re-pushed, and the resolution reaches every app connection.
- An answer that has to be queued because the agent is offline now retires the pending notification on the other devices immediately, instead of leaving it alive until the deferred delivery or the 24 h expiry.
- Prompts opened by an already archived agent are ignored: no broadcast, no push, no row.

### Release and delivery
- **The GitHub Release no longer depends on the npm job.** `github-release` needs `docker` only, so a tag always produces a release.
- **npm publishing is deferred.** `@j3pf/rp-relay` and `@j3pf/rp-protocol` are not on the registry (404). The `npm` job is opt-in behind the repository variable `RP_PUBLISH_NPM=true` and a real `NPM_TOKEN` secret, which does not exist yet.
- **The release attaches an installable tarball.** `j3pf-rp-relay-<version>.tgz` is packed with `bundledDependencies: ["@j3pf/rp-protocol"]`, so `npm install -g` works without the registry, and the workflow installs that exact tarball and requires `rp-relay --version` to match the tag before attaching it. That tarball is the supported install path for `deploy/install.sh`, which now defaults to 0.6.0.

## Contract additions (additive; agreed with Rp-plugin and Rp-app)
`agent.closed`, `agent.close`, `agent.archived`, `agent.archived.list`, `agent.purge`, `host.herdr_close`, `host.herdr_closed` and the error code `agent_close_unsupported` (HTTP 409). Contract fixtures ship with the protocol package. Older clients that ignore these messages keep working unchanged.

## Upgrade
```bash
# imagen de contenedor
docker pull ghcr.io/j3pf/rp-relay:0.6.0

# instalador nativo (usa el tarball adjunto al release)
sudo ./deploy/install.sh --public-url https://relay.midominio.com

# o explícito
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.6.0/j3pf-rp-relay-0.6.0.tgz
sudo systemctl restart rp-relay
```
Migration 0005 runs automatically on start; existing agents stay active and no data is touched.

## Known limitations
- npm packages remain unpublished; installing from the registry is not supported yet.
- The Docker image is published to ghcr only; no Docker Hub mirror.
