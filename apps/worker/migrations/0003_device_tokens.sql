-- Authenticate each device independently. Existing development sessions have no
-- device token and must be linked again; this avoids preserving the old shared
-- credential and its device-impersonation weakness.
ALTER TABLE devices ADD COLUMN auth_token_hash TEXT;
CREATE UNIQUE INDEX idx_devices_auth_token_hash ON devices (auth_token_hash);
