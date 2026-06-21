import type { DeviceInfo, DevicesListResponse, RevokeDeviceResponse } from "@file-sharer/shared";
import { authenticate } from "../auth";
import { purgeDeliveredMessages } from "../db";
import { json } from "../errors";
import { requireId } from "../http";
import type { RouteContext } from "../router";

/** List active devices in the caller's group. */
export async function listDevices(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const rows = await c.env.DB.prepare(
    "SELECT id, name_enc AS encryptedName, name_iv AS nameIv, created_at AS createdAt FROM devices WHERE group_id = ? AND revoked_at IS NULL ORDER BY created_at ASC",
  )
    .bind(auth.groupId)
    .all<DeviceInfo>();
  return json({ devices: rows.results } satisfies DevicesListResponse);
}

/**
 * Revoke a device: mark it revoked and drop its pending deliveries so it no
 * longer blocks immediate deletion of fully-delivered messages. Then purge any
 * messages that just became fully delivered.
 *
 * Note: revocation removes a device from the group registry but does NOT rotate
 * the GroupKey. True forward secrecy would require re-pairing the remaining
 * devices with a new GroupKey (documented as a future improvement).
 */
export async function revokeDevice(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const deviceId = requireId(c.params.id, "id");

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND group_id = ?").bind(
      Date.now(),
      deviceId,
      auth.groupId,
    ),
    c.env.DB.prepare(
      "DELETE FROM delivery_status WHERE device_id = ? AND downloaded_at IS NULL",
    ).bind(deviceId),
  ]);

  await purgeDeliveredMessages(c.env, auth.groupId);

  return json({ ok: true } satisfies RevokeDeviceResponse);
}
