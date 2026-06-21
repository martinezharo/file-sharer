-- Device names are PII: stop storing them in clear and keep them GroupKey-encrypted.
-- The server now only ever holds ciphertext for device names too.

ALTER TABLE devices ADD COLUMN name_enc TEXT;
ALTER TABLE devices ADD COLUMN name_iv  TEXT;
ALTER TABLE devices DROP COLUMN name;
