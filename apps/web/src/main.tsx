import { render } from "preact";
import { registerSW } from "virtual:pwa-register";
import { resumeLinking } from "./actions";
import { consumeSharedContent } from "./share/incoming";
import { loadMessages } from "./state/messages";
import { loadSession, session } from "./state/session";
import { startSync } from "./sync/sync";
import { App } from "./ui/App";
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

async function bootstrap(): Promise<void> {
  await loadSession();
  if (session.value) {
    await loadMessages();
    startSync();
  } else {
    await resumeLinking();
  }
  await consumeSharedContent();
}

registerServiceWorker();

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}

void bootstrap();
