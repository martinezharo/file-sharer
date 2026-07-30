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
  exportSigningPublicKey,
  generateDeviceKeyPair,
  generateGroupKey,
  generateSigningKeyPair,
  importGroupKey,
  importPublicKey,
  randomId,
  randomToken,
  sha256Hex,
  unwrapPairingPackage,
  wrapPairingPackage,
} from "./crypto/crypto";
import {
  createAttestation,
  identityBundles,
  pinScannedDevice,
  reconcileDevices,
  seedInheritedIdentities,
} from "./crypto/identity";
import { createKeyring, currentKey, keyForEpoch } from "./crypto/keyring";
import {
  META_SIGNING_KEYPAIR,
  META_SIGNING_KEY_PUBLISHED,
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
  applySigningKeyPair,
  authHeaders,
  deviceKeyPair,
  keyring,
  persistSession,
  resetSession,
  session,
  sessionRevoked,
  signingKeyPair,
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
  /**
   * Optional only for a link that was already in flight when the app updated
   * to a version that signs: that device finishes pairing without an identity
   * and mints one on its next launch, like any other pre-signing device.
   */
  signingKeyPair?: CryptoKeyPair;
  payload: PairingQrPayload;
}

let linkTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Onboarding: create a new space (this device becomes the first member)
// ---------------------------------------------------------------------------

export async function createSpace(deviceName: string): Promise<void> {
  const keyPair = await generateDeviceKeyPair();
  const signingPair = await generateSigningKeyPair();
  const newGroupKey = await generateGroupKey();
  const token = randomToken();
  const groupId = randomId();
  const deviceId = randomId();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const signingPublicKey = await exportSigningPublicKey(signingPair.publicKey);
  const name = await encryptName(newGroupKey, deviceName, deviceId);

  // The founding device signs its own keys. It is the root every device that
  // joins later inherits, so "who belongs to this space" is anchored on the
  // device that created it instead of on the roster the server serves.
  const attestation = await createAttestation(signingPair.privateKey, {
    groupId,
    deviceId,
    publicKey,
    signingPublicKey,
    signerDeviceId: deviceId,
    issuedAt: Date.now(),
  });

  await api.createGroup({
    groupId,
    deviceAuthTokenHash: await sha256Hex(token),
    device: { id: deviceId, publicKey, signingPublicKey },
    encryptedName: name.ciphertext,
    nameIv: name.iv,
    attestation,
  });

  const newSession: Session = { groupId, deviceId, deviceName, deviceAuthToken: token };
  await persistSession(
    newSession,
    createKeyring(newGroupKey, INITIAL_KEY_EPOCH),
    keyPair,
    signingPair,
  );
  await pinScannedDevice({ deviceId, publicKey, signingPublicKey });
  await metaSet(META_SIGNING_KEY_PUBLISHED, true);
  await loadMessages();
  startSync();
}

// ---------------------------------------------------------------------------
// Signing identity (upgrade path for sessions that predate sender authenticity)
// ---------------------------------------------------------------------------

/** In-memory guard so a published key isn't re-checked on every sync pass. */
let signingKeyPublished = false;

/**
 * Make sure this device has a signing identity and that its peers know the
 * public half.
 *
 * A session created before sender authenticity has no signing keypair, and
 * asking the user to link the device again to get one would be exactly the kind
 * of disruption rotation was careful to avoid. So it mints one silently on the
 * next launch and announces it. Until that lands, the device simply sends
 * unsigned messages, which peers treat as unverifiable rather than forged.
 *
 * Safe to call repeatedly: it is a no-op once the key is published.
 */
export async function ensureSigningIdentity(): Promise<void> {
  if (signingKeyPublished || !session.value || sessionRevoked.value) return;
  if (await metaGet<boolean>(META_SIGNING_KEY_PUBLISHED)) {
    signingKeyPublished = true;
    return;
  }

  let pair = signingKeyPair.value;
  if (!pair) {
    pair = await generateSigningKeyPair();
    // Persist before publishing: announcing a key we then failed to store would
    // leave peers expecting signatures this device cannot produce.
    await metaSet(META_SIGNING_KEYPAIR, pair);
    applySigningKeyPair(pair);
  }

  const signingPublicKey = await exportSigningPublicKey(pair.publicKey);
  // Record our own identity locally either way: it is what makes the
  // attestations this device issues verifiable to the devices it adds.
  const ownKeyPair = deviceKeyPair.value;
  if (ownKeyPair) {
    await pinScannedDevice({
      deviceId: session.value.deviceId,
      publicKey: await exportPublicKey(ownKeyPair.publicKey),
      signingPublicKey,
    });
  }

  try {
    await api.publishSigningKey({ signingPublicKey }, authHeaders());
  } catch {
    // Offline, or the server already holds a different key for this device
    // (only possible after a local wipe that kept the session). Either way the
    // next launch tries again; messages stay unsigned meanwhile.
    return;
  }
  await metaSet(META_SIGNING_KEY_PUBLISHED, true);
  signingKeyPublished = true;
}

// ---------------------------------------------------------------------------
// Onboarding: link this device to an existing space (this device is the joiner)
// ---------------------------------------------------------------------------

