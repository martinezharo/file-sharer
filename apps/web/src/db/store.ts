import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { LocalMessage } from "../types";
import {
  type Sealed,
  fileContext,
  messageContext,
  openBlob,
  openJson,
  sealBlob,
  sealJson,
} from "./atrest";

/**
 * A message row. When an at-rest lock is set the payload is sealed and only the
 * key path and the sort index stay readable, so history can still be listed in
 * order without holding the key (see db/atrest.ts).
 */
type StoredMessage =
  | LocalMessage
  | { id: string; createdAt: number; sealed: Sealed; mime?: undefined };

/** A cached decrypted file. `iv` present = the blob holds ciphertext. */
interface StoredFile {
  r2Key: string;
  blob: Blob;
  iv?: string;
  /** Preserved separately: sealing a Blob loses its type. */
  mime?: string;
}

interface FileSharerDB extends DBSchema {
  /** Key-value store for session, crypto keys, sync cursor, pending pairing. */
  meta: { key: string; value: unknown };
  messages: {
    key: string;
    value: StoredMessage;
    indexes: { "by-createdAt": number };
  };
  /** Decrypted file blobs cached locally for preview/offline access. */
  files: { key: string; value: StoredFile };
}

const DB_NAME = "file-sharer";
const DB_VERSION = 1;

/**
 * Well-known `meta` keys. Shared between the page (state/session.ts) and the
 * service worker (sync/outbox.ts), which reads credentials straight from
 * IndexedDB because it has no access to the page's signals.
 */
export const META_SESSION = "session";
/** Pre-rotation single GroupKey. Read once, then folded into META_KEYRING. */
export const META_GROUP_KEY = "groupKey";
/** Every GroupKey epoch this device holds (crypto/keyring.ts). */
export const META_KEYRING = "keyring";
export const META_DEVICE_KEYPAIR = "deviceKeyPair";
/** This device's ECDSA signing identity (crypto/identity.ts). */
export const META_SIGNING_KEYPAIR = "signingKeyPair";
/** True once the signing public key reached the server (see actions.ensureSigningIdentity). */
export const META_SIGNING_KEY_PUBLISHED = "signingKeyPublished";
/** Pre-signing pins: a plain deviceId → ECDH key map, folded into META_DEVICE_IDENTITIES. */
export const META_DEVICE_PINS = "devicePins";
/** What we believe about the other devices' keys, and why (crypto/identity.ts). */
export const META_DEVICE_IDENTITIES = "deviceIdentities";
/**
 * The sealed envelope holding this device's secrets while an at-rest lock is
 * set (crypto/vault.ts). Its presence *is* the lock: whenever it exists,
 * META_SESSION and META_KEYRING are absent from storage entirely.
 */
export const META_VAULT = "vault";
/** Key epoch the last recovery file was exported at, so a stale one can be flagged. */
export const META_RECOVERY_EPOCH = "recoveryExportEpoch";
/** Ids deleted for everyone, so a late copy is dropped instead of reappearing (db/deletions.ts). */
export const META_DELETED_MESSAGES = "deletedMessages";

let dbPromise: Promise<IDBPDatabase<FileSharerDB>> | null = null;

function db(): Promise<IDBPDatabase<FileSharerDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FileSharerDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        database.createObjectStore("meta");
        const messages = database.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("by-createdAt", "createdAt");
        database.createObjectStore("files", { keyPath: "r2Key" });
      },
    });
  }
  return dbPromise;
}

// --- meta (CryptoKeys are structured-cloneable, so they live here directly) ---

export async function metaGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get("meta", key)) as T | undefined;
}

export async function metaSet(key: string, value: unknown): Promise<void> {
  await (await db()).put("meta", value, key);
}

export async function metaDelete(key: string): Promise<void> {
  await (await db()).delete("meta", key);
}

// --- messages ---

/** Encode a message for storage, sealing its payload when a lock is set. */
async function toStored(message: LocalMessage): Promise<StoredMessage> {
  const sealed = await sealJson(message, messageContext(message.id));
  if (!sealed) return message;
  return { id: message.id, createdAt: message.createdAt, sealed };
}

/** Decode a stored row. Undefined when it is sealed and this context is locked. */
async function fromStored(stored: StoredMessage | undefined): Promise<LocalMessage | undefined> {
  if (!stored) return undefined;
  if (!("sealed" in stored) || !stored.sealed) return stored as LocalMessage;
  return openJson<LocalMessage>(stored.sealed, messageContext(stored.id));
}

