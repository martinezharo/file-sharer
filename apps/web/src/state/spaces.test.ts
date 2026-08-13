import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spacePath, startupSpaceTarget } from "./route";

/**
 * The lifecycle of the marker that decides where the app reopens, against a
 * real IndexedDB.
 *
 * It is written in one module and cleared from three others (leaving a space,
 * standing on the list, being thrown out), so what holds it together is the
 * behaviour rather than any single call site — which is exactly what these
 * tests pin. A fresh factory and a fresh module registry per test, because both
 * the registry handle and the signals are module state.
 */

type Spaces = typeof import("./spaces");

let spaces: Spaces;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  spaces = await import("./spaces");
});

describe("the space the app reopens in", () => {
  it("is nothing at all on a device that has never opened one", async () => {
    expect(await spaces.lastOpenedSpace()).toBeUndefined();
  });

  it("is the space just created, so onboarding is not left behind on a reload", async () => {
    const created = await spaces.beginSpace("Home");

    expect(await spaces.lastOpenedSpace()).toBe(created.id);
  });

  it("follows the space that is opened", async () => {
    const first = await spaces.beginSpace("First");
    const second = await spaces.beginSpace("Second");

    expect(await spaces.openSpace(first.id)).toBe(true);

    expect(await spaces.lastOpenedSpace()).toBe(first.id);
    expect(spaces.activeSpace.value?.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
  });

  it("is left alone when a space this device does not have is asked for", async () => {
    const created = await spaces.beginSpace("Home");

    expect(await spaces.openSpace("not-a-space")).toBe(false);

    expect(await spaces.lastOpenedSpace()).toBe(created.id);
    expect(spaces.activeSpace.value?.id).toBe(created.id);
  });

  it("is forgotten on demand, which is what standing on the space list does", async () => {
    const created = await spaces.beginSpace("Home");

    await spaces.forgetLastSpace();

    expect(await spaces.lastOpenedSpace()).toBeUndefined();
    // Only the marker: the space itself is untouched and still openable.
    expect(await spaces.openSpace(created.id)).toBe(true);
  });

  it("is forgotten when that very space is left on this device", async () => {
    const created = await spaces.beginSpace("Home");

    await spaces.forgetSpace(created.id);

    expect(await spaces.lastOpenedSpace()).toBeUndefined();
    expect(spaces.activeSpace.value).toBeNull();
  });

  it("survives leaving a different space", async () => {
    const kept = await spaces.beginSpace("Kept");
    const dropped = await spaces.beginSpace("Dropped");
    await spaces.openSpace(kept.id);

    await spaces.forgetSpace(dropped.id);

    expect(await spaces.lastOpenedSpace()).toBe(kept.id);
  });

  it("does not survive closing the space view, which only unloads it", async () => {
    // Closing is the app unloading a space (a route change, a lock), not the
    // user deciding where to come back to — the list is what clears that.
    const created = await spaces.beginSpace("Home");

    spaces.closeSpace();

    expect(await spaces.lastOpenedSpace()).toBe(created.id);
    expect(spaces.activeSpace.value).toBeNull();
  });
});

/**
 * The two halves joined up: what storage remembers, fed to the rule that reads
 * it. Everything below is the state a real launch would find.
 */
describe("a launch that names no space", () => {
  const launch = async (pendingShare = false): Promise<ReturnType<typeof startupSpaceTarget>> => {
    await spaces.refreshSpaces();
    return startupSpaceTarget({
      spaceIds: spaces.spaces.value.map((space) => space.id),
      lastSpaceId: await spaces.lastOpenedSpace(),
      pendingShare,
    });
  };

  it("reopens the space the device was last in", async () => {
    const first = await spaces.beginSpace("First");
    await spaces.beginSpace("Second");
    await spaces.openSpace(first.id);

    expect(await launch()).toEqual({ path: spacePath(first.id), replace: false });
  });

  it("stays on the list once that space has been left on this device", async () => {
    const created = await spaces.beginSpace("Home");
    await spaces.forgetSpace(created.id);
    await spaces.beginSpace("Other");
    await spaces.forgetLastSpace();

    expect(await launch()).toBeUndefined();
  });

  it("stays on the list after the user steps back out to it", async () => {
    await spaces.beginSpace("Home");

    await spaces.forgetLastSpace();

    expect(await launch()).toBeUndefined();
  });

  it("takes a share into the only space even when nothing was remembered", async () => {
    const only = await spaces.beginSpace("Home");
    await spaces.forgetLastSpace();

    expect(await launch(true)).toEqual({ path: spacePath(only.id), replace: true });
  });

  it("asks where a share goes rather than reusing the remembered space", async () => {
    const first = await spaces.beginSpace("First");
    await spaces.beginSpace("Second");
    await spaces.openSpace(first.id);

    expect(await launch(true)).toBeUndefined();
  });
});
