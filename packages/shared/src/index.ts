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

/**
 * Epoch of the GroupKey a space is born with. Every key rotation increments it
 * by exactly one, so an epoch identifies which key a ciphertext needs. Spaces
 * created before rotation existed are epoch 1 by migration default, which is
 * why they keep working without re-pairing.
 */
export const INITIAL_KEY_EPOCH = 1;

// ---------------------------------------------------------------------------
// Core domain shapes
// ---------------------------------------------------------------------------

/** A device as published during registration/pairing (public material only). */
export interface DeviceDescriptor {
  id: string;
  /** ECDH P-256 public key, base64url-encoded SPKI. */
  publicKey: string;
}

/**
 * The device's human-readable name, encrypted with the GroupKey so the server
 * never sees it in the clear (it is PII). `iv` is the AES-GCM IV (base64url).
 */
export interface EncryptedName {
  encryptedName: string;
  nameIv: string;
}

export const DEVICE_ROLES = ["owner", "admin", "member"] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];
export type AssignableDeviceRole = Exclude<DeviceRole, "owner">;

/** A device as listed in the management UI (name stays encrypted in transit). */
export interface DeviceInfo {
  id: string;
  encryptedName: string;
  nameIv: string;
  createdAt: number;
  role: DeviceRole;
  /** ECDH P-256 public key (base64url SPKI), used to wrap a rotated GroupKey for it. */
  publicKey: string;
  /** Highest GroupKey epoch this device has adopted. Below the group's = still catching up. */
  keyEpoch: number;
  /** Epoch of the key that encrypted `encryptedName` (names are never rewritten). */
  nameKeyEpoch: number;
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
  /** SHA-256(deviceAuthToken) as lowercase hex. The raw token never leaves clients. */
  deviceAuthTokenHash: string;
  device: DeviceDescriptor;
  /** GroupKey-encrypted device name (the first device already holds the key). */
  encryptedName: string;
  nameIv: string;
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
  /**
   * The joining device's public key as scanned from the QR code (out-of-band,
   * not the pairing slot). The server checks this matches the public key the
   * joining device published in step 1, so a slot whose stored public key was
   * swapped after the QR was scanned is rejected instead of silently wrapped
   * for the wrong recipient.
   */
  scannedPublicKey: string;
  /**
   * GroupKey-encrypted name of the *joining* device. The existing device holds
   * the GroupKey and the scanned (out-of-band) name, so it encrypts it here;
   * the joining device never sends its name to the server in the clear.
   */
  encryptedName: string;
  nameIv: string;
  /** SHA-256 of the new device's independently generated bearer token. */
  deviceAuthTokenHash: string;
  /**
   * Epoch of the GroupKey wrapped into `wrappedPackage`. The server rejects the
   * request unless it is the group's current epoch, so a device that has not
   * caught up with a rotation can never hand a joining device a stale key.
   */
  keyEpoch: number;
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
  /** Epoch of `groupKey`. The joining device starts its keyring here. */
  keyEpoch: number;
  /** Bearer credential unique to the joining device. */
  deviceAuthToken: string;
  groupId: string;
}

export interface SendMessageRequest {
  id: string;
  /**
   * Epoch of the GroupKey every ciphertext in this message was encrypted with.
   * The server rejects anything but the current epoch, so a rotation takes
   * effect immediately instead of leaving a window in which content is still
   * readable by the device that was just revoked.
   */
  keyEpoch: number;
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
  /** Which GroupKey epoch decrypts this message's ciphertexts. */
  keyEpoch: number;
  senderDeviceId: string;
  /** GroupKey-encrypted name of the sender device (null if the device is gone). */
  senderNameEnc: string | null;
  senderNameIv: string | null;
  /** Epoch of the key that encrypted `senderNameEnc`, which may predate the message's. */
  senderNameEpoch: number | null;
  encryptedPayload: string | null;
  iv: string | null;
  fileR2Key: string | null;
  fileIv: string | null;
  fileMeta: string | null;
  fileMetaIv: string | null;
  createdAt: number;
}

/**
 * A rotated GroupKey waiting for one device, wrapped to its ECDH public key
 * exactly like a pairing package. The server stores only this blob, and drops
 * it as soon as the device acks the epoch — which is what lets a device that
 * was offline during the rotation self-heal on its next poll.
 */
export interface PendingKeyDelivery {
  epoch: number;
  /** ECIES-wrapped raw GroupKey (base64url of JSON `{ iv, ct }`). */
  wrappedKey: string;
  /** Ephemeral ECDH P-256 public key (base64url SPKI) used to derive the wrap key. */
  ephemeralPublicKey: string;
}

/**
 * One poll answers everything the client needs to stay in sync: new messages,
 * any GroupKey it has not adopted yet, and whether a rotation is still owed.
 * Bundling them keeps the rotation protocol free of extra round-trips.
 */
export interface PendingMessagesResponse {
  messages: PendingMessage[];
  /** Keys this device hasn't adopted yet, oldest epoch first. Usually empty. */
  keys: PendingKeyDelivery[];
  /** The group's current key epoch. */
  keyEpoch: number;
  /**
   * A device was revoked and the GroupKey has not been rotated yet. Any active
   * device that sees this completes the rotation, so the work is never stranded
   * on the device that happened to press "Revoke".
   */
  rotationPending: boolean;
}

/** One rotated GroupKey wrapped for one remaining device. */
export interface KeyWrap {
  deviceId: string;
  wrappedKey: string;
  ephemeralPublicKey: string;
}

/**
 * Rotate the GroupKey after a revocation. Device tokens are deliberately left
 * untouched: no remaining device is logged out or has to be paired again.
 */
export interface RotateKeyRequest {
  /** Must be exactly the group's current epoch + 1 (compare-and-swap). */
  epoch: number;
  /** One wrap per remaining active device except the caller — no more, no less. */
  wraps: KeyWrap[];
}

export interface RotateKeyResponse {
  ok: true;
  epoch: number;
  /** How many devices the new key was deposited for. */
  devices: number;
}

export interface AckKeyResponse {
  ok: true;
}

export interface AckResponse {
  ok: true;
  /** True if this ack completed delivery and triggered server-side deletion. */
  deleted: boolean;
}

export interface DevicesListResponse {
  devices: DeviceInfo[];
  /** Role of the device making the request, included to render permissions without another read. */
  currentRole: DeviceRole;
  /** The group's current key epoch: devices below it are still catching up. */
  keyEpoch: number;
  /** A revocation is still waiting for its key rotation (see PendingMessagesResponse). */
  rotationPending: boolean;
}

export interface RevokeDeviceResponse {
  ok: true;
}

export interface UpdateDeviceRoleRequest {
  /** Ownership is transferred through a dedicated flow in the future, never through this endpoint. */
  role: AssignableDeviceRole;
}

export interface UpdateDeviceRoleResponse {
  ok: true;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  /** Authenticated, but this device may not do that (insufficient role). */
  | "forbidden"
  /** This device's link is gone for good: it must be paired again. */
  | "device_revoked"
  | "not_found"
  | "conflict"
  /**
   * The GroupKey rotated while this content was being encrypted. The caller
   * must adopt the new key and encrypt again — never a reason to give up.
   */
  | "key_rotated"
  | "payload_too_large"
  | "rate_limited"
  | "internal";

/**
 * Errors that mean the caller's credentials will never work again, whatever it
 * retries. Clients use this to stop polling and ask the user to link again,
 * instead of looping forever on a dead session.
 */
export const AUTH_FAILURE_CODES: readonly ApiErrorCode[] = ["unauthorized", "device_revoked"];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
