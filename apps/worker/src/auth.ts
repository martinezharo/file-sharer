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
 * Authenticate a request via a bearer token unique to one device.
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
  const tokenHash = await sha256Hex(match[1]!.trim());

  const row = await env.DB.prepare(
    `SELECT group_id AS groupId, id AS deviceId, revoked_at AS revokedAt
       FROM devices
      WHERE auth_token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ groupId: string; deviceId: string; revokedAt: number | null }>();
  if (!row) {
    throw new ApiError("unauthorized", "Invalid token");
  }
  if (row.revokedAt !== null) {
    throw new ApiError("forbidden", "This device has been revoked. Link it again to reconnect.");
  }

  return { groupId: row.groupId, deviceId: row.deviceId };
}
