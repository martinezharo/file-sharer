-- The space's name, shared by every device instead of local to each one.
--
-- Until now a name lived only in each device's registry: renaming on a phone
-- left the laptop calling the space something else, and the only moment a name
-- ever travelled was inside a pairing package. This stores it once, encrypted
-- with the GroupKey, so a rename reaches every device — including devices that
-- were offline when it happened, which is why it lives here rather than being
-- broadcast as a message (those expire after 24 h).
--
-- The server still cannot read it: it holds ciphertext, an IV and the epoch of
-- the key that produced them. What it does learn is that the space has a name,
-- roughly how long it is, and when it last changed.
--
-- All nullable: every existing group keeps working with no shared name at all,
-- and adopts one the first time any of its devices renames it.

-- AES-GCM ciphertext of the name (base64url), or NULL when it was cleared.
ALTER TABLE groups ADD COLUMN name_enc TEXT;
-- IV for name_enc (base64url).
ALTER TABLE groups ADD COLUMN name_iv TEXT;
-- Epoch of the GroupKey that encrypted it. Re-encrypted after a rotation by any
-- device that can still read the name, so a device that joins later (and holds
-- only the current key) can read it too.
ALTER TABLE groups ADD COLUMN name_key_epoch INTEGER;
-- When the server recorded this name. Server-assigned like messages.created_at:
-- it is the tiebreaker when two devices rename at the same time, so a device
-- with a wrong clock cannot make its name stick forever. NULL = never named.
ALTER TABLE groups ADD COLUMN name_updated_at INTEGER;
