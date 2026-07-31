# TODO — file-sharer

> Remaining work only. Anything that is done has been removed from this file:
> the crypto and authorization model is documented in the README, and the
> reasoning behind each change lives in its commit.
>
> Legend: 🔴 critical · 🟠 important · 🟡 improvement · 🔵 nice-to-have
> Effort: ⚡ quick · 🛠️ medium · 🏗️ large

---

## 0. Priorities / next up

Biggest remaining items (need design decisions, don't do blindly):

- **Web Push**: new-message notifications with the app closed. 🟠🏗️ The Durable Object that
  now fans out real-time notifications is the natural place to send them from — it already
  knows which devices are connected, so the ones that are *not* are exactly the ones to push to.

---

## 1. Security

- [ ] 🟡🛠️ **No replay/reorder protection.** The server could resend, duplicate or reorder messages: a signature proves *what* was sent, not *when* or *in what order*. Now cheap to close — the signing key is already there, so it is a per-device monotonic counter inside the signed statement (and a receiver-side "highest seen" per sender). Documented in the README meanwhile.
- [ ] 🔵🛠️ **Shared files sit in Cache Storage in clear** until `consumeSharedContent` drains them. Small exposure window; encrypt or clean up more aggressively.

## 2. Privacy

- [ ] 🟡⚡ **The at-rest lock is opt-in and has no auto-lock.** It locks on launch and on demand, never on a timer or after inactivity. Worth revisiting once there is data on how people actually use it; a timeout that fires mid-upload would be worse than no timeout.
- [ ] 🟡🏗️ **Server-observable metadata:** sizes (via `Content-Length` and metadata length), timing, device count. For sizes, consider padding the ciphertext to buckets. Explicitly document what the server sees.

## 3. Performance

- [ ] 🔵⚡ **The safety-net poll is a fixed 60 s** while the socket is up. It could back off further (or stop while the tab is hidden and a notification would wake it anyway), but only once there is evidence about how often a notification is actually lost.
- [ ] 🟡⚡ **Dead `since` cursor — needs a design decision, not a blind wire-up.** `apps/web/src/sync/sync.ts` always calls `api.pendingMessages(auth)` with `since=0`. On inspection this isn't just an unused optimization: the worker query (`apps/worker/src/routes/messages.ts`) already scopes results via `ds.device_id = ? AND ds.downloaded_at IS NULL` (backed by `idx_delivery_device_pending`), so every row returned is, by definition, still pending for this device — `since` currently adds nothing. Naively wiring it to "last acked `createdAt`" would filter on `m.created_at`, which is a wall-clock timestamp assigned by whichever edge Worker handled `sendMessage`; under clock skew/out-of-order arrival across colos, a message from another device could land with a `created_at` at or before the cursor and get **silently filtered out and never delivered**. If this is worth doing, it needs a monotonic cursor (e.g. an auto-increment `rowid`/sequence) instead of `created_at`, which is a real design decision — left for §0.
- [ ] 🟡🛠️ **One-shot in-memory file crypto.** `encryptFile`/`decryptFile` load the whole file + ciphertext + decrypted copy (up to ~3×50 MB) into RAM. Move to chunked/streaming crypto for low-end phones and to be able to raise the size limit.
- [ ] 🟡🛠️ **Heavy initial bundle.** `jsqr`, `qrcode` and the scanner are only needed when pairing; the 3 variable font families (`bricolage`, `hanken`, `jetbrains-mono`) are loaded eagerly in `main.tsx`. Code-split the pairing flow (lazy import) and subset/selectively preload fonts.
- [ ] 🔵🛠️ **Chat list not virtualized** (`Chat.tsx`): full re-render. Virtualize for long histories.
- [ ] 🔵🟡 **Base64 ciphertext in D1** (up to 1 MB per `encryptedPayload`) bloats the database. Acceptable, keep an eye on it.
- [ ] 🟠🛠️ **IndexedDB grows without bound.** `apps/web/src/db/store.ts` only prunes on `logout()` / `clearAll()`. Sent + received messages, the `files` blob store, and the device names all accumulate forever; `allMessages()` is loaded into memory on every `loadMessages` and on every outbox flush (`sync/outbox.ts:90`) to filter the queue. After months of use this hurts both memory and every sync pass. Add a local retention policy (e.g. keep last N months, cap blob count, configurable) and a status index so the outbox doesn't need a full scan.

## 4. Best practices / tooling

- [ ] 🟡🛠️ **No component tests** in the PWA (crypto, the vault, at-rest storage, the outbox and the Worker are covered). Add `@testing-library/preact` for key flows (composer, pairing, lock screen, message rendering).
- [ ] 🟡🛠️ **No tests for `db/store.ts` or `state/lock.ts`.** Both need a fake IndexedDB (`fake-indexeddb`); the crypto underneath them is covered, the wiring that turns a lock on and off is not.
- [ ] 🟡⚡ **Confirm the committed `database_id`** in `wrangler.jsonc` (`05e8acfd-…`). The comment says "replace"; if it is the real prod id, fine (not secret), but document it to avoid confusion.
- [ ] 🔵⚡ **`exactOptionalPropertyTypes: false`** in `tsconfig.base.json`. Enabling it hardens optional handling (may need minor adjustments).
- [ ] 🔵⚡ `sha256Hex` duplicated (worker `auth.ts` / web `crypto.ts`): unavoidable due to different runtimes, noted for the record. The Worker's copy is now pinned to a known digest by `auth.test.ts`, so the two cannot drift silently.

## 5. Refactoring

- [ ] 🟡🛠️ **`processIncoming` mixes responsibilities** (create local, download, ack). Split into smaller functions.
- [ ] 🟡🛠️ **`actions.ts` is a grab-bag** (onboarding + pairing + messaging + files + session). Split by domain.
- [ ] 🔵⚡ **`sendFileMessages` is sequential.** Acceptable to avoid overload, but could parallelize with a concurrency limit.

## 6. UI / UX / Accessibility

- [ ] 🟡⚡ **No retry for failed text.** A `failed` outgoing message shows an alert icon but isn't tappable (files do have retry). Add tap-to-retry.
- [ ] 🟡🛠️ **No image/video previews.** Everything renders as a generic file card. Render inline thumbnails/previews from the decrypted blob (`URL.createObjectURL`).
- [ ] 🟡🛠️ **No real upload/download progress** for large files (spinner only). Show %.
- [ ] 🟡🛠️ **No "clear history".** Single-message delete now exists in both flavours (this device / all devices), but there is no way to wipe a whole conversation in one go. The tombstone pipeline is the mechanism; what it needs is a bounded batch form, since one tombstone per message does not scale to a year of history.
- [ ] 🟡🛠️ **No date separators** in the chat (time only). Group by day.
- [ ] 🔵⚡ **`Modal` has no full focus trap** (Escape + focus restore are done). Trap Tab within the dialog.
- [ ] 🔵⚡ **Rename a device** after creation: doesn't exist.
- [ ] 🔵⚡ **Delivery/read indicators.** The server already has `delivery_status`; could show "delivered to N devices".
- [ ] 🔵🛠️ **No search** in messages.
- [ ] 🔵⚡ **QR scanner** has no torch/camera switch.
- [ ] 🔵⚡ **No manual theme toggle** (system `dark:` only). Optional.

## 7. Features (roadmap "next level")

- [ ] 🟠🏗️ **Web Push**: new-message notifications with the app closed (fits the async model perfectly).
- [ ] 🟡🛠️ **Ownership transfer.** Add an explicit, confirmed hand-off to another admin before the owner leaves. (Recovering a permanently lost owner is now covered by the recovery file, which restores that device's identity, role included.)
- [ ] 🟡🛠️ **Multiple files in a single message** (today each file = a separate message).
- [ ] 🟡🏗️ **Resumable/chunked uploads** and raise the 50 MB limit.
- [ ] 🟡🛠️ **Self-destruct timers** per message.
- [ ] 🔵🛠️ **i18n** (the app is English-only; at least ES/EN).
- [ ] 🔵🛠️ **Self-hosting** docs and configuration (BASE_URL, limits).

## 8. Documentation / observability

- [ ] 🟡⚡ Explicitly document the **threat model** (what the server sees, what it does NOT protect: metadata, replay) in the README. Partially done: the README's "What this does *not* protect against" now covers rotation's limits, the two residuals of sender authenticity, replay and metadata; it still needs the positive half (exactly what the server does see).
- [ ] 🔵⚡ Review that the Worker's observability (`observability.enabled`) **doesn't log** sensitive material (today `console.error` for unhandled errors; correct, keep watching). `index.test.ts` pins the shape of the 500 response so an internal message can never reach the client.
