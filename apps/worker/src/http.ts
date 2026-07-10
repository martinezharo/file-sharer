import { ApiError } from "./errors";

/**
 * Upper bound for any JSON request body. Generous enough for the largest
 * legitimate payload (a text message's `encryptedPayload`, capped at 1 MB by
 * `requireString`) plus JSON overhead, while still rejecting a client that
 * tries to make us buffer/parse an oversized body before per-field checks run.
 */
const MAX_JSON_BODY_SIZE = 2 * 1024 * 1024;

/** Parse a JSON request body, raising a typed 400/413 on invalid input. */
export async function readJson<T>(request: Request): Promise<T> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_JSON_BODY_SIZE) {
    throw new ApiError("payload_too_large", "Request body too large");
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError("bad_request", "Invalid JSON body");
  }
}

/** Assert a value is a non-empty string within an optional length bound. */
export function requireString(value: unknown, field: string, maxLen = 4096): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError("bad_request", `Missing or invalid field: ${field}`);
  }
  if (value.length > maxLen) {
    throw new ApiError("bad_request", `Field too long: ${field}`);
  }
  return value;
}

/** Optional string field: returns undefined when absent/null, validates otherwise. */
export function optionalString(value: unknown, field: string, maxLen = 4096): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, maxLen);
}

/** Validate a client-provided SHA-256 digest: exactly 64 lowercase hex chars. */
export function requireSha256Hex(value: unknown, field: string): string {
  const s = requireString(value, field, 64);
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new ApiError("bad_request", `Invalid SHA-256 hex digest in field: ${field}`);
  }
  return s;
}

/**
 * Validate a client-provided opaque id (R2 keys, ids). Restricts to URL-safe
 * characters so it is always safe as a single path segment / object key.
 */
export function requireId(value: unknown, field: string): string {
  const s = requireString(value, field, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new ApiError("bad_request", `Invalid characters in field: ${field}`);
  }
  return s;
}
