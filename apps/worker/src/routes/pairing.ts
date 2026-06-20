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

/**
 * Step 1 (joining device, semi-open): reserve a pairing slot and publish the
 * joining device's public material. The slot is protected by an unguessable
 * `pairingId` and reaped by cron after PAIRING_TTL.
 */
export async function requestPairing(c: RouteContext): Promise<Response> {
  const pairingId = requireId(c.params.pairingId, "pairingId");
  const body = await readJson<PairingRequestBody>(c.request);
  const device = body.device;
  if (!device || typeof device !== "object") {
    throw new ApiError("bad_request", "Missing device");
  }
  const descriptor: DeviceDescriptor = {
    id: requireId(device.id, "device.id"),
    name: requireString(device.name, "device.name", 128),
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

  // Register the joining device (idempotent) and store the wrapped package.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO devices (id, group_id, name, public_key, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET revoked_at = NULL`,
    ).bind(device.id, auth.groupId, device.name, device.publicKey, now),
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
