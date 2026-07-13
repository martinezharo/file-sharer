/**
 * Page-side glue for the Background Sync API (Chromium; no-op elsewhere).
 *
 * Registering `OUTBOX_SYNC_TAG` asks the browser to wake the service worker —
 * even after every tab/PWA window is closed — as soon as it is online, where
 * sw.ts runs the same outbox flush as the page. On browsers without the API
 * (Safari/Firefox) sends still go out through the page's poll loop, but only
 * while the app stays open.
 */

import { OUTBOX_FLUSH_MESSAGE, OUTBOX_SYNC_TAG } from "./outbox";

// Background Sync is not in the standard TS DOM lib yet.
interface SyncManager {
  register(tag: string): Promise<void>;
}

type SyncCapableRegistration = ServiceWorkerRegistration & { sync?: SyncManager };

/** Whether this browser can finish uploads after the app is closed. */
export function backgroundSyncSupported(): boolean {
  return "serviceWorker" in navigator && "SyncManager" in window;
}

/**
 * Ask the browser to run a background outbox flush. Returns false when the
 * API is unavailable, the SW is not (yet) registered — e.g. `pnpm dev`, where
 * the PWA plugin disables it — or registration is denied (permissions).
 */
export async function requestBackgroundSync(): Promise<boolean> {
  try {
    if (!("serviceWorker" in navigator)) return false;
    const registration = (await navigator.serviceWorker.getRegistration()) as
      | SyncCapableRegistration
      | undefined;
    if (!registration?.sync) return false;
    await registration.sync.register(OUTBOX_SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand the outbox directly to the active service worker before the page is
 * frozen. Unlike Background Sync this path is available on Safari/iOS too;
 * the worker keeps its message event alive while it drains what it can.
 */
export function requestImmediateWorkerFlush(): boolean {
  try {
    const worker = navigator.serviceWorker?.controller;
    if (!worker) return false;
    worker.postMessage({ type: OUTBOX_FLUSH_MESSAGE });
    return true;
  } catch {
    return false;
  }
}
