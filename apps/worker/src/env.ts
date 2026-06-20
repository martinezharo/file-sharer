export interface Env {
  /** D1 database holding groups, devices, message metadata and delivery status. */
  DB: D1Database;
  /** R2 bucket holding encrypted file blobs. */
  FILES: R2Bucket;
  /** Static assets binding serving the built PWA. */
  ASSETS: Fetcher;
}
