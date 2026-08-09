import { Fingerprint, KeyRound, LockKeyhole } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { lockMethod, unlockWithPasskey, unlockWithPassphrase } from "../state/lock";
import { Button, Logo, Spinner, Toasts } from "./components";

/**
 * The whole app while this device is locked. There is nothing behind it to
 * reveal: the session, the keys and every stored message are ciphertext until
 * the secret arrives, so this is not a gate in front of loaded data — it is the
 * only state the app can be in.
 */
export function LockScreen({ onUnlocked }: { onUnlocked: () => void }): JSX.Element {
  const method = lockMethod.value;
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(unlock: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await unlock();
      onUnlocked();
    } catch (err) {
      // A cancelled passkey prompt is the user changing their mind, not a failure.
      if (err instanceof DOMException && err.name === "NotAllowedError") setError(null);
      else setError(err instanceof Error ? err.message : "Could not unlock this device");
      setBusy(false);
    }
  }

  // Offer the biometric prompt straight away: on a passkey lock, tapping a
  // button only to get the platform sheet is a step with nothing in it.
  useEffect(() => {
    if (method === "passkey") void run(unlockWithPasskey);
  }, [method]);

  return (
    // min-h, not h: on a short screen (a phone in landscape, a small window)
    // `h-full` centring clipped the panel with nothing to scroll.
    <div class="bg-grad grid min-h-full place-items-center p-6">
      <div class="surface-card flex w-full max-w-[380px] flex-col items-center gap-6 rounded-xl3 p-7 text-center !shadow-float max-md:p-6">
        <Logo size="lg" />
        <div>
          <h1 class="text-title-lg tracking-[-0.02em]">This device is locked</h1>
          <p class="mt-1.5 text-note leading-relaxed text-muted">
            Your messages, files and keys are encrypted on this device until you unlock them.
          </p>
        </div>

        {method === "passkey" ? (
          <div class="flex w-full flex-col gap-2.5">
            <Button variant="primary" disabled={busy} onClick={() => void run(unlockWithPasskey)}>
              {busy ? <Spinner /> : <Fingerprint />}
              {busy ? "Waiting for confirmation…" : "Unlock"}
            </Button>
          </div>
        ) : (
          <form
            class="flex w-full flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (passphrase) void run(() => unlockWithPassphrase(passphrase));
            }}
          >
            <label class="flex flex-col gap-1.5 text-left">
              <span class="text-note font-medium text-subtle">Passphrase or PIN</span>
              <input
                type="password"
                class="field-input"
                autoFocus
                autoComplete="current-password"
                value={passphrase}
                onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
              />
            </label>
            <Button variant="primary" type="submit" disabled={busy || !passphrase}>
              {busy ? <Spinner /> : <LockKeyhole />}
              Unlock
            </Button>
          </form>
        )}

        {error && (
          <p role="alert" class="text-note leading-5 text-danger">
            {error}
          </p>
        )}

        <p class="flex items-start gap-2 text-left text-caption leading-5 text-muted">
          <KeyRound class="mt-0.5 size-3.5 flex-none" aria-hidden="true" />
          Forgot it? Nothing on the server can help — it never had the key. Link this device again
          from another one, or restore from a recovery file.
        </p>
      </div>
      <Toasts />
    </div>
  );
}
