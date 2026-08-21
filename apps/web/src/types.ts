/** Local-only types for the PWA (kept separate from the wire DTOs in shared). */

import type { SignatureVerdict } from "./crypto/identity";

export interface Session {
  groupId: string;
  deviceId: string;
  deviceName: string;
  /** Bearer token identifying this device. Stored locally only. */
  deviceAuthToken: string;
}

/** Decrypted reference to a file attachment. */
export interface FileRef {
  r2Key: string;
  iv: string;
  name: string;
  size: number;
  mime: string;
}

export type MessageStatus = "queued" | "uploading" | "sent" | "failed";
export type FileState =
  | "remote"
  | "downloading"
  | "downloaded"
  /** Transient download failure — retried on the next sync pass. */
  | "error"
  /** The server no longer has the blob (TTL/cleanup); it can never be fetched. */
  | "expired"
  /** Decryption failed repeatedly (tampered/poisoned ciphertext); given up. */
  | "corrupted";

/** A decrypted message as kept in local history. */
export interface LocalMessage {
  id: string;
  direction: "in" | "out";
  senderDeviceId: string;
  senderDeviceName?: string;
  text?: string;
  file?: FileRef;
  createdAt: number;
  /**
   * GroupKey epoch this message's ciphertext is bound to. Pinned on the first
   * send attempt so retries reproduce identical ciphertext, and cleared only
   * when the server reports the key rotated underneath us.
   */
  keyEpoch?: number;
  /**
   * Id of the message this one deletes everywhere. Set only on outgoing
   * tombstones, which live in the message store purely so the outbox delivers
   * them with the same retries, background sync and offline guarantees as
   * anything else the user sends. They are never rendered — see
   * `visibleMessages` in state/messages.ts.
   */
  deletes?: string;
  /**
   * Album grouping: the files of one selection share a batch, so the chat can
   * render them as a single bubble under a single caption.
   *
   * It exists only to be *rendered* together. On the wire these stay separate
   * messages with separate delivery rows and separate uploads, because that
   * per-file granularity is the only thing that makes a half-finished
   * background pass resumable (see TODO §3).
   */
  batch?: { id: string; index: number; count: number };
  /**
   * This message disappears from every device once the first one opens it.
   *
   * Carried inside the encrypted metadata envelope, so the server never learns
   * which messages are the sensitive ones. Consuming it emits an ordinary
   * "delete for everyone" tombstone — see `consumeViewOnce` in actions.ts.
   */
  viewOnce?: true;
  /** Outgoing delivery status (incoming messages are always "sent"). */
  status: MessageStatus;
  fileState?: FileState;
  /** Incoming payload (text/file metadata) could not be decrypted; dropped. */
  corrupted?: boolean;
  /**
   * Whether the sender's signature checked out (incoming only).
   *
   * `undefined` on messages received before signing existed, and `unverified`
   * when the sender has not published a signing key — neither is worth telling
   * the user about. `invalid` means the sender is not who the server says, and
   * that one is surfaced.
   */
  senderVerified?: SignatureVerdict;
  /** True once this device has acked receipt to the server (incoming only). */
  acked?: boolean;
}

/** In-flight state while linking THIS device to an existing space. */
export interface LinkingState {
  pairingId: string;
  deviceId: string;
  deviceName: string;
  /** QR text payload the existing device must scan. */
  qrText: string;
  status: "waiting" | "linked" | "error";
  error?: string;
}
