import {
  type AssignableDeviceRole,
  type DeviceRole,
  INITIAL_KEY_EPOCH,
  MAX_FILE_SIZE,
  type PairingQrPayload,
} from "@file-sharer/shared";
import { signal } from "@preact/signals";
import { NetworkError, api } from "./api/client";
import {
  decryptName,
  encryptName,
  exportGroupKey,
  exportPublicKey,
  generateDeviceKeyPair,
  generateGroupKey,
  importGroupKey,
  importPublicKey,
  randomId,
  randomToken,
  sha256Hex,
  unwrapPairingPackage,
  wrapPairingPackage,
} from "./crypto/crypto";
import { createKeyring, currentKey, keyForEpoch } from "./crypto/keyring";
import { pinDeviceKey, reconcileDeviceKeys } from "./crypto/pinning";
import {
  deleteFile,
  getFile,
  metaDelete,
  metaGet,
  metaSet,
  putOutgoingFileMessages,
} from "./db/store";
import { applyMessageUpdate, loadMessages, removeMessage, upsertMessage } from "./state/messages";
import {
  applyKeyring,
  authHeaders,
  keyring,
  persistSession,
  resetSession,
  session,
  sessionRevoked,
} from "./state/session";
import { showToast, view } from "./state/ui";
import { backgroundSyncSupported, requestBackgroundSync } from "./sync/background";
import { DeviceKeyMismatchError, rotateGroupKey } from "./sync/rekey";
import { startSync, stopSync, syncNow } from "./sync/sync";
import type { FileRef, LinkingState, LocalMessage, Session } from "./types";

/** Live state while linking THIS device to an existing space. */
export const linking = signal<LinkingState | null>(null);

interface PendingPairing {
  keyPair: CryptoKeyPair;
  payload: PairingQrPayload;
}

let linkTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Onboarding: create a new space (this device becomes the first member)
// ---------------------------------------------------------------------------

export async function createSpace(deviceName: string): Promise<void> {
  const keyPair = await generateDeviceKeyPair();
  const newGroupKey = await generateGroupKey();
  const token = randomToken();
  const groupId = randomId();
  const deviceId = randomId();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const name = await encryptName(newGroupKey, deviceName, deviceId);

  await api.createGroup({
    groupId,
    deviceAuthTokenHash: await sha256Hex(token),
    device: { id: deviceId, publicKey },
    encryptedName: name.ciphertext,
    nameIv: name.iv,
  });

  const newSession: Session = { groupId, deviceId, deviceName, deviceAuthToken: token };
  await persistSession(newSession, createKeyring(newGroupKey, INITIAL_KEY_EPOCH), keyPair);
  await loadMessages();
  startSync();
}

// ---------------------------------------------------------------------------
// Onboarding: link this device to an existing space (this device is the joiner)
// ---------------------------------------------------------------------------

export async function startLinking(deviceName: string): Promise<void> {
  const keyPair = await generateDeviceKeyPair();
  const deviceId = randomId();
  const pairingId = randomId();
  const publicKey = await exportPublicKey(keyPair.publicKey);

  const payload: PairingQrPayload = { v: 1, pairingId, deviceId, deviceName, publicKey };
  await api.pairingRequest(pairingId, { device: { id: deviceId, publicKey } });

  const pending: PendingPairing = { keyPair, payload };
  await metaSet("pendingPairing", pending);

  linking.value = {
    pairingId,
    deviceId,
    deviceName,
    qrText: JSON.stringify(payload),
    status: "waiting",
  };
  startLinkPolling(pairingId, keyPair, payload);
}

/** Resume an interrupted linking flow after a reload. */
export async function resumeLinking(): Promise<void> {
  const pending = await metaGet<PendingPairing>("pendingPairing");
  if (!pending || session.value) return;
  linking.value = {
    pairingId: pending.payload.pairingId,
    deviceId: pending.payload.deviceId,
    deviceName: pending.payload.deviceName,
    qrText: JSON.stringify(pending.payload),
    status: "waiting",
  };
  startLinkPolling(pending.payload.pairingId, pending.keyPair, pending.payload);
}

function startLinkPolling(
  pairingId: string,
  keyPair: CryptoKeyPair,
  payload: PairingQrPayload,
): void {
  stopLinkPolling();
  linkTimer = setInterval(() => void pollLink(pairingId, keyPair, payload), 2500);
}

