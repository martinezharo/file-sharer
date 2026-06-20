import { MAX_UPLOAD_SIZE } from "@file-sharer/shared";
import { authenticate } from "../auth";
import { ApiError } from "../errors";
import { requireId } from "../http";
import type { RouteContext } from "../router";

/**
 * Stream an already-encrypted file blob into R2. The body is opaque ciphertext;
 * the server never holds the key. Size is enforced via Content-Length.
 */
export async function uploadFile(c: RouteContext): Promise<Response> {
  await authenticate(c.request, c.env);
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

  await c.env.FILES.put(key, c.request.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  return Response.json({ ok: true });
}

/** Stream an encrypted file blob back to an authenticated device. */
export async function downloadFile(c: RouteContext): Promise<Response> {
  await authenticate(c.request, c.env);
  const key = requireId(c.params.r2key, "r2key");

  const object = await c.env.FILES.get(key);
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
