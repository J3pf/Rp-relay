# AGENTS.md — Rp-relay

Central HTTP/WebSocket relay server and push dispatcher for RemotePi. Bridges mobile clients with desktop coding agents running via Pi.

## Tech Stack & Architecture

- **Runtime**: Node.js >= 20, TypeScript (`tsc -b`), ESM.
- **Framework & Libraries**: Fastify, `@fastify/type-provider-typebox`, `ws` (WebSockets), `better-sqlite3`, `zod`.
- **Formatting & Linting**: Biome (`npx biome check .`).
- **Testing**: Vitest (`vitest run`).
- **Core Domain**:
  - `src/domain/`: Machines, Agents, Prompts, Sessions, and Push dispatch.
  - `src/http/`: REST routes for pairing, machines, agents, attachments, and health checks.
  - `src/ws/`: Real-time WebSocket hubs for client-relay and host-relay bidirectional communication.
  - `src/db/`: SQLite schema migrations and repositories.
  - `packages/protocol/`: Shared protocol definitions and test fixtures.

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
