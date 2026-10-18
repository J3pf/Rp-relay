# Release Notes — Rp-relay v0.5.3

## Highlights

### Human-Friendly Agent Display Names (Agent Mesh UX)
In previous versions, unnamed Pi sessions or auto-generated session IDs would fall back directly to raw UUIDs (e.g., `01a14fbb-2812-7332-aae5-d003f17b8fe7`) in node names, communication endpoints, and group chip labels on the Android app's "Red de agentes" screen.

With v0.5.3:
- **`agentDisplayName(agent)` Pure Helper:** Unified resolution logic across topology nodes, group labels, comms views (`fromName`/`toName`), and prompt summaries.
- **Precedence:**
  1. Human `session_name`: Non-human identifiers (UUIDs, ULIDs, hex IDs of length ≥ 8 with digits, and automated prefixes like `subagent-chat-<hex>`) are strictly rejected. Legitimate words like `cafe-api`, `add-feed`, `Rp-app`, and `dead-beef` are safely preserved.
  2. Directory basename `basename(cwd)`.
  3. Default fallback `"Agent"`.
  4. Raw IDs and UUIDs are **never** returned.
- **Consistent Display Names Across Graph and Comms:** Resolved name consistency so `fromName`/`toName` in live WebSocket `mesh.comm` events, HTTP `/v1/mesh/conversation`, and `/v1/mesh/agents/:id/comms`, as well as prompt `agentLabel`, strictly match the agent's disambiguated node name in the snapshot (e.g., `"Rp-app (2)"`).
- **Deterministic Duplicate Disambiguation:** When multiple agents on the same machine share the same base display name within a snapshot, they are disambiguated deterministically (`"Rp-app"`, `"Rp-app (2)"`, `"Rp-app (3)"`) ordered stably by `first_seen_at` ascending and tie-broken by `agentId`. Agents on distinct machines stay unsuffixed.
- **Unified Pure `groupDisplayLabel(orchestrator, members)` Helper:** Clean, non-convoluted group label resolution with explicit precedence (human orchestrator session name → common directory basename → orchestrator display name → `"Mesh Group"`), correctly supporting monorepo layouts (e.g., orchestrator in `RP` with members in `RP/Rp-app`, `RP/Rp-relay` resolving to `"RP"`).
- **Deterministic Load Smoke Test:** Fixed load generator throughput calculation to measure elapsed time strictly during active event generation rather than including the post-generation socket drain delay, preventing load-sensitive CI flakiness.
- **Dependency Upgrades to Latest Stable:**
  - Fastify plugins: `@fastify/multipart` (10.1.4), `@fastify/rate-limit` (11.2.1), `@fastify/type-provider-typebox` (6.3.0).
  - Database: `better-sqlite3` (13.0.3), `@types/better-sqlite3` (9.6.0).
  - Logging & Push: `pino` (10.4.0), `firebase-admin` (14.5.0).
  - Toolchain: `typescript` (7.0.2), `vitest` (5.0.5).
  - Node engine alignment: `@types/node` maintained on v22 (`^22.20.5`) aligned with `"engines": { "node": ">=22" }`.
- **Wire Contract Preservation:** Wire contracts and protocol schemas remain 100% backward-compatible.

## Known Issues
- `npm audit` reports GHSA-86w9-cpqp-85rv (high) in `node-forge` via the optional dependency `acme-client` 5.4.0. Both packages are already at their latest stable versions and no patched release of `node-forge` is available yet upstream. npm's automated suggestion to downgrade to `acme-client` 2.1.0 breaks modern ACME features and is intentionally not applied. This vulnerability is pre-existing and only relevant when ACME automatic TLS certificate provisioning is enabled.

## Upgrade
To upgrade an existing installation:

```bash
sudo npm i -g https://github.com/J3pf/Rp-relay/releases/download/v0.5.3/j3pf-rp-relay-0.5.3.tgz && sudo systemctl restart rp-relay
```

The graceful shutdown signals connected clients with code `1012`, prompting them to reconnect immediately and seamlessly.
