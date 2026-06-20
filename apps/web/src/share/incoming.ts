import { sendFileMessages } from "../actions";
import { session } from "../state/session";
import { composerDraft, showToast, view } from "../state/ui";

// Keep in sync with public/share-target.sw.js.
const SHARE_CACHE = "share-target-v1";

interface ShareMeta {
  title: string;
  text: string;
  url: string;
  fileCount: number;
}

/**
 * Drain content delivered by the Web Share Target.
 *
 * The service worker (public/share-target.sw.js) stashes the shared text + files
 * in the Cache Storage and redirects to `/?share-target=1`. We pick it up here:
 * text prefills the composer for review, files are queued like a normal upload.
 */
export async function consumeSharedContent(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (!params.has("share-target")) return;

  // Drop the marker so a reload doesn't reprocess an already-consumed share.
  history.replaceState(null, "", location.pathname);

  if (!("caches" in window)) return;
  const cache = await caches.open(SHARE_CACHE);

  const meta = await readMeta(cache);
  const files = await readFiles(cache, meta.fileCount);

  // Clean up regardless of whether we can act on it below.
  await Promise.all([
    cache.delete("/__shared/meta"),
    ...Array.from({ length: meta.fileCount }, (_, i) => cache.delete(`/__shared/file/${i}`)),
  ]);

  if (!session.value) {
    showToast("Set up this space first, then share again.", "error");
    return;
  }

  view.value = "chat";

  const sharedText = joinSharedText(meta);
  if (sharedText) composerDraft.value = sharedText;

  if (files.length > 0) {
    await sendFileMessages(files);
    showToast(files.length === 1 ? "Shared file added" : `${files.length} shared files added`);
  }
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