function stopLinkPolling(): void {
  if (linkTimer) clearInterval(linkTimer);
  linkTimer = null;
}

async function pollLink(
  pairingId: string,
  keyPair: CryptoKeyPair,
  payload: PairingQrPayload,
): Promise<void> {
  try {
    const result = await api.pairingPoll(pairingId);
    if (!result.ready || !result.wrappedPackage || !result.ephemeralPublicKey) return;

    stopLinkPolling();
    const recovered = await unwrapPairingPackage(
      keyPair.privateKey,
      result.ephemeralPublicKey,
      result.wrappedPackage,
      pairingId,
    );
    const recoveredGroupKey = await importGroupKey(recovered.groupKey);
    const newSession: Session = {
      groupId: recovered.groupId,
      deviceId: payload.deviceId,
      deviceName: payload.deviceName,
      deviceAuthToken: recovered.deviceAuthToken,
    };
    // The space may have rotated its key long before this device existed, so
    // the keyring starts at the epoch it was handed, not at 1.
    await persistSession(newSession, createKeyring(recoveredGroupKey, recovered.keyEpoch), keyPair);
    await metaDelete("pendingPairing");
    // Best-effort: the slot is already TTL-reaped by cron, this just avoids
    // leaving the (encrypted) package reachable until then.
    void api.pairingDelete(pairingId).catch(() => {});
    await loadMessages();
    startSync();
    linking.value = null;
    showToast("Device linked successfully");
  } catch (error) {
    // A flaky network on a phone is the rule, not the exception: the next
    // tick (2.5 s) should get a fresh chance. Only kill the loop and surface
    // a hard error for things that retrying cannot fix (decrypt failure,
    // malformed QR, etc.).
    if (error instanceof NetworkError) return;
    stopLinkPolling();
    linking.value = linking.value
      ? { ...linking.value, status: "error", error: errorMessage(error) }
      : null;
  }
}

export async function cancelLinking(): Promise<void> {
  stopLinkPolling();
  linking.value = null;
  await metaDelete("pendingPairing");
}

// ---------------------------------------------------------------------------
// Device management: add a new device (this device is an existing member)
// ---------------------------------------------------------------------------

export async function addDeviceFromQr(qrText: string): Promise<void> {
  const currentSession = session.value;
  const ring = keyring.value;
  if (!currentSession || !ring) throw new Error("Not signed in");
  const currentGroupKey = currentKey(ring);

  let payload: PairingQrPayload;
  try {
    payload = JSON.parse(qrText) as PairingQrPayload;
  } catch {
    throw new Error("That does not look like a valid device code");
  }
  if (payload.v !== 1 || !payload.pairingId || !payload.publicKey || !payload.deviceId) {
    throw new Error("Unsupported or malformed device code");
  }

  const recipientPublicKey = await importPublicKey(payload.publicKey);
  const deviceAuthToken = randomToken();
  const wrapped = await wrapPairingPackage(
    recipientPublicKey,
    {
      groupKey: await exportGroupKey(currentGroupKey),
      keyEpoch: ring.current,
      deviceAuthToken,
      groupId: currentSession.groupId,
    },
    payload.pairingId,
  );
  // The joining device can't encrypt its own name (it has no GroupKey yet), so
  // this device encrypts the scanned (out-of-band) name on its behalf.
  const name = await encryptName(currentGroupKey, payload.deviceName, payload.deviceId);

  await api.pairingComplete(
    payload.pairingId,
    {
      wrappedPackage: wrapped.wrappedPackage,
      ephemeralPublicKey: wrapped.ephemeralPublicKey,
      scannedPublicKey: payload.publicKey,
      encryptedName: name.ciphertext,
      nameIv: name.iv,
      deviceAuthTokenHash: await sha256Hex(deviceAuthToken),
      keyEpoch: ring.current,
    },
    authHeaders(),
  );

  // The QR was read out-of-band, so this is the one moment we learn a device's
  // public key from a channel the server cannot touch. Pin it: a later rotation
  // refuses to wrap the new key for a device whose key changed since.
  await pinDeviceKey(payload.deviceId, payload.publicKey);
}

/** Fetch the group's devices and decrypt their names for display. */
export interface DeviceView {
  id: string;
  name: string;
  createdAt: number;
  role: DeviceRole;
  /** False while this device still has to pick up the latest key rotation. */
  keyUpToDate: boolean;
}

