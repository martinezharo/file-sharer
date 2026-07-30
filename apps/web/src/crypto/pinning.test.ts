import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../db/store", () => ({
  META_DEVICE_PINS: "devicePins",
  metaGet: async (key: string) => store.get(key),
  metaSet: async (key: string, value: unknown) => {
    store.set(key, value);
  },
}));

import { pinDeviceKey, reconcileDeviceKeys } from "./pinning";

describe("device key pinning", () => {
  beforeEach(() => store.clear());

  it("adopts keys it has never seen", async () => {
    const { changed } = await reconcileDeviceKeys([{ id: "phone", publicKey: "key-1" }]);

    expect(changed).toEqual([]);
    expect(store.get("devicePins")).toEqual({ phone: "key-1" });
  });

  it("reports a key that changed underneath us", async () => {
    await pinDeviceKey("phone", "key-1");

    const { changed } = await reconcileDeviceKeys([{ id: "phone", publicKey: "swapped" }]);

    // This is what stops a rotation from wrapping the new GroupKey for whoever
    // swapped the key.
    expect(changed).toEqual(["phone"]);
  });

  it("keeps a pin that still matches", async () => {
    await pinDeviceKey("phone", "key-1");

    const { changed } = await reconcileDeviceKeys([
      { id: "phone", publicKey: "key-1" },
      { id: "laptop", publicKey: "key-2" },
    ]);

    expect(changed).toEqual([]);
    expect(store.get("devicePins")).toEqual({ phone: "key-1", laptop: "key-2" });
  });

  it("forgets devices that left, so a re-paired id is not a false alarm", async () => {
    await pinDeviceKey("phone", "key-1");

    await reconcileDeviceKeys([{ id: "laptop", publicKey: "key-2" }]);

    expect(store.get("devicePins")).toEqual({ laptop: "key-2" });
  });
});
