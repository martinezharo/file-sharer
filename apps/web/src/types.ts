/** Local-only types for the PWA (kept separate from the wire DTOs in shared). */

export interface Session {
  groupId: string;
  deviceId: string;
  deviceName: string;
  /** Bearer token proving group membership. Stored locally only. */
  groupAuthToken: string;
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
export type FileState = "remote" | "downloading" | "downloaded" | "error" | "expired";

/** A decrypted message as kept in local history. */
export interface LocalMessage {
  id: string;
  direction: "in" | "out";
  senderDeviceId: string;
  senderDeviceName?: string;
  text?: string;
  file?: FileRef;
  createdAt: number;
  /** Outgoing delivery status (incoming messages are always "sent"). */
  status: MessageStatus;
  fileState?: FileState;
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
