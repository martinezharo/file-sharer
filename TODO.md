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

- **Per-device authentication is now implemented.** Each device receives its own
  bearer token inside the E2E-encrypted pairing package. Revocation invalidates only
  that device; every other device stays connected even while offline. Sessions made
  before migration `0003_device_tokens.sql` must be linked again once. This is an
  intentional early-WIP migration rather than retaining the impersonable shared token.

- **Owner/admin/member authorization is now implemented.** The first device in a new
  space is its owner; migration `0004_device_roles.sql` assigns existing spaces to their
  oldest active device. Owners can appoint/remove admins and revoke any non-owner device;
  admins can add devices and revoke members; members cannot mutate membership. Ownership
  transfer is deliberately deferred until it has a dedicated confirmation flow.

- **`GroupKey` rotation on revocation is now implemented.** Keys are versioned by epoch
  (`0005_key_rotation.sql`); revoking flags the space as owing a rotation, and any active
  device that polls completes it under a compare-and-swap on `groups.key_epoch`. Every device
  keeps its old epochs, so history stays readable, and no token is touched, so nothing
  re-pairs. Existing spaces default to epoch 1 and are unaffected until their first rotation.

- **Sender signing** (authenticity). 🟠🏗️ Needs a second signing keypair per device and a
  signed message format. Now also the fix for the one rotation trade-off left open: the
  device roster a rotation wraps keys for is currently trusted on first sight (TOFU pins in
  `apps/web/src/crypto/pinning.ts`) rather than signed.
- **Real-time delivery (WebSocket/Durable Objects)** replacing the 8 s poll. 🟠🏗️
- **At-rest lock (PIN/WebAuthn)** + **encrypted recovery export** + **Web Push**. 🟠🏗️ See §7.

---

## 1. Security

- [x] ~~🔴🛠️ **Every device could add or revoke every other device.**~~ Added explicit
  `owner` / `admin` / `member` roles enforced by the Worker, not just the UI. New spaces
  make their creator the owner; existing spaces deterministically assign the oldest active
  device. Only owners manage admin access, admins can add devices and revoke members, and
  nobody can revoke the owner or their current device. A future ownership-transfer flow
  must require explicit confirmation rather than overloading the role endpoint.
- [x] ~~🔴⚡ **Cross-group revocation bypass in `completePairing`.**~~ The `INSERT … ON CONFLICT(id) DO UPDATE SET revoked_at = NULL` matched on the global device PK without checking the group, so an ex-member (who still holds the group token, which is never rotated) could **un-revoke their own device in another group** by reserving a pairing slot with that device id from a throwaway group. Fixed in `apps/worker/src/routes/pairing.ts`: reject a device id already registered to a different group, plus a `WHERE devices.group_id = excluded.group_id` guard on the upsert (defense-in-depth against TOCTOU).
- [x] ~~🔴🏗️ **Revocation does NOT rotate the `GroupKey`.**~~ Implemented. Keys are now versioned
  by epoch: `groups.key_epoch` is the space's current one, every device keeps a local keyring of
  every epoch it has held (`apps/web/src/crypto/keyring.ts`) and every stored ciphertext carries
  the epoch that opens it (`messages.key_epoch`, `devices.name_key_epoch`). Revoking sets
  `groups.rotation_pending`; the revoking device rotates immediately and, if it dies mid-flight,
  the next active device to poll finishes the job — so the work is owed by the *space*, not by
  whoever pressed the button. The rotating device mints the key, wraps it per remaining device
  (ECIES, AAD-bound to group+epoch+recipient) and deposits the blobs, which the server drops on
  ack. Trade-offs deliberately closed: **no re-pairing and no 401s** (tokens untouched),
  **history stays readable** (old epochs kept), **offline devices self-heal** (blob waits),
  **concurrent rotations can't split-brain** (every statement guarded on the previous epoch, CAS
  last), and **no exposure window** — the server rejects any message encrypted under a
  superseded epoch with `key_rotated`, and the client re-encrypts under the new key. What
  remains, unavoidably: the revoked device keeps what it already saw, and the roster a rotation
  wraps for is TOFU-pinned rather than signed (see §0 sender signing).
- [x] ~~🟠🛠️ **Single shared group token + self-asserted `X-Device-Id`.**~~ Replaced with
  independent random bearer tokens whose hashes live on each device row. The server derives
  both device and group identity from the token, and revocation immediately rejects only that
  credential. Remaining defense-in-depth: signed requests can later provide proof of possession
  of the device ECDH/signing key in addition to possession of the bearer.
