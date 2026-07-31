/**
 * The at-rest lock: turning it on, unlocking, locking, turning it off.
 *
 * The rule this module exists to keep is simple: **while the device is locked,
 * nothing that could decrypt anything is in storage.** The session and the
 * keyring live inside a sealed envelope (`META_VAULT`), local messages and
 * files are ciphertext (db/atrest.ts), and the only way back is a secret the
 * user supplies. There is no stored verifier to test guesses against — a wrong
 * passphrase surfaces as an AES-GCM authentication failure and nothing else.
 *
 * Locking is not on a timer. The device locks when the app starts and whenever
 * the user asks; keeping an unlocked session alive while the app is open is
 * what makes the lock livable rather than something people turn off after a
 * day.
 */

import { signal } from "@preact/signals";
import {
  base64UrlToBuf,
  bufToBase64Url,
  exportGroupKey,
  importDeviceKeyPair,
  importGroupKey,
  importSigningKeyPair,
  serializeKeyPair,
} from "../crypto/crypto";
import { type Keyring, saveKeyring } from "../crypto/keyring";
import { PasskeyUnsupportedError, createPasskey, evaluatePrf } from "../crypto/passkey";
import {
  type LockMethod,
  PBKDF2_ITERATIONS,
  type VaultEnvelope,
  type VaultSecrets,
  keysFromPassphrase,
  keysFromSecret,
  newSalt,
  openVault,
  sealVault,
} from "../crypto/vault";
import { currentContentKey, setContentKey } from "../db/atrest";
import {
  META_DEVICE_KEYPAIR,
  META_KEYRING,
  META_SESSION,
  META_SIGNING_KEYPAIR,
  META_VAULT,
  metaDelete,
  metaGet,
  metaSet,
  rewriteLocalContent,
} from "../db/store";
import {
  deviceKeyPair,
  keyring,
  session,
  setSecretsChangedHandler,
  signingKeyPair,
} from "./session";

/** A lock is configured on this device (there is an envelope in storage). */
export const lockConfigured = signal(false);
/** How this device unlocks. Null when no lock is set. */
export const lockMethod = signal<LockMethod | null>(null);
/** The secrets are sealed and not in memory: nothing works until unlocked. */
export const locked = signal(false);

/** The envelope in storage, kept so unlocking knows its derivation parameters. */
let envelope: VaultEnvelope | null = null;
/**
 * The vault key for the current unlocked session. Held so the envelope can be
 * re-sealed after a key rotation without prompting the user again — the secret
 * has not changed, only what it protects.
 */
let vaultKey: CryptoKey | null = null;

export class WrongSecretError extends Error {
  constructor() {
    super("That didn't unlock this device. Try again.");
    this.name = "WrongSecretError";
  }
}

/**
 * Read the lock configuration. Runs before `loadSession`, because a locked
 * device deliberately has no session in storage to load.
 */
export async function loadLockState(): Promise<void> {
  envelope = (await metaGet<VaultEnvelope>(META_VAULT)) ?? null;
  lockConfigured.value = envelope !== null;
  lockMethod.value = envelope?.method ?? null;
  locked.value = envelope !== null;
}

// ---------------------------------------------------------------------------
// Unlocking
// ---------------------------------------------------------------------------

/** Put the opened secrets back into memory and make local content readable. */
async function hydrate(
  secrets: VaultSecrets,
  keys: { vaultKey: CryptoKey; contentKey: CryptoKey },
): Promise<void> {
  const ring: Keyring = { current: secrets.keyring.current, keys: new Map() };
  for (const [epoch, raw] of secrets.keyring.keys) {
    ring.keys.set(epoch, await importGroupKey(raw));
  }

  setContentKey(keys.contentKey);
  vaultKey = keys.vaultKey;
  session.value = secrets.session;
  keyring.value = ring;
  // A device from before the keys were exportable keeps them where the browser
  // put them: they could not be sealed, so they are still in `meta`.
  deviceKeyPair.value = secrets.deviceKeyPair
    ? await importDeviceKeyPair(secrets.deviceKeyPair)
    : ((await metaGet<CryptoKeyPair>(META_DEVICE_KEYPAIR)) ?? null);
  signingKeyPair.value = secrets.signingKeyPair
    ? await importSigningKeyPair(secrets.signingKeyPair)
    : ((await metaGet<CryptoKeyPair>(META_SIGNING_KEYPAIR)) ?? null);
  locked.value = false;
}

