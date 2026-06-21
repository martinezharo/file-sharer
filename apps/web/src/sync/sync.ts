import { POLL_INTERVAL_MS, type PendingMessage } from "@file-sharer/shared";
import { type Auth, ApiError, api } from "../api/client";
import { getFile, putFile } from "../db/store";
import {
  decryptFile,
  decryptJson,
  decryptName,
  decryptText,
  encryptFile,
  encryptJson,
  encryptText,
} from "../crypto/crypto";
import { getLocalMessage, messages, upsertMessage } from "../state/messages";
import { authHeaders, groupKey, session } from "../state/session";
import type { FileRef, LocalMessage } from "../types";

interface FileMeta {
  name: string;
  size: number;
  mime: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
const onFocus = (): void => void syncNow();

export function startSync(): void {
  stopSync();
  void syncNow();
  timer = setInterval(() => void syncNow(), POLL_INTERVAL_MS);
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onFocus);
}

export function stopSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("online", onFocus);
}

/** Run one sync pass, skipping if one is already in flight. */
export async function syncNow(): Promise<void> {
  if (running) return;
  const currentSession = session.value;
  const key = groupKey.value;
  if (!currentSession || !key) return;

  running = true;
  try {
    const auth = authHeaders();
    await flushOutbox(auth, key);

    const { messages: pending } = await api.pendingMessages(auth);
    for (const pendingMessage of pending) {
      try {
        await processIncoming(pendingMessage, key, auth);
      } catch {
        // Leave it pending; the next poll will retry.
      }
    }
  } catch {
    // Network/transient errors are silently retried on the next tick.
  } finally {
    running = false;
  }
}

/**
 * Flush every queued outgoing message (text *and* files). Files are uploaded
 * from the locally-cached original, so a failed send stays queued and is retried
 * on the next pass exactly like text — no message type is left without retry.
 */
async function flushOutbox(auth: Auth, key: CryptoKey): Promise<void> {
  const queued = messages.value.filter((m) => m.direction === "out" && m.status === "queued");
  for (const message of queued) {
    try {
      if (message.file) {
        await sendQueuedFile(message, key, auth);
      } else if (message.text !== undefined) {
        await sendQueuedText(message, key, auth);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        await upsertMessage({ ...message, status: "failed" });
      }
      // NetworkError: keep it queued for the next attempt.
    }
  }
}

async function sendQueuedText(message: LocalMessage, key: CryptoKey, auth: Auth): Promise<void> {
  const encrypted = await encryptText(key, message.text!, `text:${message.id}`);
  await api.sendMessage(
    { id: message.id, encryptedPayload: encrypted.ciphertext, iv: encrypted.iv },
    auth,
  );
  await upsertMessage({ ...message, status: "sent" });
}

async function sendQueuedFile(message: LocalMessage, key: CryptoKey, auth: Auth): Promise<void> {
  const file = message.file!;
  const blob = await getFile(file.r2Key);
  if (!blob) {
    // The local original is gone; we can never re-upload it.
    await upsertMessage({ ...message, status: "failed" });
    return;
  }
  const encrypted = await encryptFile(key, await blob.arrayBuffer(), `file:${message.id}`);
  await api.uploadFile(file.r2Key, encrypted.ciphertext, auth);
  const meta = await encryptJson(
    key,
    { name: file.name, size: file.size, mime: file.mime },
    `meta:${message.id}`,
  );
  await api.sendMessage(
    {
      id: message.id,
      fileR2Key: file.r2Key,
      fileIv: encrypted.iv,
      fileMeta: meta.ciphertext,
      fileMetaIv: meta.iv,
    },
    auth,
  );
  await upsertMessage({ ...message, file: { ...file, iv: encrypted.iv }, status: "sent" });
}

async function processIncoming(
  pendingMessage: PendingMessage,
  key: CryptoKey,
  auth: Auth,
): Promise<void> {
  let local = getLocalMessage(pendingMessage.id);

  if (!local) {
    const text =
      pendingMessage.encryptedPayload && pendingMessage.iv
        ? await decryptText(key, pendingMessage.encryptedPayload, pendingMessage.iv, `text:${pendingMessage.id}`)
        : undefined;

    let file: FileRef | undefined;
    if (
      pendingMessage.fileR2Key &&
      pendingMessage.fileIv &&
      pendingMessage.fileMeta &&
      pendingMessage.fileMetaIv
    ) {
      const meta = await decryptJson<FileMeta>(
        key,
        pendingMessage.fileMeta,
        pendingMessage.fileMetaIv,
        `meta:${pendingMessage.id}`,
      );
      file = {
        r2Key: pendingMessage.fileR2Key,
        iv: pendingMessage.fileIv,
        name: meta.name,
        size: meta.size,
        mime: meta.mime,
      };
    }

    const senderDeviceName =
      pendingMessage.senderNameEnc && pendingMessage.senderNameIv
        ? await decryptName(
            key,
            pendingMessage.senderNameEnc,
            pendingMessage.senderNameIv,
            pendingMessage.senderDeviceId,
          ).catch(() => pendingMessage.senderDeviceId)
        : pendingMessage.senderDeviceId;

    local = {
      id: pendingMessage.id,
      direction: "in",
      senderDeviceId: pendingMessage.senderDeviceId,
      senderDeviceName,
      text,
      file,
      createdAt: pendingMessage.createdAt,
      status: "sent",
      fileState: file ? "remote" : undefined,
      acked: false,
    };
    await upsertMessage(local);
  }

  // For file messages we only confirm receipt (ack) AFTER a successful
  // download + decrypt, so the server never deletes a file we haven't received.
  if (local.file && local.fileState !== "downloaded") {
    await upsertMessage({ ...local, fileState: "downloading" });
    try {
      const ciphertext = await api.downloadFile(local.file.r2Key, auth);
      const plaintext = await decryptFile(key, ciphertext, local.file.iv, `file:${local.id}`);
      await putFile(local.file.r2Key, new Blob([plaintext], { type: local.file.mime }));
      local = { ...local, fileState: "downloaded" };
      await upsertMessage(local);
    } catch {
      await upsertMessage({ ...local, fileState: "error" });
      return; // do not ack; retry next pass
    }
  }

  if (!local.acked) {
    await api.ackMessage(pendingMessage.id, auth);
    await upsertMessage({ ...local, acked: true });
  }
}
