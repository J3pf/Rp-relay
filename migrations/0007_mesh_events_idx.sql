-- rp-relay: partial index for mesh todo_update and subagent_update event lookups
CREATE INDEX IF NOT EXISTS events_mesh_types ON events(agent_id, epoch, seq DESC) WHERE type IN ('todo_update', 'subagent_update');
