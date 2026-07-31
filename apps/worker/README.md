# @file-sharer/worker

Single Cloudflare Worker that serves the PWA (Workers Static Assets) and the `/api/*` backend,
backed by D1 (metadata) and R2 (encrypted file blobs).

## One-time setup

```bash
# 1. Create the D1 database and copy the printed database_id into wrangler.jsonc
wrangler d1 create file-sharer-db

# 2. Create the R2 bucket
wrangler r2 bucket create file-sharer-files

# 3. Add the 24h object lifecycle rule (safety net; the API also deletes
#    objects immediately once every active device has acknowledged download)
wrangler r2 bucket lifecycle add file-sharer-files expire-24h --expire-days 1

# 4. Apply the schema
wrangler d1 migrations apply file-sharer-db --remote   # production
wrangler d1 migrations apply file-sharer-db --local    # local dev
```

> The R2 lifecycle rule is **not** part of `wrangler.jsonc`; it is configured on the bucket via
> the CLI above (or the dashboard). Verify it with `wrangler r2 bucket lifecycle list file-sharer-files`.

## Local development

```bash
wrangler dev                 # API on http://localhost:8787
wrangler dev --test-scheduled # also exposes GET /__scheduled to trigger cron cleanup
```

In the monorepo, run `pnpm dev` from the root to start the Worker and the Vite dev server together
(Vite proxies `/api` to `http://localhost:8787`).

## Tests

```bash
pnpm --filter @file-sharer/worker test    # or `pnpm test` from the root, for every package
```

Tests run **inside workerd** through `@cloudflare/vitest-pool-workers`, so `env.DB` is a real D1,
`env.FILES` a real R2 and `SELF` the Worker as it would be deployed. Nothing is mocked: most of the
behaviour worth protecting here lives in SQL — the cross-group upsert guard in pairing, the
compare-and-swap that serializes two concurrent key rotations, the cascade that deletes a message
and its blob on the last ack — and a mock could only ever prove that the mock behaves like the mock.

The schema is built from the real `migrations/` directory before each test file
(`src/test/apply-migrations.ts`), so a migration that forgets a column or a constraint fails the
suite instead of production.

Bindings come from `vitest.config.ts`, not from `wrangler.jsonc`: tests need neither the static
assets (the built PWA) nor the edge rate limiters, which have no local implementation. Leaving the
limiters out is deliberate — it exercises the same "binding not provisioned" no-op path as plain
`wrangler dev`.

Fixtures (`src/test/helpers.ts`) write rows directly rather than driving the API, so a test about
revocation fails when revocation breaks and not when pairing does. They are unique per call: tests
in one file share a database, and both `devices.id` and `devices.auth_token_hash` are globally
unique.

## Deploy

Use `pnpm run deploy` from the repository root. It is the only path that applies pending D1
migrations before publishing; the two commands below build and publish but leave the schema
untouched, so reach for them only when you know there is no migration to apply.

```bash
pnpm --filter @file-sharer/web build   # produces apps/web/dist (served by [assets])
wrangler deploy
```

## API surface (`/api`)

All endpoints except group creation and the semi-open pairing slots require
Authenticated routes use `Authorization: Bearer <deviceAuthToken>`. Every device
receives an independent random credential during creation or encrypted pairing;
the Worker stores only its SHA-256 hash and resolves the device identity from it.
Revoking one device therefore invalidates only that device, without signing out
other devices (including devices that are offline at the time).

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/groups` | none | Create group + first device |
| POST | `/api/pairing/:id/request` | none* | Joining device publishes its public key |
| POST | `/api/pairing/:id/complete` | bearer | Existing device deposits wrapped GroupKey |
| GET | `/api/pairing/:id` | none* | Joining device polls for the wrapped package |
| POST | `/api/messages` | bearer | Store encrypted message metadata |
| GET | `/api/messages/pending` | bearer | Fetch pending messages for this device |
| POST | `/api/messages/:id/ack` | bearer | Confirm download (triggers deletion when complete) |
| PUT | `/api/files/:key` | bearer | Upload encrypted file blob to R2 |
| GET | `/api/files/:key` | bearer | Download encrypted file blob |
| GET | `/api/devices` | bearer | List active devices |
| DELETE | `/api/devices/:id` | bearer | Revoke a device |

\* Protected by an unguessable, short-lived `pairingId`; contents are end-to-end encrypted.
