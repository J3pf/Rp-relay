CREATE TABLE comms (
  agent_id TEXT NOT NULL,
  comm_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('out', 'in')),
  channel TEXT NOT NULL CHECK(channel IN ('intercom', 'orchestrator')),
  action TEXT NOT NULL CHECK(action IN ('send', 'ask', 'reply', 'handover', 'message')),
  peer_session_id TEXT,
  peer_name TEXT,
  peer_cwd TEXT,
  peer_ref TEXT,
  peer_agent_id TEXT,
  message_id TEXT,
  reply_to TEXT,
  expects_reply INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER,
  at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, comm_id)
);

CREATE INDEX comms_machine_at ON comms(machine_id, at DESC);
CREATE INDEX comms_message_id ON comms(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX comms_at ON comms(at DESC);
CREATE INDEX comms_peer_unresolved ON comms(peer_agent_id) WHERE peer_agent_id IS NULL;
