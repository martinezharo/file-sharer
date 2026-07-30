/**
 * Trust-on-first-use pins for the other devices' ECDH public keys.
 *
 * A key rotation wraps the new GroupKey for the public keys the *server* lists.
 * A malicious server could therefore list a key of its own and be handed the
 * new key. Signing the device roster is the real fix (it needs the per-device
 * signing keypair that authenticity work will add); until then, pinning closes
 * the practical version of the attack: a device's key is recorded the first
 * time we see it — out-of-band from the QR code when we add it ourselves — and
 * a rotation refuses to run if any key changed since. The server can lie about
 * a device we have never seen; it cannot swap one we already know.
 */

import { META_DEVICE_PINS, metaGet, metaSet } from "../db/store";

type Pins = Record<string, string>;

export interface PinCheck {
  /** Devices whose published key no longer matches the pinned one. */
  changed: string[];
}

async function pins(): Promise<Pins> {
  return (await metaGet<Pins>(META_DEVICE_PINS)) ?? {};
}

/**
 * Record a key learned from a trusted channel (a scanned QR code), overwriting
 * any previous pin: re-pairing a device legitimately gives it a new keypair.
 */
export async function pinDeviceKey(deviceId: string, publicKey: string): Promise<void> {
  await metaSet(META_DEVICE_PINS, { ...(await pins()), [deviceId]: publicKey });
}

/**
 * Compare a server-provided device roster against the pins, adopting keys we
 * have never seen and reporting the ones that changed underneath us.
 */
export async function reconcileDeviceKeys(
  devices: readonly { id: string; publicKey: string }[],
): Promise<PinCheck> {
  const known = await pins();
  const changed: string[] = [];
  const next: Pins = { ...known };

  for (const device of devices) {
    const pinned = known[device.id];
    if (pinned === undefined) {
      next[device.id] = device.publicKey;
    } else if (pinned !== device.publicKey) {
      changed.push(device.id);
    }
  }

  // Drop devices that left the space, so an id that is paired again later
  // starts fresh instead of tripping the check with its new keypair. This is
  // the seam a server could still work through (hide a device, wait for a
  // second rotation, re-list it with its own key) — closing it needs the signed
  // device roster that sender authenticity will bring.
  const active = new Set(devices.map((d) => d.id));
  for (const id of Object.keys(next)) {
    if (!active.has(id)) delete next[id];
  }

  await metaSet(META_DEVICE_PINS, next);
  return { changed };
}
