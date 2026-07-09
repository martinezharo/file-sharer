import { DEVICE_ID_HEADER } from "@file-sharer/shared";
import type { Env } from "./env";
import { ApiError } from "./errors";

export interface AuthContext {
  groupId: string;
  deviceId: string;
}

/** SHA-256 of a UTF-8 string as lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Authenticate a request via the group bearer token + device id header.
 *
 * The raw token never reaches the server in storage: we hash the presented
 * token and look the group up by that hash. The device must exist, belong to
 * the group and not be revoked.
 */
export async function authenticate(request: Request, env: Env): Promise<AuthContext> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    throw new ApiError("unauthorized", "Missing bearer token");
  }
  const deviceId = request.headers.get(DEVICE_ID_HEADER);
  if (!deviceId) {
    throw new ApiError("unauthorized", "Missing device id");
  }

  const tokenHash = await sha256Hex(match[1]!.trim());

  // One round-trip for the two checks: the LEFT JOIN keeps the group row even
  // when the device is missing/revoked, so "bad token" (401) and "bad device"
  // (403) stay distinguishable.
  const row = await env.DB.prepare(
    `SELECT g.id AS groupId, d.id AS deviceId
       FROM groups g
       LEFT JOIN devices d
         ON d.group_id = g.id AND d.id = ? AND d.revoked_at IS NULL
      WHERE g.auth_token_hash = ?`,
  )
    .bind(deviceId, tokenHash)
    .first<{ groupId: string; deviceId: string | null }>();
  if (!row) {
    throw new ApiError("unauthorized", "Invalid token");
  }
  if (!row.deviceId) {
    throw new ApiError("forbidden", "Device is not an active member of this group");
  }

  return { groupId: row.groupId, deviceId };
}
