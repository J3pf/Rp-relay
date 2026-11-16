# AGENTS.md — Rp-relay

Central HTTP/WebSocket relay server and push dispatcher for RemotePi. Bridges mobile clients with desktop coding agents running via Pi.

## Tech Stack & Architecture

- **Runtime**: Node.js >= 22, TypeScript (`tsc -b`), ESM.
- **Framework & Libraries**: Fastify, `@sinclair/typebox`, `@fastify/type-provider-typebox`, `ws` (WebSockets in `noServer` mode), `better-sqlite3`.
- **Formatting & Linting**: Biome (`npx biome check .`).
- **Testing**: Vitest (`vitest run`).
- **Core Domain**:
  - `src/domain/`: Machines, Agents, Prompts, Messages, History, Hosts, Summaries, Publisher, and `mesh/` topology/comms.
  - `src/push/`: Direct WebSocket push outbox, FCM HTTP v1 sender, APNs HTTP/2 sender, AES-256-GCM encryption, and notification preferences.
  - `src/http/`: REST routes for pairing, machines, agents, long-poll transport, attachments, mesh, admin, and health checks.
  - `src/ws/`: Real-time WebSocket hubs for client-relay (`/ws/app`), agent-relay (`/ws/agent`), and host-relay (`/ws/host`) communication.
  - `src/db/` & `migrations/`: SQLite connection/migration runner (`src/db/index.ts`, `src/db/migrate.ts`, `src/db/repos/`) and append-only SQL migrations (`migrations/0001_init.sql`..`0006_apns_push.sql`).
  - `src/blobs/`, `src/backup/`, `src/tls/`: Attachment store & GC, SQLite `VACUUM INTO` backups/restore, and integrated TLS/ACME.
  - `packages/protocol/`: Canonical TypeBox protocol definitions (`@j3pf/rp-protocol`) and test fixtures (`packages/protocol/fixtures/`).

## Sibling Repositories & Cross-Repo Contracts

`Rp-relay` is the canonical owner of the wire protocol (`docs/PROTOCOLO.md` and `packages/protocol/fixtures/`). When working across the RemotePi system:

- **Mobile Client ([`J3pf/Rp-app`](https://github.com/J3pf/Rp-app), sibling `../Rp-app`)**: Android & iOS Compose Multiplatform app. After changing schemas or fixtures in `packages/protocol/`, sync and verify in `Rp-app` using `./scripts/sync-fixtures.sh [../Rp-relay]` and its `:protocol:test` suite.
- **Host Daemon & Pi Extension ([`J3pf/Rp-plugin`](https://github.com/J3pf/Rp-plugin), sibling `../Rp-plugin`)**: Mirrors the v1 contract in `src/shared/protocol.ts` and checks parity against `docs/PROTOCOLO.md` and fixtures (`npm run fixtures` / `test/contract.test.ts`).
- **Distribution**: Packages are published via GitHub Releases tarballs and `ghcr.io/j3pf/rp-relay` containers (not public npm).

## Commands

```bash
# Install dependencies
npm install

# Run full quality check (lint, typecheck, tests)
npm run check

# Run tests only
npm test

# Run linter & formatter check
npm run lint

# Auto-fix formatting and lint issues
npm run format

# Run TypeScript typecheck
npm run typecheck

# Build project
npm run build

# Start development server
npm run dev
```

## Boundaries & Non-Obvious Conventions

1. **Protocol Adherence**:
   - All inbound payloads (HTTP and WebSocket) must be strictly validated before entering domain repositories.
   - Any modification to message shapes must be accompanied by updated fixtures in `packages/protocol/fixtures/`.
2. **Host RPC Ruting**:
   - Host RPC commands (`host.git_diff`, `host.git_discard`, etc.) must route strictly between the authenticated active mobile session and the paired host machine. Never broadcast host actions to unmatched sessions.
3. **Database & Secrets**:
   - SQLite migrations are append-only. Never alter existing migration files destructively.
   - Never commit `.env` or local database files (`relay.db*`).
4. **Resilience & Push**:
   - Push dispatch operates both via direct WebSocket connection to active clients and optionally via FCM when tokens are present. Notifications must be idempotently deduplicated using `promptId`.

## Verification Before Turn End

Always run `npm run check` (which executes `npm run lint && npm run typecheck && npm test`) and confirm exit code 0 before concluding work.
