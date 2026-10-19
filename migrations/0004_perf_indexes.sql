-- rp-relay: composite indexes for mesh event queries and peer comm lookups
CREATE INDEX IF NOT EXISTS events_agent_epoch_type_seq ON events(agent_id, epoch, type, seq DESC);
CREATE INDEX IF NOT EXISTS comms_agent_at ON comms(agent_id, at DESC, comm_id DESC);
CREATE INDEX IF NOT EXISTS comms_peer_at ON comms(peer_agent_id, at DESC, comm_id DESC) WHERE peer_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS comms_pair_at ON comms(agent_id, peer_agent_id, at DESC, comm_id DESC) WHERE peer_agent_id IS NOT NULL;