- [ ] 🟠🏗️ **No sender authenticity.** `senderDeviceId`/`senderName` are provided by the server, not the sender. A malicious server can forge who sent what. Add a **signing** keypair per device (ECDSA/Ed25519) and sign messages; the receiver verifies with the public key published at pairing time.
- [ ] 🟡🛠️ **No replay/reorder protection.** The server could resend, duplicate or reorder messages. Consider per-device signed sequence numbers. At minimum, document it in the threat model.
- [x] ~~🟡⚡ **Pairing slot not deleted on completion.**~~ `pollPairing` left the (encrypted) package reachable by `pairingId` until cron reaped it (≤10 min). Fixed: the joining device now calls a new `DELETE /api/pairing/:pairingId` endpoint right after it successfully unwraps the package and persists its session; cron remains the safety net if that call never arrives.
- [x] ~~🟡⚡ **`completePairing` registers the slot's public key (step 1, anonymous), not the scanned one.**~~ The wrap targeted the scanned QR key, but D1 stored `slot.newDevice.publicKey`, with nothing checking they matched. Fixed: the existing device now also sends `scannedPublicKey` in `PairingCompleteBody`, and the server rejects the request if it doesn't match the slot's.
- [x] ~~🟡🛠️ **JSON bodies are parsed before size validation.**~~ `readJson` read the whole body even though `encryptedPayload` is capped at 1 MB *afterwards*. Fixed: added an early `Content-Length` check (`MAX_JSON_BODY_SIZE`, 2 MB) in `apps/worker/src/http.ts` that rejects oversized bodies with 413 before parsing.
- [x] ~~🟠🛠️ **Poisoned-file infinite re-download loop.**~~ Fixed in `apps/web/src/sync/sync.ts`: decrypt failures (text, file metadata and file blobs) now consume a bounded in-memory retry budget (3 attempts); once exhausted the message is marked `corrupted` (new `FileState` / `LocalMessage.corrupted` flag, rendered as "Couldn't decrypt" with no retry affordance) and **acked**, so it stops being re-polled/re-downloaded — giving up is persisted through the ack itself. A `not_found` on download (blob past its TTL) is likewise terminal: marked `expired` and acked instead of retrying until the message row dies. Transient failures (network/5xx and local `putFile`/quota errors) keep the previous retry-next-pass behavior and never spend the decrypt budget. On the *send* side, `sync/outbox.ts` now re-queues only `NetworkError` and transient `ApiError`s (`rate_limited`/`internal`); local throws (encrypt on a corrupt blob, IndexedDB errors) mark the message `failed` — surfaced with the existing Retry button — instead of silently re-queueing forever.
- [x] ~~🟡⚡ **Falsified `Content-Length` on file uploads.**~~ An early oversized-header check already existed; the remaining hole was a *missing* header (chunked transfer), where the cap was only enforced after the full body had been consumed and stored in R2. Fixed in `apps/worker/src/routes/files.ts`: `Content-Length` is now mandatory on PUT `/files/:key` (400 without it) — every legitimate client uploads a fully-buffered ciphertext, which always carries it. The post-R2 size check stays as defense-in-depth against a spoofed-smaller header.
- [x] ~~🔵⚡ **`sendMessage` returns 500 (constraint violation) instead of 409 (conflict) for duplicate ids.**~~ Fixed: the insert batch in `apps/worker/src/routes/messages.ts` is wrapped and a `UNIQUE constraint failed` error is mapped to the same `conflict` the pre-check throws, closing the check-then-insert race for concurrent retries.
- [x] ~~🔵🔵 **`createGroup` accepts any string as `authTokenHash`.**~~ Fixed: new `requireSha256Hex` helper in `apps/worker/src/http.ts` (64 lowercase hex chars) used by `createGroup`; non-conforming input gets `bad_request`.
- [ ] 🔵🛠️ **Shared files sit in Cache Storage in clear** until `consumeSharedContent` drains them. Small exposure window; encrypt or clean up more aggressively.

## 2. Privacy

- [x] ~~🔴🏗️ Key rotation on revocation (see §1) — without it there is no real "forget".~~ Done.
  "Forget" is now honest going forward: a revoked device can't read anything sent after it left.
  It is still not retroactive, and the UI says so rather than implying otherwise.
