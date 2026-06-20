import { signal } from "@preact/signals";
import type { Auth } from "../api/client";
import { clearAll, metaGet, metaSet } from "../db/store";
import type { Session } from "../types";

export const session = signal<Session | null>(null);
export const groupKey = signal<CryptoKey | null>(null);
export const deviceKeyPair = signal<CryptoKeyPair | null>(null);

/** True once the app has finished its initial load from IndexedDB. */
export const ready = signal(false);

const SESSION_KEY = "session";
const GROUP_KEY = "groupKey";
const DEVICE_KEYPAIR_KEY = "deviceKeyPair";

export function authHeaders(): Auth {
  const current = session.value;
  if (!current) throw new Error("Not signed in");
  return { token: current.groupAuthToken, deviceId: current.deviceId };
}

/** Restore an existing session + keys from IndexedDB on startup. */
export async function loadSession(): Promise<void> {
  const [storedSession, storedGroupKey, storedKeyPair] = await Promise.all([
    metaGet<Session>(SESSION_KEY),
    metaGet<CryptoKey>(GROUP_KEY),
    metaGet<CryptoKeyPair>(DEVICE_KEYPAIR_KEY),
  ]);
  if (storedSession && storedGroupKey && storedKeyPair) {
    session.value = storedSession;
    groupKey.value = storedGroupKey;
    deviceKeyPair.value = storedKeyPair;
  }
  ready.value = true;
}

export async function persistSession(
  newSession: Session,
  newGroupKey: CryptoKey,
  newKeyPair: CryptoKeyPair,
): Promise<void> {
  await Promise.all([
    metaSet(SESSION_KEY, newSession),
    metaSet(GROUP_KEY, newGroupKey),
    metaSet(DEVICE_KEYPAIR_KEY, newKeyPair),
  ]);
  session.value = newSession;
  groupKey.value = newGroupKey;
  deviceKeyPair.value = newKeyPair;
}

/** Leave the space and wipe all local data on this device. */
export async function resetSession(): Promise<void> {
  await clearAll();
  session.value = null;
  groupKey.value = null;
  deviceKeyPair.value = null;
}
