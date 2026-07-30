import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../db/store", () => ({
  META_GROUP_KEY: "groupKey",
  META_KEYRING: "keyring",
  metaGet: async (key: string) => store.get(key),
  metaSet: async (key: string, value: unknown) => {
    store.set(key, value);
  },
  metaDelete: async (key: string) => {
    store.delete(key);
  },
}));

import { createKeyring, currentKey, keyForEpoch, loadKeyring, withEpoch } from "./keyring";

const keyFor = (label: string): CryptoKey => ({ label }) as unknown as CryptoKey;

describe("keyring", () => {
  beforeEach(() => store.clear());

  it("keeps older epochs so history stays readable after a rotation", () => {
    const first = createKeyring(keyFor("epoch-1"), 1);
    const rotated = withEpoch(first, 2, keyFor("epoch-2"));

    expect(rotated.current).toBe(2);
    expect(currentKey(rotated)).toEqual(keyFor("epoch-2"));
    expect(keyForEpoch(rotated, 1)).toEqual(keyFor("epoch-1"));
  });

  it("never moves the current epoch backwards", () => {
    const ring = withEpoch(createKeyring(keyFor("epoch-3"), 3), 2, keyFor("epoch-2"));

    // An out-of-order delivery must not make this device start encrypting with
    // a key the space has already superseded.
    expect(ring.current).toBe(3);
    expect(keyForEpoch(ring, 2)).toEqual(keyFor("epoch-2"));
  });

  it("reports epochs it never held instead of guessing", () => {
    expect(keyForEpoch(createKeyring(keyFor("epoch-1"), 1), 7)).toBeUndefined();
  });

  it("upgrades a pre-rotation session without touching the user", async () => {
    store.set("groupKey", keyFor("legacy"));

    const ring = await loadKeyring();

    // The server defaults those spaces to epoch 1, so the two line up and the
    // device keeps working without re-pairing.
    expect(ring?.current).toBe(1);
    expect(currentKey(ring!)).toEqual(keyFor("legacy"));
    expect(store.has("groupKey")).toBe(false);
    expect(store.get("keyring")).toBe(ring);
  });

  it("returns null when there is nothing stored at all", async () => {
    expect(await loadKeyring()).toBeNull();
  });
});