- [ ] 🟠🏗️ **No client at-rest encryption.** IndexedDB stores messages, decrypted files, the `GroupKey` (as a `CryptoKey`) and the `deviceAuthToken` in clear. Anyone with device access (or an XSS) gets everything. Add an optional PIN/passphrase lock (derive a wrapping key with PBKDF2/Argon2) or WebAuthn/passkey to wrap the `GroupKey` at rest.
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
- [x] ~~🔵⚡ **`authenticate` does 2 D1 queries per request.**~~ Fixed: single round-trip in `apps/worker/src/auth.ts` using `groups LEFT JOIN devices` — the LEFT JOIN keeps the group row when the device is missing/revoked, so the 401 (bad token) vs 403 (bad device) distinction is preserved.

## 4. Best practices / tooling

- [ ] 🟠🛠️ **The Worker has no unit tests.** Only the e2e script (needs a running server). Add `@cloudflare/vitest-pool-workers` to test auth, the router, validation (`http.ts`), errors and the cron in isolation.
- [ ] 🟡🛠️ **No component tests** in the PWA (crypto only). Add `@testing-library/preact` for key flows (composer, pairing, message rendering).
- [ ] 🟡⚡ **Confirm the committed `database_id`** in `wrangler.jsonc` (`05e8acfd-…`). The comment says "replace"; if it is the real prod id, fine (not secret), but document it to avoid confusion.
- [ ] 🔵⚡ **`exactOptionalPropertyTypes: false`** in `tsconfig.base.json`. Enabling it hardens optional handling (may need minor adjustments).
- [ ] 🔵⚡ `sha256Hex` duplicated (worker `auth.ts` / web `crypto.ts`): unavoidable due to different runtimes, noted for the record.

## 5. Refactoring

- [ ] 🟡🛠️ **`processIncoming` mixes responsibilities** (create local, download, ack). Split into smaller functions.
- [ ] 🟡🛠️ **`actions.ts` is a grab-bag** (onboarding + pairing + messaging + files + session). Split by domain.
- [x] ~~🔵⚡ **"Active group devices" query repeated** in `auth.ts`, `db.ts`, `devices.ts`.~~ Centralized
  as `activeDevices()` in `apps/worker/src/db.ts`, which now also feeds the key-rotation recipient
  list; `activeDeviceIds()` derives from it.
- [ ] 🔵⚡ **`sendFileMessages` is sequential.** Acceptable to avoid overload, but could parallelize with a concurrency limit.

## 6. UI / UX / Accessibility

- [ ] 🟡⚡ **No retry for failed text.** A `failed` outgoing message shows an alert icon but isn't tappable (files do have retry). Add tap-to-retry.
- [ ] 🟡🛠️ **No image/video previews.** Everything renders as a generic file card. Render inline thumbnails/previews from the decrypted blob (`URL.createObjectURL`).
- [x] ~~🟡⚡ **No drag-and-drop** or **paste-image** to attach (button only).~~ Both done.
  Paste is handled in the composer (images only — the text flavour *is* the message) and
  drop works over the whole window, not just the composer: `apps/web/src/ui/DropZone.tsx`
  binds `window` in the capture phase so a stray drop can never fall through to the
  browser's default of navigating away, and it's mounted outside the view switch so a drop
  on the landing doesn't discard a session in progress. Dropped folders are expanded via the
  entry API. The shared `DataTransfer` extraction lives in `apps/web/src/share/transfer.ts`.
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

- [x] ~~🔴🏗️ `GroupKey` rotation → real revocation (rotate the key only, token intact; async re-key via per-device wrapped blobs, no re-pairing).~~ Done, see §1.
- [ ] 🟡🛠️ **Ownership transfer and recovery.** Add an explicit, confirmed hand-off to
  another admin before the owner leaves, then design a recovery path for a permanently lost
  owner (likely tied to the encrypted recovery export) without weakening membership security.
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

- [ ] 🟡⚡ Explicitly document the **threat model** (what the server sees, what it does NOT protect: metadata, sender authenticity, replay) in the README. Partially done: the README now has a "What this does *not* protect against" section covering rotation's limits, sender authenticity, replay and metadata; it still needs the positive half (exactly what the server does see).
- [x] ~~🔵⚡ Document the **real revocation process** and its current limits.~~ In the README's crypto model, alongside the honest list of what rotation does not cover.
- [ ] 🔵⚡ Review that the Worker's observability (`observability.enabled`) **doesn't log** sensitive material (today `console.error` for unhandled errors; correct, keep watching).
