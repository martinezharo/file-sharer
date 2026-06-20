import { POLL_INTERVAL_MS, type PendingMessage } from "@file-sharer/shared";
import { type Auth, ApiError, api } from "../api/client";
import { putFile } from "../db/store";
import { decryptFile, decryptJson, decryptText, encryptText } from "../crypto/crypto";
import { getLocalMessage, messages, upsertMessage } from "../state/messages";
import { authHeaders, groupKey, session } from "../state/session";
import type { FileRef, LocalMessage, Session } from "../types";

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
    await flushOutbox(auth, key, currentSession);

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

/** Resend any text messages composed while offline. */
async function flushOutbox(auth: Auth, key: CryptoKey, _session: Session): Promise<void> {
  const queued = messages.value.filter(
    (m) => m.direction === "out" && m.status === "queued" && m.text !== undefined && !m.file,
  );
  for (const message of queued) {
    try {
      const encrypted = await encryptText(key, message.text!);
      await api.sendMessage(
        { id: message.id, encryptedPayload: encrypted.ciphertext, iv: encrypted.iv },
        auth,
      );
      await upsertMessage({ ...message, status: "sent" });
    } catch (error) {
      if (error instanceof ApiError) {
        await upsertMessage({ ...message, status: "failed" });
      }
      // NetworkError: keep it queued for the next attempt.
    }
  }
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
        ? await decryptText(key, pendingMessage.encryptedPayload, pendingMessage.iv)
        : undefined;

    let file: FileRef | undefined;
    if (
      pendingMessage.fileR2Key &&
      pendingMessage.fileIv &&
      pendingMessage.fileMeta &&
      pendingMessage.fileMetaIv
    ) {
      const meta = await decryptJson<FileMeta>(key, pendingMessage.fileMeta, pendingMessage.fileMetaIv);
      file = {
        r2Key: pendingMessage.fileR2Key,
        iv: pendingMessage.fileIv,
        name: meta.name,
        size: meta.size,
        mime: meta.mime,
      };
    }

    local = {
      id: pendingMessage.id,
      direction: "in",
      senderDeviceId: pendingMessage.senderDeviceId,
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
      const plaintext = await decryptFile(key, ciphertext, local.file.iv);
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
