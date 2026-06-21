/**
 * End-to-end verification against a running `wrangler dev` (http://localhost:8787).
 *
 * Simulates two devices doing the real flow with the REAL crypto core:
 *  create group -> pair device B -> send text + file -> B fetches/decrypts/acks
 *  -> server deletes file & metadata -> revoke B.
 *
 * Run with: node scripts/e2e-verify.mts
 */

import {
  decryptFile,
  decryptJson,
  decryptText,
  encryptFile,
  encryptJson,
  encryptName,
  encryptText,
  exportGroupKey,
  exportPublicKey,
  generateDeviceKeyPair,
  generateGroupKey,
  importGroupKey,
  importPublicKey,
  randomId,
  randomToken,
  sha256Hex,
  unwrapPairingPackage,
  wrapPairingPackage,
} from "../apps/web/src/crypto/crypto.ts";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";

let failures = 0;
function check(name: string, condition: boolean): void {
  const ok = condition;
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${name}`);
}

interface Auth {
  token: string;
  deviceId: string;
}
function headers(auth?: Auth, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (auth) {
    h.Authorization = `Bearer ${auth.token}`;
    h["X-Device-Id"] = auth.deviceId;
  }
  return h;
}
async function postJson(path: string, body: unknown, auth?: Auth): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: headers(auth, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

// --- Device A: create the space -------------------------------------------
const aKeys = await generateDeviceKeyPair();
const groupKey = await generateGroupKey();
const token = randomToken();
const groupId = randomId();
const aId = randomId();
const aAuth: Auth = { token, deviceId: aId };

const aName = await encryptName(groupKey, "Device A", aId);
const createRes = await postJson("/api/groups", {
  groupId,
  authTokenHash: await sha256Hex(token),
  device: { id: aId, publicKey: await exportPublicKey(aKeys.publicKey) },
  encryptedName: aName.ciphertext,
  nameIv: aName.iv,
});
check("create group returns 200", createRes.ok);

// --- Device B: request pairing slot ---------------------------------------
const bKeys = await generateDeviceKeyPair();
const bId = randomId();
const pairingId = randomId();
const bPublic = await exportPublicKey(bKeys.publicKey);
const reqRes = await postJson(`/api/pairing/${pairingId}/request`, {
  device: { id: bId, publicKey: bPublic },
});
check("pairing request returns 200", reqRes.ok);

// --- Device A: wrap GroupKey for B and complete ---------------------------
const recipientPub = await importPublicKey(bPublic);
const wrapped = await wrapPairingPackage(
  recipientPub,
  {
    groupKey: await exportGroupKey(groupKey),
    groupAuthToken: token,
    groupId,
  },
  pairingId,
);
const bName = await encryptName(groupKey, "Device B", bId);
const completeRes = await postJson(
  `/api/pairing/${pairingId}/complete`,
  {
    wrappedPackage: wrapped.wrappedPackage,
    ephemeralPublicKey: wrapped.ephemeralPublicKey,
    encryptedName: bName.ciphertext,
    nameIv: bName.iv,
  },
  aAuth,
);
check("pairing complete returns 200", completeRes.ok);

// --- Device B: poll, unwrap, recover the GroupKey -------------------------
const pollRes = await fetch(`${BASE}/api/pairing/${pairingId}`);
const poll = (await pollRes.json()) as {
  ready: boolean;
  wrappedPackage?: string;
  ephemeralPublicKey?: string;
};
check("pairing poll is ready", poll.ready === true);
const recovered = await unwrapPairingPackage(
  bKeys.privateKey,
  poll.ephemeralPublicKey!,
  poll.wrappedPackage!,
  pairingId,
);
check("B recovered the correct groupId", recovered.groupId === groupId);
check("B recovered the correct auth token", recovered.groupAuthToken === token);
const bGroupKey = await importGroupKey(recovered.groupKey);
const bAuth: Auth = { token: recovered.groupAuthToken, deviceId: bId };

// --- Device A: send a text message ----------------------------------------
const plaintext = "Hello from A 🌍 — secret!";
const textId = randomId();
const encText = await encryptText(groupKey, plaintext, `text:${textId}`);
const sendTextRes = await postJson(
  "/api/messages",
  { id: textId, encryptedPayload: encText.ciphertext, iv: encText.iv },
  aAuth,
);
check("send text returns 200", sendTextRes.ok);
check("server payload is ciphertext (not plaintext)", encText.ciphertext !== plaintext);

// --- Device A: send a file message ----------------------------------------
const original = new Uint8Array(1024 * 1024); // 1 MB
for (let off = 0; off < original.length; off += 65536) {
  crypto.getRandomValues(original.subarray(off, Math.min(off + 65536, original.length)));
}
const r2Key = randomId();
const fileId = randomId();
const encFile = await encryptFile(groupKey, original.buffer, `file:${fileId}`);
const upRes = await fetch(`${BASE}/api/files/${r2Key}`, {
  method: "PUT",
  headers: headers(aAuth),
  body: encFile.ciphertext,
});
check("file upload returns 200", upRes.ok);
const metaEnc = await encryptJson(
  groupKey,
  {
    name: "secret.bin",
    size: original.byteLength,
    mime: "application/octet-stream",
  },
  `meta:${fileId}`,
);
const sendFileRes = await postJson(
  "/api/messages",
  {
    id: fileId,
    fileR2Key: r2Key,
    fileIv: encFile.iv,
    fileMeta: metaEnc.ciphertext,
    fileMetaIv: metaEnc.iv,
  },
  aAuth,
);
check("send file message returns 200", sendFileRes.ok);

// --- Device B: fetch pending, decrypt, verify -----------------------------
const pendingRes = await fetch(`${BASE}/api/messages/pending`, { headers: headers(bAuth) });
const pending = (await pendingRes.json()) as { messages: any[] };
check("B has 2 pending messages", pending.messages.length === 2);

const textMsg = pending.messages.find((m) => m.id === textId);
const fileMsg = pending.messages.find((m) => m.id === fileId);
check("text message present for B", !!textMsg);
check(
  "B decrypts text to original plaintext",
  textMsg &&
    (await decryptText(bGroupKey, textMsg.encryptedPayload, textMsg.iv, `text:${textId}`)) ===
      plaintext,
);

const meta = await decryptJson<{ name: string; size: number }>(
  bGroupKey,
  fileMsg.fileMeta,
  fileMsg.fileMetaIv,
  `meta:${fileId}`,
);
check("B decrypts file metadata", meta.name === "secret.bin" && meta.size === original.byteLength);

const fileDl = await fetch(`${BASE}/api/files/${fileMsg.fileR2Key}`, { headers: headers(bAuth) });
check("B downloads encrypted file", fileDl.ok);
const decrypted = new Uint8Array(
  await decryptFile(bGroupKey, await fileDl.arrayBuffer(), fileMsg.fileIv, `file:${fileId}`),
);
check(
  "B decrypts file to byte-identical original",
  decrypted.length === original.length && decrypted.every((b, i) => b === original[i]),
);

// --- Device B: ack both (B is the only recipient) -------------------------
const ackText = await (await postJson(`/api/messages/${textId}/ack`, {}, bAuth)).json();
const ackFile = (await (await postJson(`/api/messages/${fileId}/ack`, {}, bAuth)).json()) as {
  deleted: boolean;
};
check("acking last recipient reports deletion", ackFile.deleted === true);

// --- Server-side deletion checks ------------------------------------------
const afterAckPending = (await (
  await fetch(`${BASE}/api/messages/pending`, { headers: headers(bAuth) })
).json()) as { messages: any[] };
check("no pending messages remain after ack", afterAckPending.messages.length === 0);

const fileGone = await fetch(`${BASE}/api/files/${r2Key}`, { headers: headers(bAuth) });
check("R2 file deleted immediately after full ack", fileGone.status === 404);

// --- Auth checks -----------------------------------------------------------
const noAuth = await fetch(`${BASE}/api/devices`);
check("unauthenticated request is rejected", noAuth.status === 401);

const badToken = await fetch(`${BASE}/api/devices`, {
  headers: headers({ token: "wrong-token", deviceId: aId }),
});
check("invalid token is rejected", badToken.status === 401);

// --- Device management / revoke -------------------------------------------
const devicesBefore = (await (
  await fetch(`${BASE}/api/devices`, { headers: headers(aAuth) })
).json()) as { devices: any[] };
check("group lists 2 active devices", devicesBefore.devices.length === 2);

await fetch(`${BASE}/api/devices/${bId}`, { method: "DELETE", headers: headers(aAuth) });
const devicesAfter = (await (
  await fetch(`${BASE}/api/devices`, { headers: headers(aAuth) })
).json()) as { devices: any[] };
check("after revoke, only 1 active device", devicesAfter.devices.length === 1);

const revokedAccess = await fetch(`${BASE}/api/messages/pending`, { headers: headers(bAuth) });
check("revoked device is forbidden", revokedAccess.status === 403);

// avoid unused-var lint for ackText
void ackText;

console.log("");
if (failures === 0) {
  console.log("🎉 ALL CHECKS PASSED");
} else {
  console.log(`💥 ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
