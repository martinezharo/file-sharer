import type {
  AckResponse,
  PendingMessage,
  PendingMessagesResponse,
  SendMessageRequest,
  SendMessageResponse,
} from "@file-sharer/shared";
import { authenticate } from "../auth";
import { activeDeviceIds, deleteMessageById } from "../db";
import { ApiError, json } from "../errors";
import { optionalString, readJson, requireId, requireString } from "../http";
import type { RouteContext } from "../router";

/** Create message metadata + one pending delivery row per other active device. */
export async function sendMessage(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const body = await readJson<SendMessageRequest>(c.request);

  const id = requireId(body.id, "id");
  const encryptedPayload = optionalString(body.encryptedPayload, "encryptedPayload", 1_000_000);
  const iv = optionalString(body.iv, "iv", 128);
  const fileR2Key = body.fileR2Key === undefined ? undefined : requireId(body.fileR2Key, "fileR2Key");
  const fileIv = optionalString(body.fileIv, "fileIv", 128);
  const fileMeta = optionalString(body.fileMeta, "fileMeta", 8192);
  const fileMetaIv = optionalString(body.fileMetaIv, "fileMetaIv", 128);

  if (!encryptedPayload && !fileR2Key) {
    throw new ApiError("bad_request", "Message must contain text and/or a file");
  }
  if (encryptedPayload && !iv) {
    throw new ApiError("bad_request", "Missing iv for text payload");
  }
  if (fileR2Key && !fileIv) {
    throw new ApiError("bad_request", "Missing fileIv for file payload");
  }

  // Recipients are every active device except the sender.
  const recipients = (await activeDeviceIds(c.env, auth.groupId)).filter((d) => d !== auth.deviceId);

  // No recipients: nothing to deliver. Drop any uploaded file and skip storage
  // so the server keeps nothing around.
  if (recipients.length === 0) {
    if (fileR2Key) await c.env.FILES.delete(fileR2Key);
    return json({ ok: true } satisfies SendMessageResponse);
  }

  // If a file is referenced it must already be uploaded.
  if (fileR2Key) {
    const head = await c.env.FILES.head(fileR2Key);
    if (!head) {
      throw new ApiError("bad_request", "Referenced file has not been uploaded");
    }
  }

  const existing = await c.env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
  if (existing) {
    throw new ApiError("conflict", "Message id already exists");
  }

  const now = Date.now();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO messages
         (id, group_id, sender_device_id, encrypted_payload, iv,
          file_r2_key, file_iv, file_meta, file_meta_iv, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      auth.groupId,
      auth.deviceId,
      encryptedPayload ?? null,
      iv ?? null,
      fileR2Key ?? null,
      fileIv ?? null,
      fileMeta ?? null,
      fileMetaIv ?? null,
      now,
    ),
    ...recipients.map((deviceId) =>
      c.env.DB.prepare(
        "INSERT INTO delivery_status (message_id, device_id, downloaded_at) VALUES (?, ?, NULL)",
      ).bind(id, deviceId),
    ),
  ];
  await c.env.DB.batch(stmts);

  return json({ ok: true } satisfies SendMessageResponse);
}

/** Messages still pending download for the calling device. */
export async function pendingMessages(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const sinceRaw = c.url.searchParams.get("since");
  const since = sinceRaw ? Number(sinceRaw) : 0;
  if (!Number.isFinite(since) || since < 0) {
    throw new ApiError("bad_request", "Invalid 'since' cursor");
  }

  const rows = await c.env.DB.prepare(
    `SELECT m.id AS id,
            m.sender_device_id AS senderDeviceId,
            COALESCE(d.name, m.sender_device_id) AS senderDeviceName,
            m.encrypted_payload AS encryptedPayload,
            m.iv AS iv,
            m.file_r2_key AS fileR2Key,
            m.file_iv AS fileIv,
            m.file_meta AS fileMeta,
            m.file_meta_iv AS fileMetaIv,
            m.created_at AS createdAt
       FROM messages m
       JOIN delivery_status ds ON ds.message_id = m.id
       LEFT JOIN devices d ON d.id = m.sender_device_id AND d.group_id = m.group_id
      WHERE ds.device_id = ?
        AND ds.downloaded_at IS NULL
        AND m.created_at > ?
      ORDER BY m.created_at ASC
      LIMIT 200`,
  )
    .bind(auth.deviceId, since)
    .all<PendingMessage>();

  return json({ messages: rows.results } satisfies PendingMessagesResponse);
}

/**
 * Mark a message delivered for the calling device. When no recipients remain
 * pending, the message metadata and its R2 file are deleted immediately.
 */
export async function ackMessage(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const messageId = requireId(c.params.id, "id");

  await c.env.DB.prepare(
    "UPDATE delivery_status SET downloaded_at = ? WHERE message_id = ? AND device_id = ? AND downloaded_at IS NULL",
  )
    .bind(Date.now(), messageId, auth.deviceId)
    .run();

  const pending = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM delivery_status WHERE message_id = ? AND downloaded_at IS NULL",
  )
    .bind(messageId)
    .first<{ n: number }>();

  let deleted = false;
  if (pending && pending.n === 0) {
    deleted = await deleteMessageById(c.env, messageId);
  }

  return json({ ok: true, deleted } satisfies AckResponse);
}