export interface DeviceManagementView {
  devices: DeviceView[];
  currentRole: DeviceRole;
  /** A revocation is still waiting for its key rotation to land. */
  rotationPending: boolean;
}

export async function listDevicesDecrypted(): Promise<DeviceManagementView> {
  const ring = keyring.value;
  if (!ring) throw new Error("Not signed in");
  const { devices, currentRole, keyEpoch, rotationPending } = await api.listDevices(authHeaders());
  // Seeing the roster is also how a device learns the keys of members it did
  // not add itself, so this is where those get pinned (see crypto/pinning.ts).
  await reconcileDeviceKeys(devices);
  return {
    currentRole,
    rotationPending,
    devices: await Promise.all(
      devices.map(async (d) => {
        // A name is encrypted once, when the device joins, so it can predate
        // the current epoch by any number of rotations.
        const nameKey = keyForEpoch(ring, d.nameKeyEpoch);
        return {
          id: d.id,
          createdAt: d.createdAt,
          role: d.role,
          keyUpToDate: d.keyEpoch >= keyEpoch,
          name:
            nameKey && d.encryptedName && d.nameIv
              ? await decryptName(nameKey, d.encryptedName, d.nameIv, d.id).catch(() => d.id)
              : d.id,
        };
      }),
    ),
  };
}

/**
 * Revoke a device and immediately rotate the GroupKey, which is what actually
 * ends its access: revocation alone only closes the API to it, leaving it able
 * to decrypt any ciphertext it captures by other means.
 *
 * Rotation is reported separately because it can legitimately not happen here
 * (offline, or another device won the race). The server remembers the space
 * owes one, so the next device to poll finishes it — nothing is lost.
 */
export async function revokeDevice(deviceId: string): Promise<{ rotated: boolean }> {
  await api.revokeDevice(deviceId, authHeaders());
  return { rotated: await rotateNow() };
}

/** Run the rotation this space owes, if this device can. */
async function rotateNow(): Promise<boolean> {
  const currentSession = session.value;
  const ring = keyring.value;
  if (!currentSession || !ring) return false;
  try {
    const rotated = await rotateGroupKey(
      ring,
      currentSession.groupId,
      currentSession.deviceId,
      authHeaders(),
    );
    if (!rotated) return false;
    applyKeyring(rotated.keyring);
    return true;
  } catch (error) {
    if (error instanceof DeviceKeyMismatchError) throw error;
    // Anything else (offline, a racing rotation) is picked up by the sync loop.
    return false;
  }
}

