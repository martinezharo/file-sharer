import { MAX_FILE_SIZE, type PairingQrPayload } from "@file-sharer/shared";
import { signal } from "@preact/signals";
import { api } from "./api/client";
import {
  encryptFile,
  encryptJson,
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
import { getFile, metaDelete, metaGet, metaSet, putFile } from "./db/store";
import { loadMessages, upsertMessage } from "./state/messages";
import { authHeaders, groupKey, persistSession, resetSession, session } from "./state/session";
import { showToast, view } from "./state/ui";
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

  await api.createGroup({
    groupId,
    authTokenHash: await sha256Hex(token),
    device: { id: deviceId, name: deviceName, publicKey },
  });

  const newSession: Session = { groupId, deviceId, deviceName, groupAuthToken: token };
  await persistSession(newSession, newGroupKey, keyPair);
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
  await api.pairingRequest(pairingId, { device: { id: deviceId, name: deviceName, publicKey } });

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

function startLinkPolling(pairingId: string, keyPair: CryptoKeyPair, payload: PairingQrPayload): void {
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
    );
    const recoveredGroupKey = await importGroupKey(recovered.groupKey);
    const newSession: Session = {
      groupId: recovered.groupId,
      deviceId: payload.deviceId,
      deviceName: payload.deviceName,
      groupAuthToken: recovered.groupAuthToken,
    };
    await persistSession(newSession, recoveredGroupKey, keyPair);
    await metaDelete("pendingPairing");
    await loadMessages();
    startSync();
    linking.value = null;
    showToast("Device linked successfully");
  } catch (error) {
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
  const currentGroupKey = groupKey.value;
  if (!currentSession || !currentGroupKey) throw new Error("Not signed in");

  let payload: PairingQrPayload;
  try {
    payload = JSON.parse(qrText) as PairingQrPayload;
  } catch {
    throw new Error("That does not look like a valid device code");
  }
  if (payload.v !== 1 || !payload.pairingId || !payload.publicKey) {
    throw new Error("Unsupported or malformed device code");
  }

  const recipientPublicKey = await importPublicKey(payload.publicKey);
  const wrapped = await wrapPairingPackage(recipientPublicKey, {
    groupKey: await exportGroupKey(currentGroupKey),
    groupAuthToken: currentSession.groupAuthToken,
    groupId: currentSession.groupId,
  });

  await api.pairingComplete(
    payload.pairingId,
    { wrappedPackage: wrapped.wrappedPackage, ephemeralPublicKey: wrapped.ephemeralPublicKey },
    authHeaders(),
  );
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await api.revokeDevice(deviceId, authHeaders());
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

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
  void syncNow();
}

export async function sendFileMessage(file: File): Promise<void> {
  const currentSession = session.value;
  const currentGroupKey = groupKey.value;
  if (!currentSession || !currentGroupKey) return;

  if (file.size > MAX_FILE_SIZE) {
    showToast(`File is too large (max ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB)`, "error");
    return;
  }

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
    createdAt: Date.now(),
    status: "queued",
    fileState: "downloaded", // the sender already holds the file
  };
  await upsertMessage(message);

  try {
    const buffer = await file.arrayBuffer();
    const encrypted = await encryptFile(currentGroupKey, buffer);
    fileRef.iv = encrypted.iv;
    // Cache the original locally so the sender can re-open it instantly.
    await putFile(r2Key, file);

    const auth = authHeaders();
    await api.uploadFile(r2Key, encrypted.ciphertext, auth);
    const meta = await encryptJson(currentGroupKey, {
      name: fileRef.name,
      size: fileRef.size,
      mime: fileRef.mime,
    });
    await api.sendMessage(
      {
        id: message.id,
        fileR2Key: r2Key,
        fileIv: encrypted.iv,
        fileMeta: meta.ciphertext,
        fileMetaIv: meta.iv,
      },
      auth,
    );
    await upsertMessage({ ...message, file: fileRef, status: "sent" });
  } catch (error) {
    await upsertMessage({ ...message, status: "failed" });
    showToast(`Could not send file: ${errorMessage(error)}`, "error");
  }
}

export async function sendFileMessages(files: readonly File[]): Promise<void> {
  for (const file of files) {
    await sendFileMessage(file);
  }
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
// Session lifecycle
// ---------------------------------------------------------------------------

export async function logout(): Promise<void> {
  stopSync();
  await resetSession();
  view.value = "chat";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
