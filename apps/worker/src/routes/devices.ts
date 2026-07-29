import type {
  AssignableDeviceRole,
  DeviceInfo,
  DevicesListResponse,
  RevokeDeviceResponse,
  UpdateDeviceRoleRequest,
  UpdateDeviceRoleResponse,
} from "@file-sharer/shared";
import { authenticate, requireAdmin, requireOwner } from "../auth";
import { purgeDeliveredMessages } from "../db";
import { ApiError, json } from "../errors";
import { readJson, requireId } from "../http";
import type { RouteContext } from "../router";

/** List active devices in the caller's group. */
export async function listDevices(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const rows = await c.env.DB.prepare(
    "SELECT id, name_enc AS encryptedName, name_iv AS nameIv, role, created_at AS createdAt FROM devices WHERE group_id = ? AND revoked_at IS NULL ORDER BY created_at ASC, id ASC",
  )
    .bind(auth.groupId)
    .all<DeviceInfo>();
  return json({ devices: rows.results, currentRole: auth.role } satisfies DevicesListResponse);
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
  requireAdmin(auth);
  const deviceId = requireId(c.params.id, "id");

  if (deviceId === auth.deviceId) {
    throw new ApiError("bad_request", "You cannot revoke the device you are currently using");
  }

  const target = await c.env.DB.prepare(
    "SELECT role FROM devices WHERE id = ? AND group_id = ? AND revoked_at IS NULL",
  )
    .bind(deviceId, auth.groupId)
    .first<{ role: DeviceInfo["role"] }>();
  if (!target) throw new ApiError("not_found", "Active device not found");
  if (target.role === "owner") throw new ApiError("forbidden", "The space owner cannot be revoked");
  if (target.role === "admin" && auth.role !== "owner") {
    throw new ApiError("forbidden", "Only the space owner can revoke an administrator");
  }

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

/** Change administrative access. Ownership is intentionally immutable until a transfer flow exists. */
export async function updateDeviceRole(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  requireOwner(auth);
  const deviceId = requireId(c.params.id, "id");
  if (deviceId === auth.deviceId) {
    throw new ApiError("bad_request", "Transfer ownership before changing your own role");
  }

  const body = await readJson<UpdateDeviceRoleRequest>(c.request);
  if (body.role !== "admin" && body.role !== "member") {
    throw new ApiError("bad_request", "Role must be admin or member");
  }
  const role: AssignableDeviceRole = body.role;
  const result = await c.env.DB.prepare(
    "UPDATE devices SET role = ? WHERE id = ? AND group_id = ? AND revoked_at IS NULL AND role != 'owner'",
  )
    .bind(role, deviceId, auth.groupId)
    .run();
  if (result.meta.changes === 0) throw new ApiError("not_found", "Active device not found");

  return json({ ok: true } satisfies UpdateDeviceRoleResponse);
}
