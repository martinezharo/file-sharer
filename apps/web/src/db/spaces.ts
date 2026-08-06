/**
 * The registry of spaces this device belongs to, and the device-global state
 * that cannot live inside any one of them.
 *
 * A space owns everything about itself — its session, its keys, its history,
 * its cached files — in its own IndexedDB database (db/store.ts). What is left
 * over is exactly two things, and they live here:
 *
 *  - **which spaces exist**, with the local name the user gave them, so `/app`
 *    can list them before any of them is opened, and
 *  - **the at-rest vault envelope**, because a lock protects the *device* (all
 *    of its spaces at once), not a single space.
 *
 * A space's name is local to this device: the server never sees it, and it is
 * handed to a device that joins through the encrypted pairing package rather
 * than stored anywhere shared. While an at-rest lock is set it is sealed under
 * the same content key as the message history — a list of space names is a
 * meaningful thing to leak on its own.
 */

import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import { randomId } from "../crypto/crypto";
import { type KeyChoice, type Sealed, openJson, sealJson } from "./atrest";

/**
 * The space of a device that was set up before spaces were plural. Its data
 * stays in the original database, so an update registers it instead of
 * migrating anything (see `registerLegacySpace`).
 */
export const LEGACY_SPACE_ID = "default";

/** Shown wherever a space has no name of its own. */
export const UNNAMED_SPACE = "Untitled";

export interface SpaceRecord {
  /** Local id: the URL segment (`/app/<id>`) and the storage namespace. */
  id: string;
  /** Null when the space was never named, or while this device is locked. */
  name: string | null;
  createdAt: number;
}

/** A row as stored: the name is sealed whenever a lock is set. */
interface StoredSpace {
  id: string;
  createdAt: number;
  name?: string | null;
  sealed?: Sealed;
}

interface RegistryDB extends DBSchema {
  spaces: { key: string; value: StoredSpace };
  /** Device-global key-value pairs (the vault envelope, the last space opened). */
  meta: { key: string; value: unknown };
}

const REGISTRY_DB_NAME = "file-sharer-registry";
const REGISTRY_DB_VERSION = 1;

/**
 * The sealed envelope holding every space's secrets while an at-rest lock is
 * set (crypto/vault.ts). Device-global: one lock covers the device.
 */
export const GLOBAL_VAULT = "vault";
/** Last space opened, so a share target or a cold start lands where it left off. */
export const GLOBAL_LAST_SPACE = "lastSpace";
/** In-flight device linking, which belongs to no space until it succeeds. */
export const GLOBAL_PENDING_PAIRING = "pendingPairing";

let registryPromise: Promise<IDBPDatabase<RegistryDB>> | null = null;

function registry(): Promise<IDBPDatabase<RegistryDB>> {
  if (!registryPromise) {
    registryPromise = openDB<RegistryDB>(REGISTRY_DB_NAME, REGISTRY_DB_VERSION, {
      upgrade(database) {
        database.createObjectStore("spaces", { keyPath: "id" });
        database.createObjectStore("meta");
      },
    });
  }
  return registryPromise;
}

// --- device-global meta ---

export async function globalMetaGet<T>(key: string): Promise<T | undefined> {
  return (await (await registry()).get("meta", key)) as T | undefined;
}

export async function globalMetaSet(key: string, value: unknown): Promise<void> {
  await (await registry()).put("meta", value, key);
}

export async function globalMetaDelete(key: string): Promise<void> {
  await (await registry()).delete("meta", key);
}

// --- the space list ---

/** Name context bound as AAD, so a sealed name cannot be moved onto another space. */
const nameContext = (id: string): string => `space-name:${id}`;

async function toStored(space: SpaceRecord): Promise<StoredSpace> {
  if (space.name === null) return { id: space.id, createdAt: space.createdAt, name: null };
  const sealed = await sealJson(space.name, nameContext(space.id));
  return sealed
    ? { id: space.id, createdAt: space.createdAt, sealed }
    : { id: space.id, createdAt: space.createdAt, name: space.name };
}

/** A sealed name this device cannot open right now reads as "unnamed". */
async function fromStored(stored: StoredSpace): Promise<SpaceRecord> {
  const name = stored.sealed
    ? ((await openJson<string>(stored.sealed, nameContext(stored.id)).catch(() => null)) ?? null)
    : (stored.name ?? null);
  return { id: stored.id, createdAt: stored.createdAt, name };
}

/** Every space on this device, oldest first. */
export async function listSpaces(): Promise<SpaceRecord[]> {
  const rows = await (await registry()).getAll("spaces");
  const spaces = await Promise.all(rows.map(fromStored));
  return spaces.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getSpace(id: string): Promise<SpaceRecord | undefined> {
  const stored = await (await registry()).get("spaces", id);
  return stored ? fromStored(stored) : undefined;
}

/** Register a new space and return its record. The id is what the URL carries. */
export async function addSpace(name: string | null): Promise<SpaceRecord> {
  const record: SpaceRecord = { id: randomId(), name: name?.trim() || null, createdAt: Date.now() };
  await (await registry()).put("spaces", await toStored(record));
  return record;
}

export async function renameSpace(id: string, name: string): Promise<SpaceRecord | undefined> {
  const current = await getSpace(id);
  if (!current) return undefined;
  const updated: SpaceRecord = { ...current, name: name.trim() || null };
  await (await registry()).put("spaces", await toStored(updated));
  return updated;
}

export async function removeSpace(id: string): Promise<void> {
  await (await registry()).delete("spaces", id);
}

/**
 * Re-encrypt every space name under `target`, reading through whatever key this
 * device currently holds. The registry half of `rewriteLocalContent`: turning a
 * lock on passes the new content key, turning it off passes null.
 */
export async function rewriteSpaceNames(target: KeyChoice): Promise<void> {
  const database = await registry();
  for (const stored of await database.getAll("spaces")) {
    const opened = await fromStored(stored);
    const sealed =
      opened.name === null ? null : await sealJson(opened.name, nameContext(opened.id), target);
    await database.put(
      "spaces",
      sealed
        ? { id: opened.id, createdAt: opened.createdAt, sealed }
        : { id: opened.id, createdAt: opened.createdAt, name: opened.name },
    );
  }
}

/**
 * Adopt the space of a device set up before spaces were plural.
 *
 * Its data is already in the original database, which is the one
 * `LEGACY_SPACE_ID` maps to, so this only has to say that it exists. Called
 * with whatever proves there *is* something there — a session, or a vault
 * envelope that used to live in the space's own meta store.
 */
export async function registerLegacySpace(): Promise<SpaceRecord> {
  const existing = await getSpace(LEGACY_SPACE_ID);
  if (existing) return existing;
  const record: SpaceRecord = { id: LEGACY_SPACE_ID, name: null, createdAt: Date.now() };
  await (await registry()).put("spaces", await toStored(record));
  return record;
}
