-- rp-relay: additive APNs direct push registration fields
ALTER TABLE devices ADD COLUMN apns_token TEXT;
ALTER TABLE devices ADD COLUMN apns_env TEXT CHECK (apns_env IS NULL OR apns_env IN ('sandbox', 'production'));
