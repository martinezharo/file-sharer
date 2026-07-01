/**
 * Custom service worker (vite-plugin-pwa `injectManifest` strategy).
 *
 * Beyond the standard precache/SPA-fallback duties this SW owns two things:
 *  - the Web Share Target POST handler (src/sw/share-target.ts), and
 *  - Background Sync for the outbox: queued sends — file uploads in
 *    particular — are flushed here (src/sync/outbox.ts) when the browser
 *    fires the `sync` event, which happens even after the PWA was closed.
 *
 * Everything the flush needs (session, GroupKey, queued messages, cached file
 * originals) lives in IndexedDB, so the zero-knowledge invariant is unchanged:
 * encryption happens in this worker on-device; the server still only ever
 * sees ciphertext.
 */

import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { OUTBOX_SYNC_TAG, type OutboxUpdateBroadcast, flushQueuedOutbox } from "./sync/outbox";
import { handleShareTarget } from "./sw/share-target";
import type { LocalMessage } from "./types";

declare let self: ServiceWorkerGlobalScope & {
  /** Injected by vite-plugin-pwa / workbox-build at build time. */
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// Background Sync (Chromium) is not in the standard TS webworker lib.
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
  /** True on the browser's final retry attempt for this tag. */
  readonly lastChance: boolean;
}

// Take control immediately and drop stale precaches so a new deploy is fully
// live after one auto-reload (no manual cache clearing).
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA fallback for navigations; never serve the API from cache.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//],
  }),
);

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShareTarget(event.request));
  }
});

self.addEventListener("sync", ((event: SyncEvent) => {
  if (event.tag !== OUTBOX_SYNC_TAG) return;
  event.waitUntil(flushOutboxInBackground(event.lastChance));
}) as EventListener);

async function flushOutboxInBackground(lastChance: boolean): Promise<void> {
  const result = await flushQueuedOutbox((message) => void broadcastUpdate(message));
  if (result.remaining > 0 && !lastChance) {
    // Rejecting waitUntil makes the browser re-fire this sync with backoff.
    throw new Error(`Outbox not fully flushed (${result.remaining} left)`);
  }
}

/** Mirror persisted outbox updates into any open app windows (live UI). */
async function broadcastUpdate(message: LocalMessage): Promise<void> {
  const broadcast: OutboxUpdateBroadcast = { type: "outbox-message-updated", message };
  const windows = await self.clients.matchAll({ type: "window" });
  for (const client of windows) {
    client.postMessage(broadcast);
  }
}