/** Open the envelope, turning any failure into "that wasn't the secret". */
async function openOrReject(key: CryptoKey, current: VaultEnvelope): Promise<VaultSecrets> {
  try {
    return await openVault(key, current);
  } catch {
    throw new WrongSecretError();
  }
}

export async function unlockWithPassphrase(passphrase: string): Promise<void> {
  if (!envelope) throw new Error("This device has no lock");
  const keys = await keysFromPassphrase(passphrase, envelope.salt, envelope.iterations);
  await hydrate(await openOrReject(keys.vaultKey, envelope), keys);
}

export async function unlockWithPasskey(): Promise<void> {
  if (!envelope?.credentialId) throw new Error("This device has no passkey lock");
  const secret = await evaluatePrf(envelope.credentialId, base64UrlToBuf(envelope.salt));
  if (!secret) throw new PasskeyUnsupportedError();
  const keys = await keysFromSecret(secret, envelope.salt);
  await hydrate(await openOrReject(keys.vaultKey, envelope), keys);
}

/**
 * Drop everything from memory. Storage is already sealed, so this is only about
 * the copies this tab holds — nothing to rewrite, nothing to undo.
 */
export function lockNow(): void {
  if (!lockConfigured.value) return;
  setContentKey(null);
  vaultKey = null;
  session.value = null;
  keyring.value = null;
  deviceKeyPair.value = null;
  signingKeyPair.value = null;
  locked.value = true;
}

// ---------------------------------------------------------------------------
// Turning the lock on and off
// ---------------------------------------------------------------------------

/** Everything the vault (and a recovery file) has to carry. */
export async function currentSecrets(contentKey: CryptoKey): Promise<VaultSecrets> {
  const currentSession = session.value;
  const ring = keyring.value;
  if (!currentSession || !ring) throw new Error("Not signed in");

  const keys: [number, string][] = [];
  for (const [epoch, key] of ring.keys) keys.push([epoch, await exportGroupKey(key)]);

  return {
    session: currentSession,
    keyring: { current: ring.current, keys },
    deviceKeyPair: deviceKeyPair.value ? await serializeKeyPair(deviceKeyPair.value) : null,
    signingKeyPair: signingKeyPair.value ? await serializeKeyPair(signingKeyPair.value) : null,
    contentKey: bufToBase64Url(await crypto.subtle.exportKey("raw", contentKey)),
  };
}

export interface EnableLockOptions {
  method: LockMethod;
  /** Required for `method: "passphrase"`. */
  passphrase?: string;
  /** Shown in the platform's own passkey prompt for `method: "passkey"`. */
  deviceName?: string;
}

/**
 * Turn the lock on.
 *
 * The order is load-bearing: content is re-encrypted *before* the envelope is
 * written and the plaintext keys are deleted. An interruption halfway therefore
 * leaves a device that still opens normally — some rows sealed under a key that
 * is still reachable in the clear — rather than one whose history is ciphertext
 * with no way in.
 */
