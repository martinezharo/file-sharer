/** Cloudflare Rate Limiting binding (the `ratelimit` unsafe binding). */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** D1 database holding groups, devices, message metadata and delivery status. */
  DB: D1Database;
  /** R2 bucket holding encrypted file blobs. */
  FILES: R2Bucket;
  /** Static assets binding serving the built PWA. */
  ASSETS: Fetcher;
  /** Rate limit for unauthenticated endpoints (keyed by client IP). */
  RL_PUBLIC: RateLimit;
  /** Rate limit for authenticated writes (keyed by device id). */
  RL_WRITE: RateLimit;
  /** Rate limit for file uploads (keyed by device id). */
  RL_UPLOAD: RateLimit;
}
