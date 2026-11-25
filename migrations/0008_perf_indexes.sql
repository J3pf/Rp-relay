-- rp-relay: partial indexes for push_outbox acked purge and unresolved comms ordering
CREATE INDEX IF NOT EXISTS push_outbox_acked ON push_outbox(acked_at) WHERE acked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS comms_peer_unresolved_at ON comms(peer_agent_id, at DESC, comm_id DESC) WHERE peer_agent_id IS NULL;