export async function updateDeviceRole(
  deviceId: string,
  role: AssignableDeviceRole,
): Promise<void> {
  await api.updateDeviceRole(deviceId, role, authHeaders());
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/**
 * Kick the queued send on its way: flush immediately from the page and, where
 * supported, register a background sync so the service worker finishes the
 * job even if the app is closed before the upload completes.
 */
function scheduleOutboxFlush(): void {
  void syncNow();
  void requestBackgroundSync();
}

export async function sendTextMessage(text: string): Promise<void> {
  const currentSession = session.value;
  if (!currentSession) return;
  const trimmed = text.trim();
  if (!trimmed) return;

  const message: LocalMessage = {
    id: randomId(),
    direction: "out",
    senderDeviceId: currentSession.deviceId,
    senderDeviceName: currentSession.deviceName,
    text: trimmed,
    createdAt: Date.now(),
    status: "queued",
  };
  await upsertMessage(message);
  // Flush via the sync engine (handles encrypt + send + retry).
  scheduleOutboxFlush();
}

/** Queue one file for sending. Returns false if it was rejected (too large). */
export async function sendFileMessage(file: File): Promise<boolean> {
  const queued = await queueFileMessages([file]);
  if (queued === 0) return false;
  scheduleOutboxFlush();
  return true;
}

export async function sendFileMessages(files: readonly File[]): Promise<void> {
  // Commit the complete selection before starting any upload. Previously each
  // file kicked the sync loop immediately, so the first upload could be frozen
  // while the rest of the selection had not even joined the outbox yet.
  const queued = await queueFileMessages(files);
  if (queued === 0) return;
  scheduleOutboxFlush();

  // Tell the user what will happen to their upload(s) beyond this screen.
  if (!navigator.onLine) {
    showToast(
      backgroundSyncSupported()
        ? "You're offline — uploads will continue in the background once you reconnect"
        : "You're offline — uploads will resume when you're back online (keep the app open)",
    );
  }
}

async function queueFileMessages(files: readonly File[]): Promise<number> {
  const currentSession = session.value;
  if (!currentSession || !keyring.value) return 0;

  const accepted = files.filter((file) => file.size <= MAX_FILE_SIZE);
  if (accepted.length !== files.length) {
    const rejected = files.length - accepted.length;
    showToast(
      `${rejected === 1 ? "1 file is" : `${rejected} files are`} too large (max ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB)`,
      "error",
    );
  }
  if (accepted.length === 0) return 0;

  const createdAt = Date.now();
  const entries = accepted.map((file, index) => {
    const r2Key = randomId();
    const fileRef: FileRef = {
      r2Key,
      iv: "",
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
    };
    const message: LocalMessage = {
      id: randomId(),
      direction: "out",
      senderDeviceId: currentSession.deviceId,
      senderDeviceName: currentSession.deviceName,
      file: fileRef,
      createdAt: createdAt + index,
      status: "queued",
      fileState: "downloaded",
    };
    return { message, blob: file };
  });

  await putOutgoingFileMessages(entries);
  for (const { message } of entries) applyMessageUpdate(message);
  return entries.length;
}

/** Re-queue a failed outgoing message and try again. */
export async function retryMessage(message: LocalMessage): Promise<void> {
  if (message.direction !== "out" || message.status !== "failed") return;
  await upsertMessage({ ...message, status: "queued" });
  scheduleOutboxFlush();
}

/** Trigger a browser download of a (already decrypted, locally cached) file. */
export async function saveFile(message: LocalMessage): Promise<void> {
  if (!message.file) return;
  const blob = await getFile(message.file.r2Key);
  if (!blob) {
    showToast("File is no longer available", "error");
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = message.file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Message actions (context menu)
// ---------------------------------------------------------------------------

export async function copyMessageText(message: LocalMessage): Promise<void> {
  if (!message.text) return;
  try {
    await navigator.clipboard.writeText(message.text);
    showToast("Copied to clipboard");
  } catch {
    showToast("Couldn't copy to clipboard", "error");
  }
}

/** Whether the Web Share API can plausibly share this message from here. */
export function canShareMessage(message: LocalMessage): boolean {
  if (typeof navigator.share !== "function") return false;
  if (message.text) return true;
  // Files can only be shared once the decrypted blob is cached locally.
  return !!message.file && message.fileState === "downloaded";
}

export async function shareMessage(message: LocalMessage): Promise<void> {
  try {
    if (message.text) {
      await navigator.share({ text: message.text });
      return;
    }
    if (!message.file) return;
    const blob = await getFile(message.file.r2Key);
    if (!blob) {
      showToast("File is no longer available", "error");
      return;
    }
    const file = new File([blob], message.file.name, { type: message.file.mime });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      showToast("Sharing files isn't supported on this device", "error");
    }
  } catch (error) {
    // The user dismissing the share sheet is not an error.
    if (error instanceof DOMException && error.name === "AbortError") return;
    showToast("Couldn't share", "error");
  }
}

/**
 * Delete a message from THIS device only (other devices keep their copy).
 * An incoming message the server still lists as pending must be acked first,
 * otherwise the next sync pass would just re-download it.
 */
export async function deleteMessageLocally(message: LocalMessage): Promise<void> {
  if (message.direction === "in" && !message.acked) {
    try {
      await api.ackMessage(message.id, authHeaders());
    } catch {
      showToast("Couldn't delete — check your connection and try again", "error");
      return;
    }
  }
  await removeMessage(message.id);
  if (message.file) {
    await deleteFile(message.file.r2Key).catch(() => {
      /* cached blob cleanup is best-effort */
    });
  }
  showToast("Deleted on this device");
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function logout(): Promise<void> {
  stopSync();
  await resetSession();
  view.value = "chat";
}

/**
 * The server rejected this device's credentials for good. Every request from
 * now on would fail the same way, so stop the loops that would otherwise retry
 * forever and flag the session so the UI can tell the user to link again.
 */
export function handleAuthFailure(): void {
  if (sessionRevoked.value || !session.value) return;
  sessionRevoked.value = true;
  stopSync();
  stopLinkPolling();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
