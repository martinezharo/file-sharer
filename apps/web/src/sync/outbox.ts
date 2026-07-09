/**
 * Outgoing-message flush, shared by the page (sync/sync.ts) and the service
 * worker (sw.ts, Background Sync). It must therefore stay context-neutral:
 * no DOM, no signals — session, keys and the queue are read from IndexedDB.
 *
 * Concurrency: the page's poll loop and a background `sync` event can fire at
 * the same time. A Web Lock serializes whole flush passes, and each message is
 * re-read from IndexedDB right before sending so a queue entry that another
 * context already flushed is skipped instead of sent twice. As a last resort
 * the server rejects a duplicate message id with `conflict`, which is treated
 * as "already sent".
 */

import { type Auth, ApiError, api } from "../api/client";
import {
  bufToBase64Url,
  encryptFile,
  encryptJson,
  encryptText,
  randomBytes,
} from "../crypto/crypto";
import {
  META_GROUP_KEY,
  META_SESSION,
  allMessages,
  getFile,
  getMessage,
  metaGet,
  putMessage,
} from "../db/store";
import type { LocalMessage, Session } from "../types";

/** Background Sync tag registered by the page and handled by the SW. */
export const OUTBOX_SYNC_TAG = "file-sharer-outbox";

/** Cross-context lock name serializing outbox flushes (page ↔ SW). */
const OUTBOX_LOCK = "file-sharer-outbox";

/** postMessage shape the SW broadcasts after persisting a message update. */
export interface OutboxUpdateBroadcast {
  type: "outbox-message-updated";
  message: LocalMessage;
}

export interface FlushResult {
  /** Messages successfully handed to the server in this pass. */
  sent: number;
  /** Messages permanently rejected (marked "failed"). */
  failed: number;
  /** Messages still queued (transient/network errors) — retry later. */
  remaining: number;
}

/** Called after each persisted state change so live UIs can update. */
type NotifyUpdate = (message: LocalMessage) => void;

function isFlushable(message: LocalMessage): boolean {
  // "uploading" is included so an upload interrupted by a crash/kill is
  // retried on the next pass instead of being stuck forever.
  return (
    message.direction === "out" &&
    (message.status === "queued" || message.status === "uploading")
  );
}

/**
 * Flush every queued outgoing message (text *and* files). Files are uploaded
 * from the locally-cached original, so a failed send stays queued and is
 * retried on the next pass exactly like text.
 */
export async function flushQueuedOutbox(notify?: NotifyUpdate): Promise<FlushResult> {
  // Web Locks exists in both window and worker scopes on every browser that
  // has Background Sync; fall back to running unlocked elsewhere.
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(OUTBOX_LOCK, () => doFlush(notify));
  }
  return doFlush(notify);
}

async function doFlush(notify?: NotifyUpdate): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, failed: 0, remaining: 0 };

  const [session, key] = await Promise.all([
    metaGet<Session>(META_SESSION),
    metaGet<CryptoKey>(META_GROUP_KEY),
  ]);
  if (!session || !key) return result;
  const auth: Auth = { token: session.groupAuthToken, deviceId: session.deviceId };

  const queued = (await allMessages()).filter(isFlushable);
  for (const stale of queued) {
    // Re-read: another context may have flushed this entry meanwhile.
    const message = await getMessage(stale.id);
    if (!message || !isFlushable(message)) continue;

    try {
      if (message.file) {
        await sendQueuedFile(message, key, auth, notify);
      } else if (message.text !== undefined) {
        await sendQueuedText(message, key, auth, notify);
      } else {
        continue;
      }
      result.sent++;
    } catch (error) {
      // Re-read instead of reusing `message`: sendQueuedFile pins `file.iv`
      // mid-flight and that pin must survive into the retry (see above).
      const current = (await getMessage(message.id)) ?? message;
      if (error instanceof ApiError && !isTransientError(error)) {
        await update({ ...current, status: "failed" }, notify);
        result.failed++;
      } else {
        // NetworkError or transient ApiError (rate_limited / internal): back to
        // "queued" for the next attempt. The "uploading" → "queued" reset also
        // keeps the UI honest while offline / being rate-limited.
        await update({ ...current, status: "queued" }, notify);
        result.remaining++;
      }
    }
  }
  return result;
}

async function update(message: LocalMessage, notify?: NotifyUpdate): Promise<void> {
  // If the user deleted the message locally mid-flush, don't resurrect it.
  if (!(await getMessage(message.id))) return;
  await putMessage(message);
  notify?.(message);
}

/**
 * The server rejects an already-registered message id with `conflict`. For our
 * own randomly-generated ids that only means a previous attempt succeeded but
 * the local status update was lost (e.g. the app was killed mid-flush).
 */
function isAlreadySent(error: unknown): boolean {
  return error instanceof ApiError && error.code === "conflict";
}

/**
 * A server `ApiError` that's worth retrying on the next pass instead of
 * marking the message permanently failed. `rate_limited` is the textbook
 * example: the server is explicitly telling us to back off, so the next
 * flush should pick the message up again. `internal` covers transient 5xx
 * where the call might succeed on retry; the alternative (marking failed)
 * would silently drop the user's queued send on a single bad request.
 */
function isTransientError(error: ApiError): boolean {
  return error.code === "rate_limited" || error.code === "internal";
}

async function sendQueuedText(
  message: LocalMessage,
  key: CryptoKey,
  auth: Auth,
  notify?: NotifyUpdate,
): Promise<void> {
  const encrypted = await encryptText(key, message.text!, `text:${message.id}`);
  try {
    await api.sendMessage(
      { id: message.id, encryptedPayload: encrypted.ciphertext, iv: encrypted.iv },
      auth,
    );
  } catch (error) {
    if (!isAlreadySent(error)) throw error;
  }
  await update({ ...message, status: "sent" }, notify);
}

async function sendQueuedFile(
  message: LocalMessage,
  key: CryptoKey,
  auth: Auth,
  notify?: NotifyUpdate,
): Promise<void> {
  let file = message.file!;
  const blob = await getFile(file.r2Key);
  if (!blob) {
    // The local original is gone; we can never re-upload it.
    await update({ ...message, status: "failed" }, notify);
    return;
  }

  // Pin the file IV *before* uploading and reuse it on retries: with the same
  // IV the re-encrypted ciphertext is byte-identical, so a retry that races a
  // previously-registered send (see `isAlreadySent`) can never leave R2 holding
  // ciphertext that doesn't match the IV the server already stored.
  if (!file.iv) file = { ...file, iv: bufToBase64Url(randomBytes(12)) };
  await update({ ...message, file, status: "uploading" }, notify);

  const encrypted = await encryptFile(key, await blob.arrayBuffer(), `file:${message.id}`, file.iv);
  await api.uploadFile(file.r2Key, encrypted.ciphertext, auth);
  const meta = await encryptJson(
    key,
    { name: file.name, size: file.size, mime: file.mime },
    `meta:${message.id}`,
  );
  try {
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
  } catch (error) {
    if (!isAlreadySent(error)) throw error;
  }
  await update({ ...message, file, status: "sent" }, notify);
}
