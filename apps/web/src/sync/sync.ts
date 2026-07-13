import { POLL_INTERVAL_MS, type PendingMessage } from "@file-sharer/shared";
import { ApiError, type Auth, api } from "../api/client";
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

/**
 * A decrypt failure is almost always permanent (tampered/poisoned ciphertext
 * fails identically forever), but a handful of retries is cheap insurance
 * against one-off corruption (e.g. a truncated download). Past this budget the
 * message is marked corrupted and ACKED, so a hostile or buggy server can't
 * make us re-download up to 50 MB every poll for 24 h. The counter lives in
 * memory: giving up is persisted through the ack itself (the message stops
 * being pending), so a reload can only ever re-spend the budget, not undo it.
 */
const MAX_DECRYPT_ATTEMPTS = 3;
const decryptAttempts = new Map<string, number>();

/** Record one failed decrypt for `scope`; true when the budget is exhausted. */
function decryptBudgetExhausted(scope: string): boolean {
  const attempts = (decryptAttempts.get(scope) ?? 0) + 1;
  if (attempts >= MAX_DECRYPT_ATTEMPTS) {
    decryptAttempts.delete(scope);
    return true;
  }
  decryptAttempts.set(scope, attempts);
  return false;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let activePageFlush: AbortController | null = null;
const onFocus = (): void => void syncNow();

function handOffOutboxToServiceWorker(): void {
  // Mobile browsers aggressively freeze/kill hidden pages. Abort any
  // page-owned upload before the OS suspends us, then ask the service worker
  // to finish from IndexedDB via Background Sync.
  activePageFlush?.abort();
  void requestBackgroundSync();
}

const onVisibilityChange = (): void => {
  if (document.visibilityState === "hidden") handOffOutboxToServiceWorker();
};

export function startSync(): void {
  stopSync();
  void syncNow();
  timer = setInterval(() => void syncNow(), POLL_INTERVAL_MS);
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onFocus);
  window.addEventListener("pagehide", handOffOutboxToServiceWorker);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

export function stopSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("online", onFocus);
  window.removeEventListener("pagehide", handOffOutboxToServiceWorker);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  activePageFlush?.abort();
  activePageFlush = null;
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
    const pageFlush = new AbortController();
    activePageFlush = pageFlush;
    const flushed = await flushQueuedOutbox(applyMessageUpdate, { signal: pageFlush.signal });
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
    activePageFlush = null;
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
    // Decrypt failures here are permanent for a given ciphertext, so retrying
    // forever just burns CPU every poll. Below the retry budget we rethrow
    // (leave pending, retry next pass); past it the payload is dropped and the
    // message registered as corrupted so it gets acked and stops coming back.
    let corrupted = false;

    let text: string | undefined;
    if (pendingMessage.encryptedPayload && pendingMessage.iv) {
      try {
        text = await decryptText(
          key,
          pendingMessage.encryptedPayload,
          pendingMessage.iv,
          `text:${pendingMessage.id}`,
        );
        decryptAttempts.delete(`text:${pendingMessage.id}`);
      } catch (error) {
        if (!decryptBudgetExhausted(`text:${pendingMessage.id}`)) throw error;
        corrupted = true;
      }
    }

    let file: FileRef | undefined;
    if (
      pendingMessage.fileR2Key &&
      pendingMessage.fileIv &&
      pendingMessage.fileMeta &&
      pendingMessage.fileMetaIv
    ) {
      try {
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
        decryptAttempts.delete(`meta:${pendingMessage.id}`);
      } catch (error) {
        if (!decryptBudgetExhausted(`meta:${pendingMessage.id}`)) throw error;
        corrupted = true; // unusable metadata: the file is dropped with it
      }
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
      corrupted: corrupted || undefined,
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
  const file = local.file;

  if (file && needsDownload(local.fileState)) {
    await upsertMessage({ ...local, fileState: "downloading" });

    let ciphertext: ArrayBuffer;
    try {
      ciphertext = await api.downloadFile(file.r2Key, auth);
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") {
        // The blob is gone server-side (TTL/cleanup) and will never come
        // back; record that and fall through to the ack so the message
        // stops being re-polled.
        local = { ...local, fileState: "expired" };
        await upsertMessage(local);
      } else {
        await upsertMessage({ ...local, fileState: "error" });
        return; // transient (network/5xx): do not ack; retry next pass
      }
    }

    if (local.fileState !== "expired") {
      let plaintext: ArrayBuffer;
      try {
        plaintext = await decryptFile(key, ciphertext!, file.iv, `file:${local.id}`);
        decryptAttempts.delete(`file:${local.id}`);
      } catch (error) {
        if (!decryptBudgetExhausted(`file:${local.id}`)) {
          await upsertMessage({ ...local, fileState: "error" });
          return; // do not ack; retry next pass
        }
        // Poisoned ciphertext: give up and fall through to the ack, so we
        // stop re-downloading up to 50 MB on every poll until the TTL.
        local = { ...local, fileState: "corrupted" };
        await upsertMessage(local);
      }

      if (local.fileState !== "corrupted") {
        try {
          await putFile(file.r2Key, new Blob([plaintext!], { type: file.mime }));
        } catch {
          // Local storage failure (quota, …) is transient, unlike a decrypt
          // failure — never spend the decrypt budget or ack on it.
          await upsertMessage({ ...local, fileState: "error" });
          return;
        }
        local = { ...local, fileState: "downloaded" };
        await upsertMessage(local);
      }
    }
  }

  if (!local.acked) {
    await api.ackMessage(local.id, auth);
    await upsertMessage({ ...local, acked: true });
  }
}

/** File states that still want a download attempt on this pass. */
function needsDownload(state: LocalMessage["fileState"]): boolean {
  return state === "remote" || state === "downloading" || state === "error";
}
