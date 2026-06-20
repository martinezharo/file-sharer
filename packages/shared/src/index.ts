/**
 * Shared contract between the Cloudflare Worker (backend) and the PWA (frontend).
 *
 * Nothing in here is secret: the server only ever handles ciphertext, public keys
 * and hashes. All plaintext and symmetric keys stay on the clients.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum size (bytes) of a single file *before* encryption: 50 MB. */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Upper bound for the *encrypted* upload. AES-GCM adds a 16-byte auth tag, so we
 * allow a small margin above MAX_FILE_SIZE when validating the R2 upload.
 */
export const MAX_UPLOAD_SIZE = MAX_FILE_SIZE + 1024;

/** Pairing slots live at most this long before the cron job reaps them. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Server-side messages/files are purged after this age regardless of delivery. */
export const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

/** Default client polling interval for pending messages. */
export const POLL_INTERVAL_MS = 8000;

/** HTTP header carrying the calling device id. */
export const DEVICE_ID_HEADER = "X-Device-Id";

// ---------------------------------------------------------------------------
// Core domain shapes
// ---------------------------------------------------------------------------

/** A device as published during registration/pairing (public material only). */
export interface DeviceDescriptor {
  id: string;
  name: string;
  /** ECDH P-256 public key, base64url-encoded SPKI. */
  publicKey: string;
}

/** A device as listed in the management UI. */
export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
}

/** Payload encoded inside a QR code (or pasted as text) during pairing. */
export interface PairingQrPayload {
  v: 1;
  pairingId: string;
  deviceId: string;
  deviceName: string;
  /** ECDH P-256 public key of the joining device, base64url SPKI. */
  publicKey: string;
}

// ---------------------------------------------------------------------------
// API request/response DTOs
// ---------------------------------------------------------------------------

export interface CreateGroupRequest {
  groupId: string;
  /** SHA-256(groupAuthToken) as lowercase hex. The raw token never leaves clients. */
  authTokenHash: string;
  device: DeviceDescriptor;
}

export interface CreateGroupResponse {
  ok: true;
}

/** Device 2 -> server: reserve a pairing slot and publish its public material. */
export interface PairingRequestBody {
  device: DeviceDescriptor;
}

export interface PairingRequestResponse {
  ok: true;
}

/** Device 1 (authed) -> server: deposit the wrapped GroupKey package. */
export interface PairingCompleteBody {
  /** AES-GCM ciphertext of the pairing payload, JSON `{ ct, iv }` then base64url. */
  wrappedPackage: string;
  /** Ephemeral ECDH P-256 public key (base64url SPKI) used to derive the wrap key. */
  ephemeralPublicKey: string;
}

export interface PairingCompleteResponse {
  ok: true;
}

/** Device 2 polls this until `ready` is true. */
export interface PairingPollResponse {
  ready: boolean;
  wrappedPackage?: string;
  ephemeralPublicKey?: string;
}

/**
 * Plaintext structure that is encrypted into `wrappedPackage`. Only the joining
 * device ever sees this in the clear.
 */
export interface PairingPayload {
  /** Raw AES-GCM 256 GroupKey, base64url. */
  groupKey: string;
  groupAuthToken: string;
  groupId: string;
}

export interface SendMessageRequest {
  id: string;
  /** Encrypted text (base64url AES-GCM ciphertext); omit for file-only messages. */
  encryptedPayload?: string;
  /** base64url IV for the text payload. */
  iv?: string;
  /** R2 object key for an attached encrypted file. */
  fileR2Key?: string;
  /** base64url IV for the file payload. */
  fileIv?: string;
  /** Encrypted file metadata (name/size/mime), base64url AES-GCM ciphertext. */
  fileMeta?: string;
  /** base64url IV for the file metadata payload. */
  fileMetaIv?: string;
}

export interface SendMessageResponse {
  ok: true;
}

export interface PendingMessage {
  id: string;
  senderDeviceId: string;
  encryptedPayload: string | null;
  iv: string | null;
  fileR2Key: string | null;
  fileIv: string | null;
  fileMeta: string | null;
  fileMetaIv: string | null;
  createdAt: number;
}

export interface PendingMessagesResponse {
  messages: PendingMessage[];
}

export interface AckResponse {
  ok: true;
  /** True if this ack completed delivery and triggered server-side deletion. */
  deleted: boolean;
}

export interface DevicesListResponse {
  devices: DeviceInfo[];
}

export interface RevokeDeviceResponse {
  ok: true;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "rate_limited"
  | "internal";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
