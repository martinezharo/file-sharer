/**
 * Web Share Target handler (runs inside the service worker, see src/sw.ts).
 *
 * When the OS share sheet sends content to this app, it POSTs a
 * `multipart/form-data` body to `/share-target`. The page can't read that body
 * directly, so we intercept it here, stash the shared text + files in the
 * Cache Storage, and redirect into the app, which drains the stash on boot.
 *
 * Keep this in sync with `SHARE_CACHE` / cache keys in src/share/incoming.ts.
 */

const SHARE_CACHE = "share-target-v1";

export async function handleShareTarget(request: Request): Promise<Response> {
  try {
    const formData = await request.formData();
    const files = formData.getAll("files").filter((value): value is File => value instanceof File);
    const cache = await caches.open(SHARE_CACHE);

    const meta = {
      title: String(formData.get("title") ?? ""),
      text: String(formData.get("text") ?? ""),
      url: String(formData.get("url") ?? ""),
      fileCount: files.length,
    };
    await cache.put(
      "/__shared/meta",
      new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }),
    );

    await Promise.all(
      files.map((file, index) =>
        cache.put(
          `/__shared/file/${index}`,
          new Response(file, {
            headers: {
              "Content-Type": file.type || "application/octet-stream",
              "X-Share-Filename": encodeURIComponent(file.name || `shared-${index}`),
            },
          }),
        ),
      ),
    );
  } catch {
    // Even if stashing fails, fall through and open the app rather than
    // surfacing a raw error page to the user.
  }

  // 303 turns the POST into a GET navigation to the app.
  return Response.redirect("/?share-target=1", 303);
}
