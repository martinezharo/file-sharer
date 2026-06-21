import { MAX_UPLOAD_SIZE } from "@file-sharer/shared";
import { authenticate } from "../auth";
import { fileStorageKey } from "../db";
import { ApiError } from "../errors";
import { requireId } from "../http";
import type { RouteContext } from "../router";
import { rateLimit } from "../security";

/**
 * Stream an already-encrypted file blob into R2. The body is opaque ciphertext;
 * the server never holds the key. The storage key is namespaced by the caller's
 * group so a device can never write into another group's namespace.
 */
export async function uploadFile(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  await rateLimit(c.env, "RL_UPLOAD", auth.deviceId);
  const key = requireId(c.params.r2key, "r2key");

  const lengthHeader = c.request.headers.get("Content-Length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length <= 0) {
      throw new ApiError("bad_request", "Invalid Content-Length");
    }
    if (length > MAX_UPLOAD_SIZE) {
      throw new ApiError("payload_too_large", "File exceeds the 50 MB limit");
    }
  }
  if (!c.request.body) {
    throw new ApiError("bad_request", "Empty request body");
  }

  const storageKey = fileStorageKey(auth.groupId, key);
  const object = await c.env.FILES.put(storageKey, c.request.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  // Enforce the size cap even when Content-Length was absent or spoofed
  // (e.g. a chunked upload): R2 reports the real stored size.
  if (object.size > MAX_UPLOAD_SIZE) {
    await c.env.FILES.delete(storageKey);
    throw new ApiError("payload_too_large", "File exceeds the 50 MB limit");
  }

  return Response.json({ ok: true });
}

/** Stream an encrypted file blob back to an authenticated device. */
export async function downloadFile(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const key = requireId(c.params.r2key, "r2key");

  const object = await c.env.FILES.get(fileStorageKey(auth.groupId, key));
  if (!object) {
    throw new ApiError("not_found", "File not found or already deleted");
  }

  const headers = new Headers();
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "no-store");
  object.writeHttpMetadata(headers);

  return new Response(object.body, { headers });
}
