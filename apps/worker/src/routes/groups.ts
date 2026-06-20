import type { CreateGroupRequest, CreateGroupResponse } from "@file-sharer/shared";
import { ApiError, json } from "../errors";
import { readJson, requireId, requireString } from "../http";
import type { RouteContext } from "../router";

/**
 * Bootstrap a new group with its first device. Unauthenticated: the caller
 * proves nothing yet, but an attacker can only create empty groups (no
 * GroupKey is ever revealed). The first device stores the GroupKey + token
 * locally; the server keeps only the token hash.
 */
export async function createGroup(c: RouteContext): Promise<Response> {
  const body = await readJson<CreateGroupRequest>(c.request);
  const groupId = requireId(body.groupId, "groupId");
  const authTokenHash = requireString(body.authTokenHash, "authTokenHash", 128);
  const device = body.device;
  if (!device || typeof device !== "object") {
    throw new ApiError("bad_request", "Missing device");
  }
  const deviceId = requireId(device.id, "device.id");
  const deviceName = requireString(device.name, "device.name", 128);
  const publicKey = requireString(device.publicKey, "device.publicKey", 2048);

  const existing = await c.env.DB.prepare("SELECT id FROM groups WHERE id = ?")
    .bind(groupId)
    .first();
  if (existing) {
    throw new ApiError("conflict", "Group already exists");
  }

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO groups (id, auth_token_hash, created_at) VALUES (?, ?, ?)").bind(
      groupId,
      authTokenHash,
      now,
    ),
    c.env.DB.prepare(
      "INSERT INTO devices (id, group_id, name, public_key, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(deviceId, groupId, deviceName, publicKey, now),
  ]);

  return json({ ok: true } satisfies CreateGroupResponse);
}
