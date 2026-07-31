-- "Delete for everyone": a message can be a tombstone ordering every other
-- device to forget another message.
--
-- Modelled as a message rather than as its own table + endpoint on purpose. A
-- deletion has to reach devices that are offline right now, retry until it
-- lands, survive the app being closed and be confirmed per device — which is
-- exactly the pipeline `messages` + `delivery_status` already implements. A
-- parallel mechanism would have had to reimplement all of it.
--
-- Nullable, so every existing row keeps working untouched.

-- Id of the message this row orders devices to delete. NULL for normal
-- messages, which is all of them until now. Not a foreign key: the target is
-- usually already gone (the server deletes a message as soon as every recipient
-- has acked it), and the tombstone still has to be delivered in that case —
-- that is in fact the common case, since the copies that matter live on the
-- devices, not here.
ALTER TABLE messages ADD COLUMN deletes_message_id TEXT;
