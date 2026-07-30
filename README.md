# file-sharer

A tiny, end-to-end-encrypted PWA to share text and files (≤ 50 MB) between your **own**
devices — like a private WhatsApp group just for your phones and laptops.

- **E2E encrypted**: the server (Cloudflare) only ever sees ciphertext, public keys and hashes.
  Plaintext and the symmetric `GroupKey` never leave your devices.
- **Asynchronous**: devices don't need to be online at the same time.
- **No indefinite cloud storage**: encrypted files live in R2 for at most 24 h and are deleted
  immediately once every active device confirms download.
- **100 % Cloudflare backend**: a single Worker serving the PWA + the API, backed by D1 and R2.

## Architecture

```
file-sharer/
├── packages/shared   # Shared TypeScript contract (DTOs + constants)
└── apps/
    ├── worker        # Cloudflare Worker: API + static assets + D1 + R2 + cron
    └── web           # PWA: Preact + Vite + Web Crypto + IndexedDB
```

The Worker serves both the API (`/api/*`) and the built PWA (Workers Static Assets) from the
same origin — one deploy, no CORS.

## Crypto model

- **GroupKey**: AES-GCM 256, created by the first device. Encrypts every message/file.
- **Device keypair**: ECDH P-256. The private key is non-extractable and stored as a `CryptoKey`.
- **Pairing**: a new device shows its public key (QR/text); an existing device wraps the GroupKey
  plus a newly generated device token for it using an ephemeral ECDH key (ECIES). The public key travels
  out-of-band (you scan it), so there is no MITM.
- **API auth**: an independent 256-bit bearer token per device. The server stores only
  its SHA-256 and derives the device identity from it, so one device can be revoked
  without disrupting any others.
- **Device roles**: the first device is the space owner, owners can appoint administrators,
  and regular members cannot add or revoke devices. Existing spaces assign ownership to
  their oldest active device during migration.
- **Key rotation on revoke**: revoking a device also rotates the `GroupKey`, so the revoked
  device cannot read anything sent afterwards even if it captures the ciphertext some other
  way. Keys are versioned by *epoch*: the rotating device mints a new one, wraps it (ECIES)
  for each remaining device's published ECDH key and deposits the blobs server-side; each
  device adopts its blob on the next poll and the server drops it on ack. Nothing else
  changes — device tokens are untouched (no re-pairing, no sign-out), every device keeps its
  older epochs so history stays readable, and the server refuses any message encrypted under
  a superseded epoch so there is no window during which the revoked device can still read.

### What this does *not* protect against

- **The past.** Rotation is forward-only: a revoked device keeps the epochs it already held,
  so anything it already saw stays readable to it. Nothing can undo that.
- **A malicious server swapping a device's public key.** A rotation wraps the new key for the
  keys the server lists. Devices are pinned on first sight (out-of-band from the QR when you
  add them yourself) and a rotation refuses to run if a pinned key changed, but a server can
  still lie about a device you have never seen. The real fix is the signed device roster that
  sender authenticity will bring.
- **Sender authenticity, replay/reorder, and metadata** (sizes, timing, device count). See
  `TODO.md`.

## Development

```bash
pnpm install
pnpm dev            # worker (wrangler dev) + web (vite) together
```

`pnpm dev` applies any pending local D1 migration before starting the Worker, so pulling a
branch that adds one can't leave you with a schema the API doesn't match. See
`apps/worker/README.md` for the one-time D1/R2 setup.

## Deploy

```bash
pnpm deploy         # migrates D1, builds the PWA, deploys the Worker (serves PWA + API)
```

Migrations run **before** the Worker goes out, so the new schema is already there when the
new code starts serving. That is the safe order as long as a migration only adds things:
the old code keeps working against a wider schema during the seconds between both steps.

A migration that removes or renames something breaks that assumption — the running Worker
would query a column that just disappeared. Split those over two deploys: add the new
shape and stop using the old one first, drop it in the next one.

`scripts/check-migrations.mts` enforces that. It inspects the migrations still pending on
the remote D1 and stops the deploy on a `DROP`, a `RENAME` or a `NOT NULL` column without
a default, pointing at the offending statement. Override with
`ALLOW_BREAKING_MIGRATIONS=1` when the downtime is deliberate.
