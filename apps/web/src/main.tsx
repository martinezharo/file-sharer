import { render } from "preact";
import { registerSW } from "virtual:pwa-register";
import { ensureSigningIdentity, handleAuthFailure, resumeLinking } from "./actions";
import { setAuthFailureHandler } from "./api/client";
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
  // Any authenticated request can be the one that discovers the device is no
  // longer linked; wire that up before the first one goes out.
  setAuthFailureHandler(handleAuthFailure);

  await loadSession();
  if (session.value) {
    await loadMessages();
    startSync();
    // A session created before sender authenticity grows a signing identity
    // here, silently. Not awaited: nothing in the app waits on it, and it
    // retries on the next launch if the network is down.
    void ensureSigningIdentity();
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
