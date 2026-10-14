-- rp-relay: esquema inicial (PLAN-RELAY §4 + tablas auxiliares de push y adjuntos)

CREATE TABLE relay_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash BLOB NOT NULL UNIQUE,
  push_key BLOB NOT NULL,                       -- 32 bytes AES-256-GCM
  fcm_token TEXT, direct_enabled INTEGER NOT NULL DEFAULT 1,
  notify_prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);

CREATE TABLE machines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT, token_hash BLOB NOT NULL UNIQUE,
  context TEXT NOT NULL DEFAULT 'personal',     -- personal | work | texto libre
  color TEXT NOT NULL DEFAULT '#4F7DF3', icon TEXT, quiet_hours TEXT,   -- JSON {from,to,tz}
  host_info TEXT,                                -- último host.hello (rp-host) en JSON
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);

CREATE TABLE pairing_codes (
  code_hash BLOB PRIMARY KEY, kind TEXT CHECK(kind IN ('device','machine')) NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER, created_by TEXT,
  meta TEXT);                                    -- JSON {name?, context?} para códigos de máquina

CREATE TABLE agents (
  id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id),
  kind TEXT NOT NULL DEFAULT 'pi',
  instance TEXT NOT NULL, epoch TEXT NOT NULL, session_id TEXT NOT NULL, session_name TEXT, session_file TEXT,
  launcher TEXT, herdr TEXT, gentle TEXT, gentle_mode TEXT, statuses TEXT, redacted INTEGER NOT NULL DEFAULT 0, spawn_id TEXT,
  cwd TEXT, git_branch TEXT, git_dirty INTEGER, model TEXT, thinking TEXT, status TEXT NOT NULL, status_detail TEXT,
  online INTEGER NOT NULL, pid INTEGER, pi_version TEXT, plugin_version TEXT, features TEXT, transport TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0, last_preview TEXT,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
CREATE INDEX agents_machine ON agents(machine_id);
CREATE INDEX IF NOT EXISTS agents_last_seen ON agents(last_seen_at DESC);

CREATE TABLE events (                            -- sólo eventos "persistidos" (PROTOCOLO §4)
  agent_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (agent_id, epoch, seq));
CREATE INDEX events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_agent_ts ON events(agent_id, ts, seq);

CREATE TABLE snapshots (agent_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY(agent_id, epoch));

CREATE TABLE prompts (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL,
  payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','answered','resolved','cancelled','expired')),
  answer TEXT, resolved_by TEXT, answered_by_device TEXT,
  created_at INTEGER NOT NULL, answered_at INTEGER, resolved_at INTEGER, expires_at INTEGER,
  push_attempts INTEGER NOT NULL DEFAULT 0);
CREATE INDEX prompts_open ON prompts(state) WHERE state IN ('open','answered');
CREATE INDEX prompts_agent ON prompts(agent_id);
CREATE INDEX IF NOT EXISTS prompts_resolved_at ON prompts(resolved_at) WHERE state NOT IN ('open','answered');

CREATE TABLE blobs (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT, mime TEXT, size INTEGER NOT NULL,
  uploaded_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX blobs_expires ON blobs(expires_at);

-- una PC sólo puede descargar adjuntos referenciados por mensajes enrutados a sus agentes
CREATE TABLE blob_grants (blob_id TEXT NOT NULL, machine_id TEXT NOT NULL, PRIMARY KEY (blob_id, machine_id));

-- canal de push directo: entregas pendientes hasta que la app responde push.ack
CREATE TABLE push_outbox (
  push_id TEXT NOT NULL, device_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT,
  body TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, acked_at INTEGER,
  PRIMARY KEY (push_id, device_id));
CREATE INDEX push_outbox_pending ON push_outbox(device_id) WHERE acked_at IS NULL;
CREATE INDEX IF NOT EXISTS push_outbox_ref ON push_outbox(ref_id) WHERE acked_at IS NULL;
CREATE INDEX IF NOT EXISTS push_outbox_expires ON push_outbox(expires_at);
