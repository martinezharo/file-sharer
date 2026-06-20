import { ApiError } from "./errors";

/** Parse a JSON request body, raising a typed 400 on malformed input. */
export async function readJson<T>(request: Request): Promise<T> {
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
