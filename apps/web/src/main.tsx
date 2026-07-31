import { render } from "preact";
import { registerSW } from "virtual:pwa-register";
import { handleAuthFailure, resumeLinking, startSession } from "./actions";
import { setAuthFailureHandler } from "./api/client";
import { consumeSharedContent } from "./share/incoming";
import { loadLockState, locked } from "./state/lock";
import { loadSession, ready, session } from "./state/session";
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

  // Before anything reads storage: a locked device has no session and no
  // readable history there on purpose, and the UI has to show the lock screen
  // rather than the landing page ("no session" would look like a fresh install).
  await loadLockState();
  if (locked.value) {
    ready.value = true;
    return;
  }

  await loadSession();
  if (session.value) {
    await startSession();
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
