# file-sharer

A tiny, end-to-end-encrypted PWA to share text and files (≤ 50 MB) between your **own**
devices — like a private WhatsApp group just for your phones and laptops.

- **E2E encrypted**: the server (Cloudflare) only ever sees ciphertext, public keys and hashes.
  Plaintext and the symmetric `GroupKey` never leave your devices.
- **Asynchronous**: devices don't need to be online at the same time.
- **Real-time when they are**: a Durable Object per space notifies connected devices, so a
  message lands in well under a second instead of waiting for a poll.
- **No indefinite cloud storage**: encrypted files live in R2 for at most 24 h and are deleted
  immediately once every active device confirms download.
- **100 % Cloudflare backend**: a single Worker serving the PWA + the API, backed by D1 and R2.

## Architecture

```
file-sharer/
├── packages/shared   # Shared TypeScript contract (DTOs + constants)
└── apps/
    ├── worker        # Cloudflare Worker: API + static assets + D1 + R2 + cron + Durable Object
    └── web           # PWA: Preact + Vite + Web Crypto + IndexedDB
```

The Worker serves both the API (`/api/*`) and the built PWA (Workers Static Assets) from the
same origin — one deploy, no CORS.

## Crypto model

- **GroupKey**: AES-GCM 256, created by the first device. Encrypts every message/file.
- **Device keypair**: ECDH P-256, stored as a `CryptoKey`.
- **Signing keypair**: ECDSA P-256, one per device. One key, one job: it signs messages and
  vouches for devices, never encrypts.
- **Pairing**: a new device shows its public keys (QR/text); an existing device wraps the GroupKey
  plus a newly generated device token for it using an ephemeral ECDH key (ECIES). The public keys travel
  out-of-band (you scan them), so there is no MITM.
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
- **Sender authenticity**: every message is signed with the sending device's signing key, over
  the sender id, the key epoch and every ciphertext in it. A server cannot re-attribute a
  message to another device, swap its payload, or strip the signature (a device that has
  published a signing key must sign, and its peers reject an unsigned message from it).
- **At-rest lock (optional)**: a passphrase/PIN or a passkey encrypts *everything* this device
  stores — the `GroupKey`s, the bearer token, the device keypairs, every message record and every
  cached file. The key is derived on unlock (PBKDF2-SHA256, 600k rounds, or the passkey's WebAuthn
  PRF output) and never written anywhere: while locked, IndexedDB holds only ciphertext plus the
  salt. There is no reset — the server never had the key — so a forgotten secret costs this
  device's copy and nothing else.
- **Recovery file (optional)**: an encrypted export of this device's identity and every `GroupKey`
  epoch it holds, sealed under a generated 160-bit recovery code shown once. It is the only way
  back into a space whose devices are all gone, and it restores *this* device rather than
  enrolling a new one, so nothing has to be re-authorised by a device that no longer exists. The
  device keypairs are therefore extractable: what that used to buy was narrower than it looks,
  since the `GroupKey` beside them has to be extractable to be wrapped for other devices at all.
  The at-rest lock is what actually closes that, across the whole store rather than one key.
- **Attested device roster**: the device that adds another one scans its keys out-of-band, so it
  signs them — and every other device verifies that signature instead of believing the roster the
  server serves. The space creator self-signs, a joining device inherits the introducer's verified
  view inside its (encrypted) pairing package, and from there trust extends by attestation. Keys
  already held are never silently replaced: a change stops a key rotation instead.

### Delivery

Devices hold one WebSocket to a Durable Object addressed by their space id. When a message is
sent — or a device revoked, or the key rotated — the API notifies that object, which wakes the
other devices in the space. **The socket carries no content**: the event says only "there is
something for you", and the device then runs the same authenticated sync pass polling ran, so
neither the ciphertext nor the delivery bookkeeping ever leaves D1.

