import { registerSW } from "virtual:pwa-register";
import { render } from "preact";
import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/hanken-grotesk/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles.css";

/**
 * Register the service worker with `autoUpdate`: a new deploy is detected,
 * activated (skipWaiting + clientsClaim) and the page auto-reloads — no manual
 * cache clearing. We also re-check on an interval and whenever the app regains
 * focus so an already-open tab picks up a new version on its own.
 */
function registerServiceWorker(): void {
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      const update = (): void => void registration.update();
      setInterval(update, 60_000);
      window.addEventListener("focus", update);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") update();
      });
    },
  });
}

registerServiceWorker();

const root = document.getElementById("app");
if (root) {
  void Promise.all([import("./bootstrap"), import("./ui/App")])
    .then(async ([{ bootstrap }, { App }]) => {
      // Keep the prerendered marketing page visible while IndexedDB and the
      // session are loading. This gives crawlers useful HTML and avoids a
      // blank spinner for people arriving on the public page.
      await bootstrap();
      render(<App />, root);
    })
    .catch((error: unknown) => {
      // The static landing page remains usable if runtime bootstrapping fails.
      console.error("Could not start file-sharer", error);
    });
}