export async function enableLock(options: EnableLockOptions): Promise<void> {
  const salt = newSalt();
  let credentialId: string | undefined;
  let keys: { vaultKey: CryptoKey; contentKey: CryptoKey };

  if (options.method === "passkey") {
    const passkey = await createPasskey(options.deviceName ?? "file-sharer", base64UrlToBuf(salt));
    credentialId = passkey.credentialId;
    keys = await keysFromSecret(passkey.secret, salt);
  } else {
    if (!options.passphrase) throw new Error("A passphrase is required");
    keys = await keysFromPassphrase(options.passphrase, salt, PBKDF2_ITERATIONS);
  }

  const secrets = await currentSecrets(keys.contentKey);
  await rewriteLocalContent(keys.contentKey);
  setContentKey(keys.contentKey);
  vaultKey = keys.vaultKey;

  const sealed = await sealVault(keys.vaultKey, secrets, {
    v: 1,
    method: options.method,
    salt,
    iterations: PBKDF2_ITERATIONS,
    ...(credentialId ? { credentialId } : {}),
  });
  await metaSet(META_VAULT, sealed);

  // Only now do the plaintext copies go. The keypairs are dropped only if they
  // could be sealed: a device from before they were exportable would otherwise
  // be deleting the one copy of its own identity.
  await Promise.all([
    metaDelete(META_SESSION),
    metaDelete(META_KEYRING),
    ...(secrets.deviceKeyPair ? [metaDelete(META_DEVICE_KEYPAIR)] : []),
    ...(secrets.signingKeyPair ? [metaDelete(META_SIGNING_KEYPAIR)] : []),
  ]);

  envelope = sealed;
  lockConfigured.value = true;
  lockMethod.value = options.method;
  locked.value = false;
}

/**
 * Turn the lock off, putting the secrets and the local content back in the
 * clear. Only possible while unlocked, which is the point: the secret is the
 * only thing that may authorise removing the protection it provides.
 */
export async function disableLock(): Promise<void> {
  const currentSession = session.value;
  const ring = keyring.value;
  if (locked.value || !currentSession || !ring) throw new Error("Unlock this device first");

  await rewriteLocalContent(null);
  setContentKey(null);
  vaultKey = null;

  await Promise.all([
    metaSet(META_SESSION, currentSession),
    saveKeyring(ring),
    ...(deviceKeyPair.value ? [metaSet(META_DEVICE_KEYPAIR, deviceKeyPair.value)] : []),
    ...(signingKeyPair.value ? [metaSet(META_SIGNING_KEYPAIR, signingKeyPair.value)] : []),
  ]);
  await metaDelete(META_VAULT);

  envelope = null;
  lockConfigured.value = false;
  lockMethod.value = null;
  locked.value = false;
}

/**
 * Re-seal the envelope after the session's secrets changed underneath it.
 *
 * A key rotation adds an epoch to the keyring, and the keyring lives in the
 * vault while a lock is on — so without this the next unlock would silently
 * roll the device back to yesterday's keys and stop it reading anything sent
 * since. A no-op without a lock, so callers never have to check.
 */
export async function refreshVault(): Promise<void> {
  if (!envelope || !vaultKey || locked.value) return;
  const contentKey = currentContentKey();
  if (!contentKey) return;

  envelope = await sealVault(vaultKey, await currentSecrets(contentKey), {
    v: envelope.v,
    method: envelope.method,
    salt: envelope.salt,
    iterations: envelope.iterations,
    ...(envelope.credentialId ? { credentialId: envelope.credentialId } : {}),
  });
  await metaSet(META_VAULT, envelope);
  // Self-healing: `persistSession` writes the plaintext copies unconditionally
  // (it is the path a brand-new or restored session takes, where no lock can
  // exist yet). Clearing them here keeps the invariant true no matter which
  // order things happened in.
  await Promise.all([metaDelete(META_SESSION), metaDelete(META_KEYRING)]);
}

/** Forget the lock entirely (used by logout, which wipes the whole database). */
export function forgetLock(): void {
  envelope = null;
  vaultKey = null;
  setContentKey(null);
  lockConfigured.value = false;
  lockMethod.value = null;
  locked.value = false;
}

// Registered here rather than imported by `state/session.ts`, which would make
// the dependency circular: the lock is built on the session, not the reverse.
setSecretsChangedHandler(() => void refreshVault());
