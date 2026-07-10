import { POLL_INTERVAL_MS, type PendingMessage } from "@file-sharer/shared";
import { type Auth, api } from "../api/client";
import { getFile, putFile } from "../db/store";
import { decryptFile, decryptJson, decryptName, decryptText } from "../crypto/crypto";
import { applyMessageUpdate, getLocalMessage, upsertMessage } from "../state/messages";
import { authHeaders, groupKey, session } from "../state/session";
import type { FileRef, LocalMessage } from "../types";
import { requestBackgroundSync } from "./background";
import { flushQueuedOutbox, type OutboxUpdateBroadcast } from "./outbox";

interface FileMeta {
  name: string;
  size: number;
  mime: string;
}

/**
 * How many incoming files are fetched at once. Bounded because each download
 * holds its full ciphertext + plaintext (up to 50 MB each) in memory while
 * decrypting.
 */
const MAX_PARALLEL_DOWNLOADS = 4;

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

    // Outbox flush is shared with the service worker (sync/outbox.ts); it
    // persists every state change itself, so only the signal needs updating.
    const flushed = await flushQueuedOutbox(applyMessageUpdate);
    if (flushed.remaining > 0) {
      // Couldn't send everything (offline/flaky network): let the browser
      // retry from the service worker even if the app gets closed.
      void requestBackgroundSync();
    }

    const { messages: pending } = await api.pendingMessages(auth);

    // First register every incoming message (decrypt just the metadata) so
    // all bubbles appear at once, then fetch the attachments concurrently
    // instead of one after another.
    const registered: LocalMessage[] = [];
    for (const pendingMessage of pending) {
      try {
        registered.push(await registerIncoming(pendingMessage, key));
      } catch {
        // Leave it pending; the next poll will retry.
      }
    }

    await runWithConcurrency(registered, MAX_PARALLEL_DOWNLOADS, async (local) => {
      try {
        await downloadAndAck(local, key, auth);
      } catch {
        // Leave it pending; the next poll will retry.
      }
    });
  } catch {
    // Network/transient errors are silently retried on the next tick.
  } finally {
    running = false;
  }
}

// When the service worker flushes the outbox in the background while the app
// is (still or again) open, mirror its persisted updates into the signal so
// bubbles flip from "uploading" to "sent" live.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as Partial<OutboxUpdateBroadcast> | null;
    if (data?.type === "outbox-message-updated" && data.message) {
      applyMessageUpdate(data.message);
    }
  });
}

/** Run `fn` over `items`, keeping at most `limit` invocations in flight. */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      await fn(items[next++]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Decrypt an incoming message's metadata and persist it locally (without
 * downloading its file yet), so it shows up in the UI immediately.
 */
async function registerIncoming(
  pendingMessage: PendingMessage,
  key: CryptoKey,
): Promise<LocalMessage> {
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

  return local;
}

/**
 * Download + decrypt a registered message's file (if any), then ack it. For
 * file messages we only confirm receipt (ack) AFTER a successful download +
 * decrypt, so the server never deletes a file we haven't received.
 */
async function downloadAndAck(message: LocalMessage, key: CryptoKey, auth: Auth): Promise<void> {
  let local = message;

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
    await api.ackMessage(local.id, auth);
    await upsertMessage({ ...local, acked: true });
  }
}
