-- Sender authenticity: per-device signing keys, attested device identities and
-- signed messages.
--
-- Every column is nullable and every existing row keeps working untouched: a
-- device that predates signing simply has no key yet and publishes one the next
-- time it opens the app. Nothing re-pairs, nobody is signed out, and messages
-- already in flight (which carry no signature) still deliver.

-- ECDSA P-256 public key (base64url SPKI) this device signs its messages with.
-- Set once, by the device itself; the server never accepts a replacement, so a
-- stolen bearer token cannot silently re-key an identity other devices pinned.
ALTER TABLE devices ADD COLUMN signing_public_key TEXT;

-- JSON DeviceAttestation: the signed statement of the device that scanned this
-- one's QR code, vouching for both of its public keys. This is what lets any
-- other device verify a roster entry it has never seen out-of-band, instead of
-- trusting it on first sight.
ALTER TABLE devices ADD COLUMN attestation TEXT;

-- Sender's signature over the message (see messageSignatureStatement). NULL
-- only for senders that have not published a signing key.
ALTER TABLE messages ADD COLUMN signature TEXT;
