/**
 * Reading what the Web Share Target delivered.
 *
 * The service worker (src/sw/share-target.ts) cannot hand the POST body to the
 * page, so it stashes the shared text + files in the Cache Storage and
 * redirects to `/app?share-target=1`. This module drains that stash; applying
 * it — prefilling the composer, queueing the files — belongs to the space that
 * receives it (see `consumeSharedContent` in actions.ts).
 *
 * Keep `SHARE_CACHE` and the cache keys in sync with src/sw/share-target.ts.
 */

const SHARE_CACHE = "share-target-v1";

interface ShareMeta {
  title: string;
  text: string;
  url: string;
  fileCount: number;
}

/** Text and files handed over by the OS share sheet. */
export interface SharedContent {
  text: string;
  files: File[];
}

/**
 * Whether this page load came from the share sheet, consuming the marker so a
 * reload does not reprocess an already-handled share.
 *
 * Separate from reading the content because the two happen at different
 * moments: the marker is in the URL the service worker redirected to and must
 * be cleared before the router reads it, while the content can only be applied
 * once a space is open to receive it.
 */
export function claimSharedContent(): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has("share-target")) return false;
  history.replaceState(null, "", location.pathname);
  return true;
}

/**
 * Drain the stash. Whatever it finds is removed from the cache, so a share is
 * delivered at most once.
 */
export async function takeSharedContent(): Promise<SharedContent> {
  if (!("caches" in window)) return { text: "", files: [] };
  const cache = await caches.open(SHARE_CACHE);

  const meta = await readMeta(cache);
  const files = await readFiles(cache, meta.fileCount);

  await Promise.all([
    cache.delete("/__shared/meta"),
    ...Array.from({ length: meta.fileCount }, (_, i) => cache.delete(`/__shared/file/${i}`)),
  ]);

  return { text: joinSharedText(meta), files };
}

async function readMeta(cache: Cache): Promise<ShareMeta> {
  const fallback: ShareMeta = { title: "", text: "", url: "", fileCount: 0 };
  const response = await cache.match("/__shared/meta");
  if (!response) return fallback;
  try {
    return { ...fallback, ...((await response.json()) as Partial<ShareMeta>) };
  } catch {
    return fallback;
  }
}

async function readFiles(cache: Cache, count: number): Promise<File[]> {
  const files: File[] = [];
  for (let i = 0; i < count; i++) {
    const response = await cache.match(`/__shared/file/${i}`);
    if (!response) continue;
    const blob = await response.blob();
    const name = decodeURIComponent(response.headers.get("X-Share-Filename") ?? `shared-${i}`);
    files.push(new File([blob], name, { type: blob.type }));
  }
  return files;
}

/** Combine title/text/url into one message, dropping empties and duplicates. */
function joinSharedText(meta: ShareMeta): string {
  const parts: string[] = [];
  for (const value of [meta.title, meta.text, meta.url]) {
    const trimmed = value.trim();
    if (trimmed && !parts.some((p) => p.includes(trimmed))) parts.push(trimmed);
  }
  return parts.join("\n");
}
