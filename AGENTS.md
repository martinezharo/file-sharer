# AGENTS.md

## What this is

A tiny end-to-end-encrypted PWA to share text and files (≤ 50 MB) between a user's own
devices **asynchronously**: pair each device once via QR (ECIES over an out-of-band public
key), and afterwards the devices never need to be online at the same time — messages and
files sit encrypted on the server until the recipient device next syncs. The server (a
single Cloudflare Worker) only ever sees ciphertext, public keys and hashes — plaintext
and the symmetric `GroupKey` never leave the client devices.

**The core invariant: the server is zero-knowledge.** If a change would make the Worker
capable of reading plaintext, hold the `GroupKey`, or see the raw group auth token, it is
wrong — stop and reconsider. Everything below serves this invariant.

## Setup & commands

Package manager is **pnpm** (workspaces); Node ≥ 20. Run from the repo root unless noted.

```bash
pnpm install
pnpm dev                  # worker (wrangler dev :8787) + web (vite :5173) together
pnpm build                # build the PWA only (apps/web → apps/web/dist)
pnpm deploy               # build PWA, then deploy the Worker (serves PWA + API)

pnpm test                 # all package tests (-r --if-present)
pnpm typecheck            # tsc --noEmit across all packages (incl. the SW tsconfig)
pnpm lint                 # Biome lint
pnpm format               # Biome format --write
pnpm format:check         # Biome format check (CI-safe)

pnpm db:migrate:local     # apply D1 migrations to the local dev DB
pnpm db:migrate:remote    # apply D1 migrations to production
```

Per-package / single-test:

```bash
pnpm --filter @file-sharer/web test                                        # vitest run (web only)
pnpm --filter @file-sharer/web exec vitest run src/crypto/crypto.test.ts   # one test file
pnpm --filter @file-sharer/web exec vitest -t "ECIES"                      # by test name
pnpm --filter @file-sharer/worker dev                                      # just the Worker
pnpm --filter @file-sharer/worker cf-typegen                               # regenerate worker types
```

End-to-end verification (exercises the real crypto core against a running Worker):

```bash
pnpm dev                         # in one terminal (or: wrangler dev in apps/worker)
node scripts/e2e-verify.mts      # in another; honors BASE_URL (default :8787)
```

**Before committing:** run `pnpm typecheck`, `pnpm test`, and `pnpm lint`. Formatting is
Biome (`biome.json`, 2-space indent, 100 cols, double quotes, trailing commas) — run
`pnpm format` rather than hand-formatting.

## Architecture

Monorepo (`pnpm-workspace.yaml`: `apps/*`, `packages/*`):

- **`packages/shared`** — the single source of truth for the client↔server contract: all DTOs,
  the `ApiErrorCode` union, and shared constants (`MAX_FILE_SIZE`, `MAX_UPLOAD_SIZE`,
  `MESSAGE_TTL_MS`, `PAIRING_TTL_MS`, `POLL_INTERVAL_MS`, `DEVICE_ID_HEADER`). Consumed as
  source (`main`/`types` point at `src/index.ts`), so changes are picked up without a build
  step. Change a request/response shape here and update both apps in the same change.
- **`apps/worker`** — one Cloudflare Worker serving both the API and the built PWA from the same
  origin (no CORS). `src/index.ts`: `/api/*` is routed by the in-house `Router`; `/share-target`
  is handled for the Web Share Target; everything else is served from `[assets]` (the built
  `apps/web/dist`) with SPA fallback to `index.html`. Backed by **D1** (binding `DB`, metadata)
  and **R2** (binding `FILES`, encrypted blobs). Route handlers live in `src/routes/*`
  (devices, groups, files, messages, pairing). A `scheduled` handler runs hourly cleanup
  (`src/cron.ts`).
- **`apps/web`** — Preact + Vite PWA. Web Crypto for E2E crypto, IndexedDB (`idb`) for local
  persistence, `@preact/signals` for state, Tailwind + `lucide-preact` for UI, `qrcode`/`jsqr`
  for device pairing.

In dev, Vite proxies `/api` → `http://localhost:8787`; the service worker is told never to cache
`/api/*` (`navigateFallbackDenylist` in `vite.config.ts`).

## Crypto & data model

All crypto lives in `apps/web/src/crypto/crypto.ts`:

- **GroupKey** — AES-GCM 256. Encrypts every message, file, and file-metadata blob. Created once
  by the first device.
