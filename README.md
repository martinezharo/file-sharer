# file-sharer

file-sharer is an end-to-end encrypted PWA for sharing text and files between your own devices. It is designed to feel like a private chat that works asynchronously: devices can be offline when a message is sent and catch up later.

## What it provides

- Text and files up to 50 MiB per file.
- Encrypted spaces that can be shared by multiple devices.
- Device pairing, per-device authentication, device roles, and revocation.
- Real-time delivery hints with polling as the reliable fallback.
- Optional at-rest protection for the local browser store.
- A Cloudflare Worker serving the PWA and API from one origin.

The application-level security model and its limitations are documented in [Security](docs/security.md). The project is not independently security-audited.

## Repository layout

```text
file-sharer/
├── apps/web        # Preact/Vite PWA, Web Crypto, IndexedDB, service worker
├── apps/worker     # Cloudflare Worker, API, D1, R2, cron, Durable Object
├── packages/shared # Types, DTOs, constants, and signed-statement formats
├── e2e             # Playwright browser tests
├── scripts          # Migration and end-to-end verification helpers
└── docs             # Project documentation
```

The Worker serves `/api/*` and the built PWA from the same origin. D1 stores metadata and delivery state, R2 stores encrypted file blobs, and one hibernating Durable Object per space fans out contentless sync notifications.

## Quick start

Requirements: Node.js 20 or newer and pnpm 10.33 or newer.

```bash
pnpm install
pnpm dev
```

`pnpm dev` applies local D1 migrations and starts the Worker and Vite development server. Open the URL printed by Vite. Web Crypto requires a secure context: `http://localhost` is allowed, but a development URL opened over plain HTTP on a LAN or Tailscale address is not. See [Development](docs/development.md) for HTTPS previews and test setup.

## Common checks

```bash
pnpm test           # unit and Worker integration tests
pnpm test:e2e       # Playwright against a built PWA and isolated local Worker
pnpm typecheck
pnpm lint
pnpm build          # production PWA build
```

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Security model and threat model](docs/security.md)
- [Development and testing](docs/development.md)
- [Cloudflare setup and deployment](docs/deployment.md)
- [API reference](docs/api.md)
- [Worker package notes](apps/worker/README.md)
- [Open design work](TODO.md) and [audit decisions](AUDIT.md)

## Project status

This repository is intentionally an early WIP. In particular, metadata privacy, replay/order protection, automatic local retention, closed-app notifications, and some lifecycle flows remain open design or roadmap items. Start with [TODO.md](TODO.md) and [AUDIT.md](AUDIT.md) before treating the current implementation as a finished product.
