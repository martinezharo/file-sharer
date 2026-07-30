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
pnpm db:migrate:remote
pnpm deploy         # builds the PWA and deploys the Worker (serves PWA + API)
```

Remote migrations stay a deliberate step: they run against live data, and a rollout may
need them applied before or after the Worker depending on the change.
