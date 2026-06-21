import type { Env } from "./env";

/**
 * R2 object key, namespaced by group. The client only ever knows the bare
 * `key`; the server derives the storage key from the authenticated group, so a
 * device in group A can never reach group B's blobs even if it learns the key.
 */
export function fileStorageKey(groupId: string, key: string): string {
  return `${groupId}/${key}`;
}

/** Active (non-revoked) device ids for a group. */
export async function activeDeviceIds(env: Env, groupId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT id FROM devices WHERE group_id = ? AND revoked_at IS NULL",
  )
    .bind(groupId)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

/** Delete a set of messages (and their R2 files + delivery rows) by id. */
async function deleteMessages(
  env: Env,
  messages: { id: string; groupId: string; fileKey: string | null }[],
): Promise<void> {
  if (messages.length === 0) return;

  const fileKeys = messages
    .filter((m) => m.fileKey)
    .map((m) => fileStorageKey(m.groupId, m.fileKey as string));
  if (fileKeys.length > 0) {
    // R2 supports deleting up to 1000 keys in one call.
    await env.FILES.delete(fileKeys);
  }

  const stmts = messages.flatMap((m) => [
    env.DB.prepare("DELETE FROM delivery_status WHERE message_id = ?").bind(m.id),
    env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(m.id),
  ]);
  await env.DB.batch(stmts);
}

/**
 * Delete every message in a group that has no remaining pending recipients
 * (fully delivered), removing its R2 object too. Used after an ack or after a
 * device revocation frees up the last pending delivery.
 */
export async function purgeDeliveredMessages(env: Env, groupId: string): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT m.id AS id, m.group_id AS groupId, m.file_r2_key AS fileKey
       FROM messages m
      WHERE m.group_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM delivery_status ds
           WHERE ds.message_id = m.id AND ds.downloaded_at IS NULL
        )`,
  )
    .bind(groupId)
    .all<{ id: string; groupId: string; fileKey: string | null }>();

  await deleteMessages(env, rows.results);
}

/** Delete one message (and its R2 object) by id. Returns true if it existed. */
export async function deleteMessageById(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id, group_id AS groupId, file_r2_key AS fileKey FROM messages WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; groupId: string; fileKey: string | null }>();
  if (!row) return false;
  await deleteMessages(env, [row]);
  return true;
}

/** Delete messages (and files) older than `olderThan` epoch ms across all groups. */
export async function purgeExpiredMessages(env: Env, olderThan: number): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, group_id AS groupId, file_r2_key AS fileKey FROM messages WHERE created_at < ?",
  )
    .bind(olderThan)
    .all<{ id: string; groupId: string; fileKey: string | null }>();
  await deleteMessages(env, rows.results);
}
