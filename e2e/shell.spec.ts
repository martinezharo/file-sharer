import type { Page } from "@playwright/test";
import { expect, settle, test } from "./device";

/**
 * What the app is served before its bundle has run.
 *
 * A launch paints the document the server (or, offline, the service worker)
 * hands over, and that happens long before any of the app's own code has
 * decided where it is. So the document `/app` is served has to be the app
 * already: when it was the prerendered marketing page — one document for the
 * whole site — every launch of the installed app flashed the landing page
 * first, which is the bug these tests exist to keep fixed.
 */

/** A heading that only the marketing page has. */
const MARKETING = "Your content stays yours";

/**
 * Fetch a document the way a launch would. Retried for the same reason
 * `Device.load` is: `wrangler dev` restarts under this suite, and a request
 * that lands in that one-second window says nothing about the app.
 */
async function documentAt(page: Page, path: string): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await page.request.get(new URL(path, page.url()).href);
      return await response.text();
    } catch (error) {
      last = error;
      await page.waitForTimeout(2_000);
    }
  }
  throw last;
}

test("serves the app shell, not the marketing page, at every /app URL", async ({ device }) => {
  const page = await device.launch();
  await settle(page);

  for (const path of ["/app", "/app/whatever", "/app/whatever/devices"]) {
    const document = await documentAt(page, path);

    expect(document).not.toContain(MARKETING);
    // The first paint is the app's own loading screen, so the boot finishes
    // into the same markup instead of replacing something else.
    expect(document).toContain('aria-label="loading"');
  }
});

test("precaches that same shell, so an offline launch does not flash it either", async ({
  device,
}) => {
  const page = await device.launch();
  await settle(page);

  const cachedShell = async (): Promise<string | null> =>
    page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      const response = await caches.match("/app.html", { ignoreSearch: true });
      return response ? await response.text() : null;
    });

  await expect.poll(cachedShell, { timeout: 30_000 }).not.toBeNull();
  expect(await cachedShell()).not.toContain(MARKETING);
});

test("keeps the public page prerendered for crawlers and no-JS clients", async ({ device }) => {
  const page = await device.launch();
  await settle(page);

  expect(await documentAt(page, "/")).toContain(MARKETING);
});
