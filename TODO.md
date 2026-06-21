# TODO — file-sharer in-depth audit

> A full pass over the project to take it "to the next level". Each item carries a
> severity/impact and, where relevant, the specific file and a suggested fix.
>
> Legend: 🔴 critical · 🟠 important · 🟡 improvement · 🔵 nice-to-have
> Effort: ⚡ quick · 🛠️ medium · 🏗️ large

---

## 0. Executive summary / recommended order

### ✅ Done in this pass (urgent + scoped important items)

- **Security headers** on the Worker: strict CSP (`script-src 'self'`), HSTS,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
  COOP/CORP. Build adjusted to emit no inline scripts (`apps/worker/src/security.ts`,
  `index.ts`, `vite.config.ts`, `public/seo-canonical.js`).
- **Encrypted device names** with the GroupKey (migration `0002`); the server no longer
  sees device PII. Touched: DTOs, schema, `groups/pairing/devices/messages` routes and the
  client (`actions.listDevicesDecrypted`, `sync`).
- **Rate limiting** (Cloudflare `ratelimit` bindings) on `/api/groups`, `/api/pairing/request`,
  message sends and file uploads.
- **R2 group scoping** (`fileStorageKey = groupId/key`) + **real upload cap** (checks
  `object.size` after the PUT, not just `Content-Length`).
- **AAD in AES-GCM** for text, files, metadata and the pairing wrap (prevents a malicious
  server from transplanting ciphertext across messages/roles).
- **Unified outbox**: files are now retried just like text.
- **Accessible Modal** (Escape, focus, `role="dialog"`/`aria-modal`/`aria-labelledby`) +
  native `confirm()` replaced with `Modal`; `type="button"` on the buttons that lacked it.
- **Biome (lint/format) + CI** (`.github/workflows/ci.yml`: lint, typecheck, test, build).

Verified: `pnpm lint`, `pnpm typecheck`, `pnpm test` (13 ✓) and `pnpm build` all green; migration
`0002` applied to the local D1.

### ⏭️ Deliberately deferred (needs design decisions, not to be done blindly)

- **`GroupKey` rotation + per-device tokens → real revocation.** 🔴🏗️ Requires re-pairing
  devices that are **offline** (a genuine distributed problem); the re-keying protocol must be
  designed before touching code.
- **Sender signing** (authenticity). 🟠🏗️ Needs a second signing keypair per device and a
  signed message format.
- **Real-time (WebSocket/Durable Objects)**, **at-rest lock (PIN/WebAuthn)**, **encrypted
  recovery**, **Web Push**. 🟠🏗️ Large features; see §7.

---

## 1. Security