export async function putMessage(message: LocalMessage): Promise<void> {
  await (await db()).put("messages", await toStored(message));
}

/**
 * Persist a batch of outgoing file messages and their source blobs atomically.
 * A mobile suspension can therefore never leave half a selected batch queued,
 * or a message whose upload source was not committed yet.
 */
export async function putOutgoingFileMessages(
  entries: readonly { message: LocalMessage; blob: Blob }[],
): Promise<void> {
  if (entries.length === 0) return;
  // Sealing is async and IndexedDB transactions do not survive an await that
  // isn't a request, so everything is encrypted first and written after.
  const prepared = await Promise.all(
    entries.map(async ({ message, blob }) => ({
      stored: await toStored(message),
      file: await toStoredFile(message.file!.r2Key, blob),
    })),
  );
  const database = await db();
  const transaction = database.transaction(["messages", "files"], "readwrite");
  await Promise.all([
    ...prepared.map(({ stored }) => transaction.objectStore("messages").put(stored)),
    ...prepared.map(({ file }) => transaction.objectStore("files").put(file)),
    transaction.done,
  ]);
}

export async function getMessage(id: string): Promise<LocalMessage | undefined> {
  return fromStored(await (await db()).get("messages", id));
}

/**
 * Every message, oldest first. While locked this is empty rather than an
 * error: the only caller that can run locked is the service worker's outbox
 * flush, which correctly does nothing without a session either.
 */
export async function allMessages(): Promise<LocalMessage[]> {
  const rows = await (await db()).getAllFromIndex("messages", "by-createdAt");
  const opened = await Promise.all(rows.map((row) => fromStored(row)));
  return opened.filter((message): message is LocalMessage => message !== undefined);
}

export async function deleteMessage(id: string): Promise<void> {
  await (await db()).delete("messages", id);
}

// --- files ---

async function toStoredFile(r2Key: string, blob: Blob): Promise<StoredFile> {
  const sealed = await sealBlob(blob, fileContext(r2Key));
  if (!sealed) return { r2Key, blob };
  return { r2Key, blob: new Blob([sealed.ct]), iv: sealed.iv, mime: blob.type };
}

export async function putFile(r2Key: string, blob: Blob): Promise<void> {
  await (await db()).put("files", await toStoredFile(r2Key, blob));
}

export async function getFile(r2Key: string): Promise<Blob | undefined> {
  const stored = await (await db()).get("files", r2Key);
  if (!stored) return undefined;
  if (!stored.iv) return stored.blob;
  return openBlob(stored.blob, stored.iv, fileContext(r2Key), stored.mime ?? "");
}

export async function deleteFile(r2Key: string): Promise<void> {
  await (await db()).delete("files", r2Key);
}

/**
 * Re-encrypt every message and file under `target`, reading through whatever
 * key this context currently holds.
 *
 * This is the whole migration between "no lock" and "locked": turning a lock on
 * passes the new content key, turning it off passes null. Rows are rewritten
 * one at a time rather than collected first — a history with a few 50 MB
 * attachments would not survive being held in memory all at once.
 *
 * A row that cannot be opened is left untouched. That cannot happen from either
 * caller (both run with the previous state readable), and skipping beats
 * replacing content with something unreadable.
 */
export async function rewriteLocalContent(target: CryptoKey | null): Promise<void> {
  const database = await db();

  for (const key of await database.getAllKeys("messages")) {
    const message = await fromStored(await database.get("messages", key));
    if (!message) continue;
    const sealed = await sealJson(message, messageContext(message.id), target);
    await database.put(
      "messages",
      sealed ? { id: message.id, createdAt: message.createdAt, sealed } : message,
    );
  }

  for (const key of await database.getAllKeys("files")) {
    const stored = await database.get("files", key);
    if (!stored) continue;
    const blob = stored.iv
      ? await openBlob(stored.blob, stored.iv, fileContext(stored.r2Key), stored.mime ?? "")
      : stored.blob;
    if (!blob) continue;
    const sealed = await sealBlob(blob, fileContext(stored.r2Key), target);
    await database.put(
      "files",
      sealed
        ? { r2Key: stored.r2Key, blob: new Blob([sealed.ct]), iv: sealed.iv, mime: blob.type }
        : { r2Key: stored.r2Key, blob },
    );
  }
}

/** Wipe everything (used on logout / space reset). */
export async function clearAll(): Promise<void> {
  const database = await db();
  await Promise.all([database.clear("meta"), database.clear("messages"), database.clear("files")]);
}
