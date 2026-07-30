-- Real revocation: rotate the GroupKey instead of only flagging the device.
--
-- Everything defaults to epoch 1, so existing spaces keep working untouched:
-- no device is logged out, no re-pairing, and history stays readable because
-- each client keeps every epoch it has ever held.

-- Current epoch of the group's GroupKey. Bumped by exactly one per rotation;
-- the bump is the compare-and-swap that serializes concurrent rotations.
ALTER TABLE groups ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1;

-- A device was revoked and the key has not been rotated yet. Any active device
-- that sees this completes the rotation, so the work is not stranded on the
-- device that pressed "Revoke" if it goes offline right afterwards.
ALTER TABLE groups ADD COLUMN rotation_pending INTEGER NOT NULL DEFAULT 0;

-- Highest epoch this device has adopted. Drives both "who is still catching
-- up" in the UI and which devices a rotation must wrap the new key for.
ALTER TABLE devices ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1;

-- Which key decrypts `name_enc`. Device names are encrypted once, when the
-- device is added, and never rewritten — so they carry their own epoch rather
-- than being re-encrypted on every rotation.
ALTER TABLE devices ADD COLUMN name_key_epoch INTEGER NOT NULL DEFAULT 1;

-- Which key decrypts this message. Kept per message (not per group) because a
-- rotation must not orphan ciphertext that is still pending delivery.
ALTER TABLE messages ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1;

-- Mailbox of rotated keys, each wrapped (ECIES) to one device's ECDH public
-- key. The server only ever holds the wrapped blob, and drops it the moment
-- the device acks the epoch — which is how a device that was offline during
-- the rotation heals itself on its next poll.
CREATE TABLE key_distribution (
  group_id             TEXT NOT NULL,
  epoch                INTEGER NOT NULL,
  device_id            TEXT NOT NULL,
  wrapped_key          TEXT NOT NULL,
  ephemeral_public_key TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (group_id, epoch, device_id)
);

CREATE INDEX idx_key_dist_device ON key_distribution (device_id, epoch);
