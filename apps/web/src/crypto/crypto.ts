/**
 * End-to-end crypto core (Web Crypto API).
 *
 * Design:
 *  - GroupKey: AES-GCM 256. Encrypts every message/file. Created once by the
 *    first device and shared to others only via the ECIES pairing wrap below.
 *  - Device keypair: ECDH P-256. The private key is non-extractable.
 *  - Pairing wrap (ECIES): an ephemeral ECDH key + the recipient's public key
 *    derive a one-time AES-GCM key that encrypts a JSON package carrying the raw
 *    GroupKey, group auth token and group id.
 *
 * The server never sees plaintext, the GroupKey, or the group auth token.
 */

import type { PairingPayload } from "@file-sharer/shared";

const AES = "AES-GCM";
const EC = "ECDH";
const CURVE = "P-256";
const IV_BYTES = 12;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function bufToBase64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBuf(value: string): ArrayBuffer {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

export function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 256-bit URL-safe token (group auth token). */
export function randomToken(): string {
  return bufToBase64Url(randomBytes(32));
}

/** 128-bit URL-safe id (device id, message id, pairing id, R2 key). */
export function randomId(): string {
  return bufToBase64Url(randomBytes(16));
}

function randomIv() {
  return randomBytes(IV_BYTES);
}

/** SHA-256 of a UTF-8 string as lowercase hex (matches the server). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// GroupKey (AES-GCM 256)
// ---------------------------------------------------------------------------

export function generateGroupKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: AES, length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportGroupKey(key: CryptoKey): Promise<string> {
  return bufToBase64Url(await crypto.subtle.exportKey("raw", key));
}

export function importGroupKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64UrlToBuf(raw), { name: AES }, true, [
    "encrypt",
    "decrypt",
  ]);
}

// ---------------------------------------------------------------------------
// Device keypair (ECDH P-256)
// ---------------------------------------------------------------------------

/** Private key is non-extractable; the public key is always exportable. */
export function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: EC, namedCurve: CURVE }, false, ["deriveKey"]);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return bufToBase64Url(await crypto.subtle.exportKey("spki", key));
}

export function importPublicKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", base64UrlToBuf(spki), { name: EC, namedCurve: CURVE }, true, []);
}

// ---------------------------------------------------------------------------
// ECIES pairing wrap / unwrap
// ---------------------------------------------------------------------------

function deriveSharedKey(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: EC, public: peerPublicKey },
    privateKey,
    { name: AES, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface WrappedPairing {
  /** base64url of JSON `{ iv, ct }`. */
  wrappedPackage: string;
  /** Ephemeral ECDH P-256 public key (base64url SPKI). */
  ephemeralPublicKey: string;
}

/** Encrypt the pairing payload for a recipient's public key. */
export async function wrapPairingPackage(
  recipientPublicKey: CryptoKey,
  payload: PairingPayload,
): Promise<WrappedPairing> {
  const ephemeral = await crypto.subtle.generateKey({ name: EC, namedCurve: CURVE }, false, [
    "deriveKey",
  ]);
  const sharedKey = await deriveSharedKey(ephemeral.privateKey, recipientPublicKey);
  const iv = randomIv();
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES, iv },
    sharedKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const wrapped = JSON.stringify({ iv: bufToBase64Url(iv), ct: bufToBase64Url(ciphertext) });
  return {
    wrappedPackage: bufToBase64Url(new TextEncoder().encode(wrapped)),
    ephemeralPublicKey: await exportPublicKey(ephemeral.publicKey),
  };
}

/** Decrypt the pairing payload using this device's private key. */
export async function unwrapPairingPackage(
  myPrivateKey: CryptoKey,
  ephemeralPublicKey: string,
  wrappedPackage: string,
): Promise<PairingPayload> {
  const ephemeralPublic = await importPublicKey(ephemeralPublicKey);
  const sharedKey = await deriveSharedKey(myPrivateKey, ephemeralPublic);
  const wrappedJson = new TextDecoder().decode(base64UrlToBuf(wrappedPackage));
  const { iv, ct } = JSON.parse(wrappedJson) as { iv: string; ct: string };
  const plaintext = await crypto.subtle.decrypt(
    { name: AES, iv: base64UrlToBuf(iv) },
    sharedKey,
    base64UrlToBuf(ct),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as PairingPayload;
}

// ---------------------------------------------------------------------------
// Text / binary payloads (AES-GCM with the GroupKey)
// ---------------------------------------------------------------------------

export interface EncryptedText {
  ciphertext: string;
  iv: string;
}

export async function encryptText(groupKey: CryptoKey, text: string): Promise<EncryptedText> {
  const iv = randomIv();
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES, iv },
    groupKey,
    new TextEncoder().encode(text),
  );
  return { ciphertext: bufToBase64Url(ciphertext), iv: bufToBase64Url(iv) };
}

export async function decryptText(
  groupKey: CryptoKey,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: AES, iv: base64UrlToBuf(iv) },
    groupKey,
    base64UrlToBuf(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

/** Encrypt a JSON-serialisable value (e.g. file metadata). */
export async function encryptJson(groupKey: CryptoKey, value: unknown): Promise<EncryptedText> {
  return encryptText(groupKey, JSON.stringify(value));
}

export async function decryptJson<T>(
  groupKey: CryptoKey,
  ciphertext: string,
  iv: string,
): Promise<T> {
  return JSON.parse(await decryptText(groupKey, ciphertext, iv)) as T;
}

export interface EncryptedFile {
  ciphertext: ArrayBuffer;
  iv: string;
}

/** One-shot AES-GCM over a whole file buffer (fine for files up to ~50 MB). */
export async function encryptFile(groupKey: CryptoKey, data: ArrayBuffer): Promise<EncryptedFile> {
  const iv = randomIv();
  const ciphertext = await crypto.subtle.encrypt({ name: AES, iv }, groupKey, data);
  return { ciphertext, iv: bufToBase64Url(iv) };
}

export async function decryptFile(
  groupKey: CryptoKey,
  data: ArrayBuffer,
  iv: string,
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: AES, iv: base64UrlToBuf(iv) }, groupKey, data);
}