- [x] 🔴🛠️ **Security headers** — done. `withSecurityHeaders` wraps every response (API + assets) with a strict CSP + HSTS + nosniff + frame-ancestors/X-Frame-Options + Referrer-Policy + Permissions-Policy + COOP/CORP (`apps/worker/src/security.ts`).
- [ ] 🔴🏗️ **Revocation does NOT rotate the `GroupKey`.** `apps/worker/src/routes/devices.ts` only sets `revoked_at`. A revoked device keeps the `GroupKey` and `groupAuthToken` locally forever and can decrypt any ciphertext it already saw/exfiltrated. Real revocation = generate a new `GroupKey` + new token, re-pair the active devices and rewrite `auth_token_hash`. This is the biggest current privacy limitation.
- [x] 🔴🛠️ **Encrypted device names** — done. `devices.name` → `name_enc`/`name_iv` (migration `0002`), encrypted with the GroupKey and bound to the `deviceId` via AAD. The server no longer sees PII; the client decrypts them (`listDevicesDecrypted`, `sync`).
- [x] 🟠🛠️ **Rate limiting** — done (partial). `ratelimit` bindings (`RL_PUBLIC`/`RL_WRITE`/`RL_UPLOAD`) in `wrangler.jsonc` applied to `createGroup` and `requestPairing` (by IP), `sendMessage` and `uploadFile` (by device). `pollPairing` is left unlimited on purpose (2.5 s poll, protected by an unguessable `pairingId`).
- [ ] 🟠🛠️ **Single shared group token (not per-device).** All devices share one bearer. If it leaks from any device → full access. Also `X-Device-Id` is a self-asserted string: with the shared token, a device can impersonate another's `deviceId` (read its pending messages, ack, send as it). Redesign to a **per-device token** (server maps token→device→group); this also makes revocation actually cut off the affected device.
- [x] 🟠🛠️ **R2 key bound to the group** — done. `fileStorageKey(groupId, key)` prefixes every key with the authenticated group on upload/download/head/delete (`files.ts`, `db.ts`, `messages.ts`); a device can only ever touch `itsGroup/…`.
- [x] 🟠⚡ **Real upload cap** — done. After the `put`, if `object.size > MAX_UPLOAD_SIZE` the object is deleted and 413 is returned (covers chunked uploads without `Content-Length`).
- [x] 🟠🏗️ **AAD in AES-GCM** — done. Text (`text:${id}`), file (`file:${id}`), metadata (`meta:${id}`), name (`name:${deviceId}`) and the pairing wrap (`pairing:${pairingId}`). Tests added in `crypto.test.ts`.
- [ ] 🟠🏗️ **No sender authenticity.** `senderDeviceId`/`senderDeviceName` are provided by the server, not the sender. A malicious server can forge who sent what. Add a **signing** keypair per device (ECDSA/Ed25519) and sign messages; the receiver verifies with the public key published at pairing time.
- [ ] 🟡🛠️ **No replay/reorder protection.** The server could resend, duplicate or reorder messages. Consider per-device signed sequence numbers. At minimum, document it in the threat model.
- [ ] 🟡⚡ **Pairing slot not deleted on completion.** `pollPairing` leaves the (encrypted) package reachable by `pairingId` until cron reaps it (≤10 min). Delete the slot after a successful poll/ack by the joining device.
- [ ] 🟡⚡ **`completePairing` registers the slot's public key (step 1, anonymous), not the scanned one.** The wrap targets the scanned QR key, but D1 stores `slot.newDevice.publicKey`. They match in the normal flow, but verifying QR pubkey == slot pubkey would be good defense in depth.
- [ ] 🟡🛠️ **JSON bodies are parsed before size validation.** `readJson` reads the whole body even though `encryptedPayload` is capped at 1 MB *afterwards*. Add an early `Content-Length` check on JSON endpoints.
- [ ] 🔵🛠️ **Shared files sit in Cache Storage in clear** until `consumeSharedContent` drains them. Small exposure window; encrypt or clean up more aggressively.

## 2. Privacy

- [ ] 🔴 Encrypt device names (see §1) — direct PII leak. **(done — see §1)**
- [ ] 🟠 Key rotation on revocation (see §1) — without it there is no real "forget".
- [ ] 🟡🏗️ **Server-observable metadata:** sizes (via `Content-Length` and metadata length), timing, device count. For sizes, consider padding the ciphertext to buckets. Explicitly document what the server sees.
- [ ] 🟠🏗️ **No client at-rest encryption.** IndexedDB stores messages, decrypted files, the `GroupKey` (as a `CryptoKey`) and the `groupAuthToken` in clear. Anyone with device access (or an XSS) gets everything. Add an optional PIN/passphrase lock (derive a wrapping key with PBKDF2/Argon2) or WebAuthn/passkey to wrap the `GroupKey` at rest.

## 3. Performance

- [ ] 🟠🏗️ **Polling every 8 s** (`POLL_INTERVAL_MS`) drains battery and adds latency. Migrate to WebSocket/SSE with Durable Objects for real-time push delivery.
- [ ] 🟡⚡ **Dead `since` cursor.** `apps/web/src/sync/sync.ts` always calls `api.pendingMessages(auth)` with `since=0`; the parameter exists but never advances. Track the last acked `createdAt` and pass it, reducing the server-side scan.
- [ ] 🟡🛠️ **One-shot in-memory file crypto.** `encryptFile`/`decryptFile` load the whole file + ciphertext + decrypted copy (up to ~3×50 MB) into RAM. Move to chunked/streaming crypto for low-end phones and to be able to raise the size limit.
- [ ] 🟡🛠️ **Heavy initial bundle.** `jsqr`, `qrcode` and the scanner are only needed when pairing; the 3 variable font families (`bricolage`, `hanken`, `jetbrains-mono`) are loaded eagerly in `main.tsx`. Code-split the pairing flow (lazy import) and subset/selectively preload fonts.
- [ ] 🟡⚡ **`upsertMessage` re-sorts the whole array** on every insert (`state/messages.ts`). Degrades with large histories and batch syncs. Insert in order or keep a `Map` + derived view.
- [ ] 🔵🛠️ **Chat list not virtualized** (`Chat.tsx`): full re-render. Virtualize for long histories.
- [ ] 🔵🟡 **Base64 ciphertext in D1** (up to 1 MB per `encryptedPayload`) bloats the database. Acceptable, keep an eye on it.

