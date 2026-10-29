-- rp-relay: preserve agent history when removing agents from active views
ALTER TABLE agents ADD COLUMN archived_at INTEGER;
CREATE INDEX IF NOT EXISTS agents_archived_at ON agents(archived_at DESC) WHERE archived_at IS NOT NULL;