export async function startLinking(deviceName: string): Promise<void> {
  const keyPair = await generateDeviceKeyPair();
  const signingPair = await generateSigningKeyPair();
  const deviceId = randomId();
  const pairingId = randomId();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const signingPublicKey = await exportSigningPublicKey(signingPair.publicKey);

  // The signing key rides in the QR code so the adding device learns it
  // out-of-band and can attest to it for everyone else.
  const payload: PairingQrPayload = {
    v: 1,
    pairingId,
    deviceId,
    deviceName,
    publicKey,
    signingPublicKey,
  };
  await api.pairingRequest(pairingId, { device: { id: deviceId, publicKey, signingPublicKey } });

  const pending: PendingPairing = { keyPair, signingKeyPair: signingPair, payload };
  await metaSet("pendingPairing", pending);

  linking.value = {
    pairingId,
    deviceId,
    deviceName,
    qrText: JSON.stringify(payload),
    status: "waiting",
  };
  startLinkPolling(pending);
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
  startLinkPolling(pending);
}

function startLinkPolling(pending: PendingPairing): void {
  stopLinkPolling();
  linkTimer = setInterval(() => void pollLink(pending), 2500);
}

function stopLinkPolling(): void {
  if (linkTimer) clearInterval(linkTimer);
  linkTimer = null;
}

async function pollLink(pending: PendingPairing): Promise<void> {
  const { keyPair, signingKeyPair: signingPair, payload } = pending;
  const pairingId = payload.pairingId;
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
    await persistSession(
      newSession,
      createKeyring(recoveredGroupKey, recovered.keyEpoch),
      keyPair,
      signingPair,
    );
    // A link started before this device had a signing identity gets one on the
    // next launch instead — the QR its introducer scanned carried no signing
    // key, so there is nothing to attest to now anyway.
    if (signingPair) await metaSet(META_SIGNING_KEY_PUBLISHED, true);
    // The package came through a channel anchored out-of-band (the introducer
    // scanned our QR), so the roster inside it is the trusted starting point
    // for everything this device will verify from now on.
    if (recovered.roster) await seedInheritedIdentities(recovered.roster);
    await pinScannedDevice({
      deviceId: payload.deviceId,
      publicKey: payload.publicKey,
      ...(payload.signingPublicKey ? { signingPublicKey: payload.signingPublicKey } : {}),
    });
    await metaDelete("pendingPairing");
    // Best-effort: the slot is already TTL-reaped by cron, this just avoids
    // leaving the (encrypted) package reachable until then.
    void api.pairingDelete(pairingId).catch(() => {});
    await loadMessages();
    startSync();
    void ensureSigningIdentity();
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
      // Hand over our verified view of the space along with the key: without it
      // the joining device would have to believe the server's roster, and would
      // have no trusted key to check any attestation against.
      roster: await identityBundles(),
    },
    payload.pairingId,
  );

  // The QR was read out-of-band, so this is the one moment anyone learns this
  // device's keys through a channel the server cannot touch. Signing them is
  // what lets every *other* device verify this newcomer without having to
  // trust the roster it is served.
  const signingPair = signingKeyPair.value;
  const attestation =
    signingPair && payload.signingPublicKey
      ? await createAttestation(signingPair.privateKey, {
          groupId: currentSession.groupId,
          deviceId: payload.deviceId,
          publicKey: payload.publicKey,
          signingPublicKey: payload.signingPublicKey,
          signerDeviceId: currentSession.deviceId,
          issuedAt: Date.now(),
        })
      : undefined;
  // The joining device can't encrypt its own name (it has no GroupKey yet), so
  // this device encrypts the scanned (out-of-band) name on its behalf.
  const name = await encryptName(currentGroupKey, payload.deviceName, payload.deviceId);

  await api.pairingComplete(
    payload.pairingId,
    {
      wrappedPackage: wrapped.wrappedPackage,
      ephemeralPublicKey: wrapped.ephemeralPublicKey,
      scannedPublicKey: payload.publicKey,
      ...(payload.signingPublicKey ? { scannedSigningPublicKey: payload.signingPublicKey } : {}),
      ...(attestation ? { attestation } : {}),
      encryptedName: name.ciphertext,
      nameIv: name.iv,
      deviceAuthTokenHash: await sha256Hex(deviceAuthToken),
      keyEpoch: ring.current,
    },
    authHeaders(),
  );

  // Pin what we scanned: a later rotation refuses to wrap the new GroupKey for
  // a device whose key changed since, and messages from it are verified against
  // this signing key rather than whatever the roster later claims.
  await pinScannedDevice({
    deviceId: payload.deviceId,
    publicKey: payload.publicKey,
    ...(payload.signingPublicKey ? { signingPublicKey: payload.signingPublicKey } : {}),
  });
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
  const currentSession = session.value;
  if (!ring || !currentSession) throw new Error("Not signed in");
  const { devices, currentRole, keyEpoch, rotationPending } = await api.listDevices(authHeaders());
  // Seeing the roster is also how a device learns the keys of members it did
  // not add itself, so this is where those get verified (crypto/identity.ts).
  await reconcileDevices(devices, currentSession.groupId);
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
  // The next space this device joins mints its own identity, so the guard must
  // not carry the previous session's answer over.
  signingKeyPublished = false;
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
