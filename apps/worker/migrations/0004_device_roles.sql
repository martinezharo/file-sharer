-- Device-level authorization. Existing spaces assign ownership to their oldest
-- active device; all other devices remain regular members.
ALTER TABLE devices ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('owner', 'admin', 'member'));

UPDATE devices
   SET role = 'owner'
 WHERE revoked_at IS NULL
   AND id IN (
     SELECT d.id
       FROM devices d
      WHERE d.revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM devices older
           WHERE older.group_id = d.group_id
             AND older.revoked_at IS NULL
             AND (older.created_at < d.created_at OR
                  (older.created_at = d.created_at AND older.id < d.id))
        )
   );

CREATE INDEX idx_devices_group_role ON devices (group_id, role, revoked_at);