Polling does not go away, it slows down (8 s → 60 s while connected). The socket is a latency
optimisation, never the delivery guarantee: a dropped notification, a frozen tab or a proxy that
killed the connection without a close frame costs a few seconds, never a message.

### Deleting for everyone

A message can be deleted from every device in the space, not just the one in front of you. Since
the server drops a message as soon as every device has downloaded it, the copies that usually
remain are the local ones — so a deletion is not an API call against stored content, it is a
signed *tombstone* delivered through the ordinary message pipeline. It therefore reaches devices
that are offline when you press the button, exactly like a message does, and the outbox retries it
until it lands.

Two things fall out of that. The server destroys the target's row and its R2 object the moment the
tombstone arrives, so a message deleted before a device ever fetched it is never delivered at all.
And the tombstone is signed over its own statement (`deleteSignatureStatement`), never the message
one, so no signature can be lifted from a message and replayed as an order to erase one; a
deletion whose signature fails against the key we hold for that device is ignored, and the user is
told.

### What this does *not* protect against

- **The past.** Rotation is forward-only: a revoked device keeps the epochs it already held,
  so anything it already saw stays readable to it. Nothing can undo that.
- **Devices that predate signing.** A device linked before sender authenticity existed publishes
  a signing key on its next launch (no re-pairing, nothing user-visible), but nobody was there to
  attest to it, so its peers adopt it on first sight — exactly as trustworthy as the pin-on-first-
  sight behaviour it replaces, no less. Such a space stops relying on it as its devices are
  re-linked. Messages from a device that never published a key show as neither verified nor
  forged, and only a signature that *fails* is surfaced in the UI.
- **The very first link of a device.** A joining device takes its introducer's word for the
  space (it has nothing else to go on yet). Closing that would need a compare-the-numbers step,
  which is a UX cost this project has not accepted.
- **Replay/reorder and metadata** (sizes, timing, device count). A signature covers *what* was
  sent, not *when* or *in what order*. See `TODO.md`.
- **A device with no lock set.** Without one, everything above is stored unencrypted on the
  device, exactly as it was before the lock existed — anyone who can open that browser profile
  reads it. Even with a lock, a message's id and timestamp stay in the clear locally, because they
  are the key path and the sort index that keep history loadable; someone reading the raw database
  learns *when* the device received something, never what.
- **A device that does not want to forget.** "Delete on all devices" is cooperative, like every
  such feature: it asks the other devices to drop their copy and they do, but a file already saved
  somewhere else, a device that never reconnects, or a modified client that ignores the tombstone
  keeps what it has. It removes content from your own devices; it is not a remote wipe.
- **Anyone holding both a recovery file and its code.** That pair is full access to the space, by
  construction. A file is also a snapshot: exported before a revocation, it opens history but
  nothing sent after the key rotated (the app flags a stale one).

## Development

```bash
pnpm install
pnpm dev            # worker (wrangler dev) + web (vite) together
```

`pnpm dev` applies any pending local D1 migration before starting the Worker, so pulling a
branch that adds one can't leave you with a schema the API doesn't match. See
`apps/worker/README.md` for the one-time D1/R2 setup.

```bash
pnpm test           # PWA (crypto, outbox, share) + Worker (API, in workerd against real D1/R2)
pnpm typecheck
pnpm lint
```

Worker tests run inside workerd with a real D1 and R2, and build the schema from the actual
migrations — see `apps/worker/README.md`.

## Deploy

```bash
pnpm run deploy     # migrates D1, builds the PWA, deploys the Worker (serves PWA + API)
```

`run` is not optional here, and neither is the directory. `pnpm deploy` is one of pnpm's own
commands (it copies a workspace package into a deploy folder), so it shadows this script and
fails with `ERR_PNPM_NOTHING_TO_DEPLOY` instead of deploying anything. And it has to be run
**from the repository root**: from `apps/worker` the same name resolves to that package's
`deploy`, which is a bare `wrangler deploy` — it would publish the Worker while skipping the
migration and the PWA build, leaving new code serving against the old schema.

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
