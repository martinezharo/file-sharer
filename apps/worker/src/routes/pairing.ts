import type {
  DeviceDescriptor,
  PairingCompleteBody,
  PairingCompleteResponse,
  PairingPollResponse,
  PairingRequestBody,
  PairingRequestResponse,
} from "@file-sharer/shared";
import { authenticate } from "../auth";
import { ApiError, json } from "../errors";
import { readJson, requireId, requireString } from "../http";
import type { RouteContext } from "../router";
import { clientIp, rateLimit } from "../security";

/**
 * Step 1 (joining device, semi-open): reserve a pairing slot and publish the
 * joining device's public material. The slot is protected by an unguessable
 * `pairingId` and reaped by cron after PAIRING_TTL.
 */
export async function requestPairing(c: RouteContext): Promise<Response> {
  await rateLimit(c.env, "RL_PUBLIC", clientIp(c.request));
  const pairingId = requireId(c.params.pairingId, "pairingId");
  const body = await readJson<PairingRequestBody>(c.request);
  const device = body.device;
  if (!device || typeof device !== "object") {
    throw new ApiError("bad_request", "Missing device");
  }
  const descriptor: DeviceDescriptor = {
    id: requireId(device.id, "device.id"),
    publicKey: requireString(device.publicKey, "device.publicKey", 2048),
  };

  const existing = await c.env.DB.prepare("SELECT pairing_id FROM pairing WHERE pairing_id = ?")
    .bind(pairingId)
    .first();
  if (existing) {
    throw new ApiError("conflict", "Pairing slot already in use");
  }

  await c.env.DB.prepare(
    "INSERT INTO pairing (pairing_id, new_device, created_at) VALUES (?, ?, ?)",
  )
    .bind(pairingId, JSON.stringify(descriptor), Date.now())
    .run();

  return json({ ok: true } satisfies PairingRequestResponse);
}

/**
 * Step 2 (existing device, authed): deposit the wrapped GroupKey package and
 * register the joining device into the group. The joining device's descriptor
 * comes from the slot it created in step 1.
 */
export async function completePairing(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const pairingId = requireId(c.params.pairingId, "pairingId");
  const body = await readJson<PairingCompleteBody>(c.request);
  const wrappedPackage = requireString(body.wrappedPackage, "wrappedPackage", 8192);
  const ephemeralPublicKey = requireString(body.ephemeralPublicKey, "ephemeralPublicKey", 2048);
  const nameEnc = requireString(body.encryptedName, "encryptedName", 1024);
  const nameIv = requireString(body.nameIv, "nameIv", 128);

  const slot = await c.env.DB.prepare(
    "SELECT new_device AS newDevice, wrapped_package AS wrapped FROM pairing WHERE pairing_id = ?",
  )
    .bind(pairingId)
    .first<{ newDevice: string | null; wrapped: string | null }>();
  if (!slot || !slot.newDevice) {
    throw new ApiError("not_found", "Pairing slot not found or expired");
  }
  if (slot.wrapped) {
    throw new ApiError("conflict", "Pairing already completed");
  }

  const device = JSON.parse(slot.newDevice) as DeviceDescriptor;
  const now = Date.now();

  // The device id is chosen by the (unauthenticated) joining device in step 1, so
  // it could collide with a device already registered to a *different* group. If we
  // let the upsert below run for such a row it would un-revoke and overwrite a
  // foreign device — a revocation bypass. Reject the collision instead.
  const existingDevice = await c.env.DB.prepare("SELECT group_id AS groupId FROM devices WHERE id = ?")
    .bind(device.id)
    .first<{ groupId: string }>();
  if (existingDevice && existingDevice.groupId !== auth.groupId) {
    throw new ApiError("conflict", "Device id already registered to another group");
  }

  // Register the joining device (idempotent) and store the wrapped package. The
  // name is encrypted client-side by this (existing) device, so the server only
  // ever stores ciphertext for it. The `WHERE devices.group_id = excluded.group_id`
  // guard is defense-in-depth: it makes the upsert a no-op for any cross-group row
  // that slips past the check above rather than reactivating it.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO devices (id, group_id, name_enc, name_iv, public_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         revoked_at = NULL,
         name_enc = excluded.name_enc,
         name_iv = excluded.name_iv,
         public_key = excluded.public_key
       WHERE devices.group_id = excluded.group_id`,
    ).bind(device.id, auth.groupId, nameEnc, nameIv, device.publicKey, now),
    c.env.DB.prepare(
      `UPDATE pairing
          SET group_id = ?, wrapped_package = ?, ephemeral_public_key = ?
        WHERE pairing_id = ?`,
    ).bind(auth.groupId, wrappedPackage, ephemeralPublicKey, pairingId),
  ]);

  return json({ ok: true } satisfies PairingCompleteResponse);
}

/**
 * Step 3 (joining device, semi-open): poll until the wrapped package is ready.
 * The slot is left in place until TTL so a dropped response can be retried.
 */
export async function pollPairing(c: RouteContext): Promise<Response> {
  const pairingId = requireId(c.params.pairingId, "pairingId");
  const slot = await c.env.DB.prepare(
    "SELECT wrapped_package AS wrapped, ephemeral_public_key AS eph FROM pairing WHERE pairing_id = ?",
  )
    .bind(pairingId)
    .first<{ wrapped: string | null; eph: string | null }>();

  if (!slot || !slot.wrapped || !slot.eph) {
    return json({ ready: false } satisfies PairingPollResponse);
  }
  return json({
    ready: true,
    wrappedPackage: slot.wrapped,
    ephemeralPublicKey: slot.eph,
  } satisfies PairingPollResponse);
}
