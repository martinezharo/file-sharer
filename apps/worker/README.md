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

## Deploy

```bash
pnpm --filter @file-sharer/web build   # produces apps/web/dist (served by [assets])
wrangler deploy
```

## API surface (`/api`)

All endpoints except group creation and the semi-open pairing slots require
`Authorization: Bearer <groupAuthToken>` and `X-Device-Id: <deviceId>`.

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