## 4. Best practices / tooling

- [x] 🟠⚡ **Biome (lint/format)** — done. `biome.json` + `lint`/`format`/`format:check` scripts. Rules tuned to the project's idioms (Preact signals, hook deps); real findings fixed (`type="button"`, etc.).
- [x] 🟠⚡ **CI** — done. `.github/workflows/ci.yml` runs lint + typecheck + test + build on push/PR.
- [ ] 🟠🛠️ **The Worker has no unit tests.** Only the e2e script (needs a running server). Add `@cloudflare/vitest-pool-workers` to test auth, the router, validation (`http.ts`), errors and the cron in isolation.
- [ ] 🟡🛠️ **No component tests** in the PWA (crypto only). Add `@testing-library/preact` for key flows (composer, pairing, message rendering).
- [ ] 🟡⚡ **Confirm the committed `database_id`** in `wrangler.jsonc` (`05e8acfd-…`). The comment says "replace"; if it is the real prod id, fine (not secret), but document it to avoid confusion.
- [ ] 🔵⚡ **`exactOptionalPropertyTypes: false`** in `tsconfig.base.json`. Enabling it hardens optional handling (may need minor adjustments).
- [ ] 🔵⚡ `sha256Hex` duplicated (worker `auth.ts` / web `crypto.ts`): unavoidable due to different runtimes, noted for the record.

## 5. Refactoring

- [x] 🟠🛠️ **Unified outbox** — done. `flushOutbox` handles text and files; `sendFileMessage` now only caches the original and enqueues, and `sync` encrypts+uploads+sends with retry (`sendQueuedFile`). Removed the dead `_session` parameter.
- [ ] 🟡🛠️ **`processIncoming` mixes responsibilities** (create local, download, ack). Split into smaller functions.
- [ ] 🟡🛠️ **`actions.ts` is a grab-bag** (onboarding + pairing + messaging + files + session). Split by domain.
- [ ] 🔵⚡ **"Active group devices" query repeated** in `auth.ts`, `db.ts`, `devices.ts`. Centralize.
- [ ] 🔵⚡ **`sendFileMessages` is sequential.** Acceptable to avoid overload, but could parallelize with a concurrency limit.

## 6. UI / UX / Accessibility

- [x] 🟠⚡ **Accessible `Modal`** — done. `role="dialog"`, `aria-modal`, `aria-labelledby`, close on `Escape`, initial focus and focus restoration on close (`ui/components.tsx`). (A full focus trap is still missing — minor follow-up.)
- [x] 🟠⚡ **`confirm()` replaced** — done. Device revocation now uses a `Modal` consistent with "Leave space".
- [ ] 🟡⚡ **No retry for failed text.** A `failed` outgoing message shows an alert icon but isn't tappable (files do have retry). Add tap-to-retry.
- [ ] 🟡🛠️ **No image/video previews.** Everything renders as a generic file card. Render inline thumbnails/previews from the decrypted blob (`URL.createObjectURL`).
- [ ] 🟡⚡ **No drag-and-drop** or **paste-image** to attach (button only). Add a drop zone and a paste handler to the composer.
- [ ] 🟡🛠️ **No real upload/download progress** for large files (spinner only). Show %.
- [ ] 🟡🛠️ **No delete/clear history** or single-message delete (local or for everyone). Add message management.
- [ ] 🟡🛠️ **No date separators** in the chat (time only). Group by day.
- [ ] 🔵⚡ **`prefers-reduced-motion`** not honored in animations (`animate-toast-in`, `animate-modal-in`). Respect it.
- [ ] 🔵⚡ **Error toasts** use `role="status"`; errors should use `role="alert"`.
- [ ] 🔵⚡ **Rename a device** after creation: doesn't exist.
- [ ] 🔵⚡ **Delivery/read indicators.** The server already has `delivery_status`; could show "delivered to N devices".
- [ ] 🔵🛠️ **No search** in messages.
- [ ] 🔵⚡ **QR scanner** has no torch/camera switch.
- [ ] 🔵⚡ **No manual theme toggle** (system `dark:` only). Optional.

## 7. Features (roadmap "next level")

- [ ] 🔴🏗️ `GroupKey` rotation + real revocation (depends on per-device tokens).
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
