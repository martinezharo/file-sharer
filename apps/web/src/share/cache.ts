/** Cache Storage protocol shared by the page and the Web Share Target worker. */
export const SHARE_CACHE = "share-target-v1";
export const SHARE_META_KEY = "/__shared/meta";
export const MAX_SHARED_FILES = 100;

export function sharedFileKey(index: number): string {
  return `/__shared/file/${index}`;
}

/** Remove the whole dedicated stash, including files left by an interrupted share. */
export async function clearSharedCache(cache: Cache): Promise<void> {
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => new URL(request.url).pathname.startsWith("/__shared/"))
      .map((request) => cache.delete(request)),
  );
}

export interface SharedMeta {
  title: string;
  text: string;
  url: string;
  fileCount: number;
}