- **Device keypair** — ECDH P-256; the private key is **non-extractable** (`CryptoKey`).
- **Pairing (ECIES)** — a joining device publishes its public key out-of-band (QR/text). An
  existing device wraps `{ groupKey, groupAuthToken, groupId }` with an ephemeral ECDH key.
  Because the public key is scanned, not sent, there is no MITM.
- **API auth** — a 256-bit bearer group token. The server stores only `SHA-256(token)`. Every
  authenticated request also carries `X-Device-Id`; `authenticate()` checks the device exists,
  belongs to the group, and is not revoked.

Lifecycle / retention: sending a message creates one `delivery_status` row per *other* active
device. Acking the last pending recipient deletes the message metadata **and** its R2 object
immediately (`deleteMessageById`). The cron job is a safety net: it reaps pairing slots > 10 min
and any message/file > 24 h old. R2 also has a 24 h bucket lifecycle rule configured out-of-band
(see `apps/worker/README.md`) — not in `wrangler.jsonc`.

## Conventions

### Worker (`apps/worker`)

- **Routes** are handler functions taking a `RouteContext` (`src/router.ts`), registered in
  `src/index.ts`. Start each authenticated handler with `await authenticate(c.request, c.env)`.
- **Errors**: throw `ApiError(code, message)` (`src/errors.ts`); the top-level `fetch` catches it
  and serializes to the shared `ApiErrorBody` JSON shape. Use `json()` for success responses.
- **Input validation**: use the helpers in `src/http.ts` (`readJson`, `requireString`,
  `optionalString`, `requireId`). `requireId` restricts to URL-safe chars — always use it for
  client-supplied path segments / R2 keys.
- **Security**: `src/security.ts` owns the strict CSP (`script-src 'self'`, no inline JS — an XSS
  would defeat the whole crypto model) and applies it to asset responses. Abuse protection uses
  Cloudflare `ratelimit` bindings declared under `unsafe` in `wrangler.jsonc`.

### Web (`apps/web`)

- **Data flow**: `actions.ts` holds user-intent operations (create/link space, send, revoke,
  logout). `sync/sync.ts` is the engine — a single polling loop (`POLL_INTERVAL_MS`, plus
  focus/online events) that flushes the outbox, downloads + decrypts incoming files, and only
  **acks a file after a successful download + decrypt** (so the server never deletes an
  unreceived file). Outbound sends are optimistic: queue a `LocalMessage`, then `void syncNow()`
  + `requestBackgroundSync()`.
- **Service worker boundary**: the outbox flush lives in `sync/outbox.ts` and is shared with the
  custom service worker (`src/sw.ts`, vite-plugin-pwa `injectManifest`); on Chromium the
  Background Sync API wakes the SW to finish queued uploads even after the app is closed. Anything
  `outbox.ts`/`sw.ts` (and `src/sw/*`) import must stay free of DOM APIs and signals — it is
  typechecked separately via `tsconfig.sw.json` with the WebWorker lib and must read
  session/keys/queue from IndexedDB only.
- **Share Target**: the OS share sheet POSTs `multipart/form-data` to `/share-target`; the SW
  (`src/sw/share-target.ts`) stashes the payload in Cache Storage and redirects into the app,
  which drains it on boot (`src/share/incoming.ts`). Keep the cache key in sync across those two.
- **State**: `src/state/*` as `@preact/signals`; `src/db/store.ts` wraps IndexedDB (meta KV for
  session/keys, blob store for files). `CryptoKey`/`CryptoKeyPair` objects are persisted directly
  into IndexedDB (structured clone) — **do not export keys** to do this.

## Database changes

The schema lives in `apps/worker/migrations/` (D1 SQL migrations, numbered e.g. `0001_init.sql`).
For any schema change, add a **new** numbered migration file rather than editing an applied one,
then run `pnpm db:migrate:local` (and `:remote` for production). The migrations directory is the
canonical schema; there is no separate structure file.

## Notes & gotchas

- TypeScript is strict everywhere via `tsconfig.base.json` (`noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `isolatedModules`). Builds run `tsc --noEmit` (app + SW configs) before
  Vite.
- Tests use **Vitest** in `apps/web` (`src/**/*.test.ts`, node environment). The Worker has no
  unit tests; `scripts/e2e-verify.mts` is the integration check.
- The `wrangler.jsonc` `d1_databases[].database_id` is a placeholder; the real id is filled in
  during one-time setup (see `apps/worker/README.md`). The placeholder is fine for `--local`.
