# TODO — file-sharer

> Remaining work to take the project "to the next level". Each item carries a
> severity/impact and, where relevant, the specific file and a suggested fix.
> Items completed in the hardening pass live in git history (commits `617a90e`..`52d0bd5`).
>
> Legend: 🔴 critical · 🟠 important · 🟡 improvement · 🔵 nice-to-have
> Effort: ⚡ quick · 🛠️ medium · 🏗️ large

---

## 0. Priorities / next up

Biggest remaining items (need design decisions, don't do blindly):

- **`GroupKey` rotation → real revocation (forward secrecy).** 🔴🏗️ Rotate **only the
  `GroupKey`**, leaving the group token in place — so no device is 401'd and none has to
  re-pair. The revoking device wraps the new key per remaining device (ECIES, using their
  published ECDH pubkey) and deposits the blobs server-side; each device adopts it on its next
  sync. Offline devices self-heal on reconnect — keep each wrapped blob until acked. Design the
  re-keying protocol first.
- **Sender signing** (authenticity). 🟠🏗️ Needs a second signing keypair per device and a
  signed message format.
- **Real-time delivery (WebSocket/Durable Objects)** replacing the 8 s poll. 🟠🏗️
- **At-rest lock (PIN/WebAuthn)** + **encrypted recovery export** + **Web Push**. 🟠🏗️ See §7.

---

## 1. Security

- [x] ~~🔴⚡ **Cross-group revocation bypass in `completePairing`.**~~ The `INSERT … ON CONFLICT(id) DO UPDATE SET revoked_at = NULL` matched on the global device PK without checking the group, so an ex-member (who still holds the group token, which is never rotated) could **un-revoke their own device in another group** by reserving a pairing slot with that device id from a throwaway group. Fixed in `apps/worker/src/routes/pairing.ts`: reject a device id already registered to a different group, plus a `WHERE devices.group_id = excluded.group_id` guard on the upsert (defense-in-depth against TOCTOU).
- [ ] 🔴🏗️ **Revocation does NOT rotate the `GroupKey`.** `apps/worker/src/routes/devices.ts` only sets `revoked_at`. A revoked device keeps the `GroupKey` locally forever and can decrypt any ciphertext it already saw/exfiltrated — and any *future* ciphertext it captures off the wire. Real revocation = rotate the `GroupKey`: the revoking device generates a new key, wraps it for each remaining device via ECIES (their published ECDH pubkey) and deposits the blobs on the server; each device adopts the new key on its next sync. **No need to rotate the token or re-pair** — keeping the shared token means no device gets 401'd, and offline devices self-heal on reconnect (keep each wrapped blob until acked). Biggest current limitation.
- [ ] 🟠🛠️ **Single shared group token + self-asserted `X-Device-Id` (not per-device).** All devices share one bearer, so a leak from any device = full group access. The device id is just an HTTP header: with the shared token, a device can impersonate any *other* deviceId it has seen in `senderDeviceId`/ack payloads (read its pending messages, ack on its behalf, send as it). The ECDH public key of the device is published at pairing but **never used to authenticate requests**. Two complementary fixes: (a) per-device token (server maps token→device→group) — also makes revocation cut off the right device, (b) require the device's ECDH private key to sign each request (or at least the auth header). Real fix likely needs (a)+(b) together; the GroupKey rotation above reduces the blast radius of (a) staying unsolved.
- [ ] 🟠🏗️ **No sender authenticity.** `senderDeviceId`/`senderName` are provided by the server, not the sender. A malicious server can forge who sent what. Add a **signing** keypair per device (ECDSA/Ed25519) and sign messages; the receiver verifies with the public key published at pairing time.
- [ ] 🟡🛠️ **No replay/reorder protection.** The server could resend, duplicate or reorder messages. Consider per-device signed sequence numbers. At minimum, document it in the threat model.
- [x] ~~🟡⚡ **Pairing slot not deleted on completion.**~~ `pollPairing` left the (encrypted) package reachable by `pairingId` until cron reaped it (≤10 min). Fixed: the joining device now calls a new `DELETE /api/pairing/:pairingId` endpoint right after it successfully unwraps the package and persists its session; cron remains the safety net if that call never arrives.
- [x] ~~🟡⚡ **`completePairing` registers the slot's public key (step 1, anonymous), not the scanned one.**~~ The wrap targeted the scanned QR key, but D1 stored `slot.newDevice.publicKey`, with nothing checking they matched. Fixed: the existing device now also sends `scannedPublicKey` in `PairingCompleteBody`, and the server rejects the request if it doesn't match the slot's.
- [x] ~~🟡🛠️ **JSON bodies are parsed before size validation.**~~ `readJson` read the whole body even though `encryptedPayload` is capped at 1 MB *afterwards*. Fixed: added an early `Content-Length` check (`MAX_JSON_BODY_SIZE`, 2 MB) in `apps/worker/src/http.ts` that rejects oversized bodies with 413 before parsing.
- [ ] 🟠🛠️ **Poisoned-file infinite re-download loop.** `apps/web/src/sync/sync.ts:145-157` — a permanent decrypt failure (tampered ciphertext, AAD mismatch) pins the file in `fileState: "error"` and the next 8 s tick downloads the whole blob again and again, up to 50 MB per tick, until the server's 24 h TTL. Same pattern for text: `processIncoming` re-decrypts on every poll, so a poison text message burns CPU forever. And on the *send* side, if `encryptFile`/`encryptJson` throw (corrupt local blob, OOM), `doFlush` treats them as `NetworkError` and re-queues forever — same poison pattern, different trigger, much rarer. Distinguish **transient** (network) from **permanent** (decrypt / crypto) failures: on permanent failure either mark `failed` and ack (drop on this device) or move to a dead-letter state with a bounded retry counter. Mitigates bandwidth/CPU drain and is the prerequisite for surviving hostile servers.
- [ ] 🟡⚡ **Falsified `Content-Length` on file uploads.** `apps/worker/src/routes/files.ts:40` enforces the 50 MB cap *after* the full body is in R2, so a hostile client with a valid token can make the server (a) consume the full request body on every PUT, (b) bill the full R2 write, capped only by `RL_UPLOAD` (20/min). Capped but real. The same hardening could be done in `http.ts` like the JSON-body check: reject early on a missing/oversized `Content-Length` header before reading the stream.
- [ ] 🔵⚡ **`sendMessage` returns 500 (constraint violation) instead of 409 (conflict) for duplicate ids.** `apps/worker/src/routes/messages.ts:57-59` does a check-then-insert on `messages.id`; two concurrent sends with the same id (one would only ever happen on retry, but still) trip a unique-constraint 500 instead of the `conflict` the outbox already knows how to swallow. Wrap the batch and map the constraint error to `conflict`.
- [ ] 🔵🔵 **`createGroup` accepts any string as `authTokenHash`.** No length/charset check; anything that isn't 64 lowercase hex chars just sits in the table. Add a regex check in `http.ts` (`requireString` already takes a max length) and return `bad_request` for non-conforming input. Cosmetic but keeps the table clean.
- [ ] 🔵🛠️ **Shared files sit in Cache Storage in clear** until `consumeSharedContent` drains them. Small exposure window; encrypt or clean up more aggressively.

## 2. Privacy

- [ ] 🔴🏗️ Key rotation on revocation (see §1) — without it there is no real "forget".
- [ ] 🟠🏗️ **No client at-rest encryption.** IndexedDB stores messages, decrypted files, the `GroupKey` (as a `CryptoKey`) and the `groupAuthToken` in clear. Anyone with device access (or an XSS) gets everything. Add an optional PIN/passphrase lock (derive a wrapping key with PBKDF2/Argon2) or WebAuthn/passkey to wrap the `GroupKey` at rest.
- [ ] 🟡🏗️ **Server-observable metadata:** sizes (via `Content-Length` and metadata length), timing, device count. For sizes, consider padding the ciphertext to buckets. Explicitly document what the server sees.

## 3. Performance

- [ ] 🟠🏗️ **Polling every 8 s** (`POLL_INTERVAL_MS`) drains battery and adds latency. Migrate to WebSocket/SSE with Durable Objects for real-time push delivery.
- [ ] 🟡⚡ **Dead `since` cursor — needs a design decision, not a blind wire-up.** `apps/web/src/sync/sync.ts` always calls `api.pendingMessages(auth)` with `since=0`. On inspection this isn't just an unused optimization: the worker query (`apps/worker/src/routes/messages.ts`) already scopes results via `ds.device_id = ? AND ds.downloaded_at IS NULL` (backed by `idx_delivery_device_pending`), so every row returned is, by definition, still pending for this device — `since` currently adds nothing. Naively wiring it to "last acked `createdAt`" would filter on `m.created_at`, which is a wall-clock timestamp assigned by whichever edge Worker handled `sendMessage`; under clock skew/out-of-order arrival across colos, a message from another device could land with a `created_at` at or before the cursor and get **silently filtered out and never delivered**. If this is worth doing, it needs a monotonic cursor (e.g. an auto-increment `rowid`/sequence) instead of `created_at`, which is a real design decision — left for §0.
- [ ] 🟡🛠️ **One-shot in-memory file crypto.** `encryptFile`/`decryptFile` load the whole file + ciphertext + decrypted copy (up to ~3×50 MB) into RAM. Move to chunked/streaming crypto for low-end phones and to be able to raise the size limit.
- [ ] 🟡🛠️ **Heavy initial bundle.** `jsqr`, `qrcode` and the scanner are only needed when pairing; the 3 variable font families (`bricolage`, `hanken`, `jetbrains-mono`) are loaded eagerly in `main.tsx`. Code-split the pairing flow (lazy import) and subset/selectively preload fonts.
- [x] ~~🟡⚡ **`upsertMessage` re-sorts the whole array** on every insert (`state/messages.ts`).~~ Fixed: `applyMessageUpdate` now updates in place for an existing id (its `createdAt` never changes) or inserts a new message directly at its sorted position via binary search, instead of a full `sort()`.
- [ ] 🔵🛠️ **Chat list not virtualized** (`Chat.tsx`): full re-render. Virtualize for long histories.
- [ ] 🔵🟡 **Base64 ciphertext in D1** (up to 1 MB per `encryptedPayload`) bloats the database. Acceptable, keep an eye on it.
- [ ] 🟠🛠️ **IndexedDB grows without bound.** `apps/web/src/db/store.ts` only prunes on `logout()` / `clearAll()`. Sent + received messages, the `files` blob store, and the device names all accumulate forever; `allMessages()` is loaded into memory on every `loadMessages` and on every outbox flush (`sync/outbox.ts:90`) to filter the queue. After months of use this hurts both memory and every 8 s sync pass. Add a local retention policy (e.g. keep last N months, cap blob count, configurable) and a status index so the outbox doesn't need a full scan.
- [ ] 🔵⚡ **`authenticate` does 2 D1 queries per request.** `apps/worker/src/auth.ts:24-53` looks up `groups` and then `devices` separately. At current scale (8 s poll × N devices) it's fine, but a single `SELECT … FROM devices d JOIN groups g ON g.id = d.group_id WHERE d.id = ? AND d.revoked_at IS NULL AND g.auth_token_hash = ?` does it in one round-trip and matches the same index. Trivial change, can be folded into the per-device-token work in §1.

## 4. Best practices / tooling

- [ ] 🟠🛠️ **The Worker has no unit tests.** Only the e2e script (needs a running server). Add `@cloudflare/vitest-pool-workers` to test auth, the router, validation (`http.ts`), errors and the cron in isolation.
- [ ] 🟡🛠️ **No component tests** in the PWA (crypto only). Add `@testing-library/preact` for key flows (composer, pairing, message rendering).
- [ ] 🟡⚡ **Confirm the committed `database_id`** in `wrangler.jsonc` (`05e8acfd-…`). The comment says "replace"; if it is the real prod id, fine (not secret), but document it to avoid confusion.
- [ ] 🔵⚡ **`exactOptionalPropertyTypes: false`** in `tsconfig.base.json`. Enabling it hardens optional handling (may need minor adjustments).
- [ ] 🔵⚡ `sha256Hex` duplicated (worker `auth.ts` / web `crypto.ts`): unavoidable due to different runtimes, noted for the record.

## 5. Refactoring

- [ ] 🟡🛠️ **`processIncoming` mixes responsibilities** (create local, download, ack). Split into smaller functions.
- [ ] 🟡🛠️ **`actions.ts` is a grab-bag** (onboarding + pairing + messaging + files + session). Split by domain.
- [ ] 🔵⚡ **"Active group devices" query repeated** in `auth.ts`, `db.ts`, `devices.ts`. Centralize.
- [ ] 🔵⚡ **`sendFileMessages` is sequential.** Acceptable to avoid overload, but could parallelize with a concurrency limit.

## 6. UI / UX / Accessibility

- [ ] 🟡⚡ **No retry for failed text.** A `failed` outgoing message shows an alert icon but isn't tappable (files do have retry). Add tap-to-retry.
- [ ] 🟡🛠️ **No image/video previews.** Everything renders as a generic file card. Render inline thumbnails/previews from the decrypted blob (`URL.createObjectURL`).
- [ ] 🟡⚡ **No drag-and-drop** or **paste-image** to attach (button only). Add a drop zone and a paste handler to the composer.
- [ ] 🟡🛠️ **No real upload/download progress** for large files (spinner only). Show %.
- [ ] 🟡🛠️ **No delete/clear history** or single-message delete (local or for everyone). Add message management.
- [ ] 🟡🛠️ **No date separators** in the chat (time only). Group by day.
- [ ] 🔵⚡ **`Modal` has no full focus trap** (Escape + focus restore are done). Trap Tab within the dialog.
- [x] ~~🔵⚡ **`prefers-reduced-motion`** not honored in animations (`animate-toast-in`, `animate-modal-in`).~~ Turns out already handled: `styles.css` has a blanket `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; } }` covering every `animate-*` class. Stale entry, found while doing this pass — no code change needed.
- [x] ~~🔵⚡ **Error toasts** use `role="status"`; errors should use `role="alert"`.~~ Fixed: the role moved from the shared toast container to each toast individually (`role="alert"` for errors, `role="status"` otherwise).
- [ ] 🔵⚡ **Rename a device** after creation: doesn't exist.
- [ ] 🔵⚡ **Delivery/read indicators.** The server already has `delivery_status`; could show "delivered to N devices".
- [ ] 🔵🛠️ **No search** in messages.
- [ ] 🔵⚡ **QR scanner** has no torch/camera switch.
- [ ] 🔵⚡ **No manual theme toggle** (system `dark:` only). Optional.

## 7. Features (roadmap "next level")

- [ ] 🔴🏗️ `GroupKey` rotation → real revocation (rotate the key only, token intact; async re-key via per-device wrapped blobs, no re-pairing). See §1.
- [ ] 🟠🏗️ Real-time delivery (WebSocket/Durable Objects) replacing polling.
- [ ] 🟠🏗️ **Web Push**: new-message notifications with the app closed (fits the async model perfectly).
- [ ] 🟠🛠️ **At-rest lock** (PIN/passphrase/WebAuthn) wrapping the `GroupKey`.
- [ ] 🟠🛠️ **Export/recover a space** (encrypted recovery code): today, if all devices are lost, the space is unrecoverable. With clear warnings.
- [ ] 🟡🛠️ **Multiple files in a single message** (today each file = a separate message).
- [ ] 🟡🏗️ **Resumable/chunked uploads** and raise the 50 MB limit.
- [ ] 🟡🛠️ **Self-destruct timers** per message.
- [ ] 🔵🛠️ **i18n** (the app is English-only; at least ES/EN).
- [ ] 🔵🛠️ **Self-hosting** docs and configuration (BASE_URL, limits).

## 8. Documentation / observability

- [ ] 🟡⚡ Explicitly document the **threat model** (what the server sees, what it does NOT protect: metadata, sender authenticity, replay) in the README.
- [ ] 🔵⚡ Document the planned **real revocation process** and its current limits (there's already a note in `devices.ts`; bring it to the README).
- [ ] 🔵⚡ Review that the Worker's observability (`observability.enabled`) **doesn't log** sensitive material (today `console.error` for unhandled errors; correct, keep watching).
