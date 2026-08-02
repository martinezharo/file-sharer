import { handleAuthFailure, resumeLinking, startSession } from "./actions";
import { setAuthFailureHandler } from "./api/client";
import { consumeSharedContent } from "./share/incoming";
import { loadLockState, locked } from "./state/lock";
import { loadSession, ready, session } from "./state/session";

/** Load local state before the interactive app replaces the prerendered page. */
export async function bootstrap(): Promise<void> {
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
