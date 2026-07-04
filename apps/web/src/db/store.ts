import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { LocalMessage } from "../types";

interface FileSharerDB extends DBSchema {
  /** Key-value store for session, crypto keys, sync cursor, pending pairing. */
  meta: { key: string; value: unknown };
  messages: {
    key: string;
    value: LocalMessage;
    indexes: { "by-createdAt": number };
  };
  /** Decrypted file blobs cached locally for preview/offline access. */
  files: { key: string; value: { r2Key: string; blob: Blob } };
}

const DB_NAME = "file-sharer";
const DB_VERSION = 1;

/**
 * Well-known `meta` keys. Shared between the page (state/session.ts) and the
 * service worker (sync/outbox.ts), which reads credentials straight from
 * IndexedDB because it has no access to the page's signals.
 */
export const META_SESSION = "session";
export const META_GROUP_KEY = "groupKey";
export const META_DEVICE_KEYPAIR = "deviceKeyPair";

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

export async function putMessage(message: LocalMessage): Promise<void> {
  await (await db()).put("messages", message);
}

export async function getMessage(id: string): Promise<LocalMessage | undefined> {
  return (await db()).get("messages", id);
}

export async function allMessages(): Promise<LocalMessage[]> {
  return (await db()).getAllFromIndex("messages", "by-createdAt");
}

export async function deleteMessage(id: string): Promise<void> {
  await (await db()).delete("messages", id);
}

// --- files ---

export async function putFile(r2Key: string, blob: Blob): Promise<void> {
  await (await db()).put("files", { r2Key, blob });
}

export async function getFile(r2Key: string): Promise<Blob | undefined> {
  return (await (await db()).get("files", r2Key))?.blob;
}

export async function deleteFile(r2Key: string): Promise<void> {
  await (await db()).delete("files", r2Key);
}

/** Wipe everything (used on logout / space reset). */
export async function clearAll(): Promise<void> {
  const database = await db();
  await Promise.all([
    database.clear("meta"),
    database.clear("messages"),
    database.clear("files"),
  ]);
}
