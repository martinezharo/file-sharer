import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalMessage, Session } from "./types";

/**
 * The two moments that take the app out of a space for good, and therefore have
 * to take the "reopen here" marker with them: stepping back out to the list,
 * and being thrown out of the space by the server.
 *
 * Both are one line inside much larger functions, which is precisely why they
 * are worth pinning: nothing else would notice if either went missing, and the
 * symptom (a device that reopens into a space it cannot use, or cannot leave)
 * only shows up on the *next* launch.
 */

// The sync loop is the one thing here that reaches for a DOM (window/document
// listeners) and for the network. Neither is what these tests are about, and
// stubbing it keeps them in the plain node environment the rest of the suite
// runs in.
vi.mock("./sync/sync", () => ({
  startSync: vi.fn(),
  stopSync: vi.fn(),
  syncNow: vi.fn(async () => {}),
}));

let actions: typeof import("./actions");
let route: typeof import("./state/route");
let session: typeof import("./state/session");
let spaces: typeof import("./state/spaces");
let messagesState: typeof import("./state/messages");
let deletions: typeof import("./db/deletions");
let identity: typeof import("./crypto/identity");

const A_SESSION: Session = {
  groupId: "group",
  deviceId: "device",
  deviceName: "Phone",
  deviceAuthToken: "token",
};

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  // Imported together after the reset so every module below shares one instance
  // of the registry and of the signals.
  [actions, route, session, spaces, messagesState, deletions, identity] = await Promise.all([
    import("./actions"),
    import("./state/route"),
    import("./state/session"),
    import("./state/spaces"),
    import("./state/messages"),
    import("./db/deletions"),
    import("./crypto/identity"),
  ]);
});

describe("applyRoute", () => {
  it("forgets the space once the app is standing on the list", async () => {
    const created = await spaces.beginSpace("Home");
    route.navigate(route.spacePath(created.id));
    await actions.applyRoute();
    expect(await spaces.lastOpenedSpace()).toBe(created.id);

    route.navigate(route.APP_PATH);
    await actions.applyRoute();

    expect(await spaces.lastOpenedSpace()).toBeUndefined();
    expect(spaces.activeSpace.value).toBeNull();
  });

  it("keeps it while the app is only moving between a space's sections", async () => {
    const created = await spaces.beginSpace("Home");

    route.navigate(route.spacePath(created.id, "devices"));
    await actions.applyRoute();

    expect(await spaces.lastOpenedSpace()).toBe(created.id);
    expect(spaces.activeSpace.value?.id).toBe(created.id);
  });

  it("keeps it on the public landing page, which is not a decision about spaces", async () => {
    // Reaching the marketing page (a link, a restored tab) says nothing about
    // where the installed app should reopen.
    const created = await spaces.beginSpace("Home");

    route.navigate("/");
    await actions.applyRoute();

    expect(await spaces.lastOpenedSpace()).toBe(created.id);
  });
});

describe("handleAuthFailure", () => {
  it("forgets a space this device was thrown out of", async () => {
    const created = await spaces.beginSpace("Home");
    await spaces.openSpace(created.id);
    session.session.value = A_SESSION;

    actions.handleAuthFailure();

    expect(session.sessionRevoked.value).toBe(true);
    // The space stays on the device — the user still has to choose to leave it
    // — but the next launch lands on the list, where that choice can be made
    // and the other spaces are still reachable.
    await vi.waitFor(async () => expect(await spaces.lastOpenedSpace()).toBeUndefined());
    await spaces.refreshSpaces();
    expect(spaces.spaces.value.map((space) => space.id)).toEqual([created.id]);
  });

  it("does nothing without a session, so a stray 401 cannot wipe the marker", async () => {
    const created = await spaces.beginSpace("Home");
    session.session.value = null;

    actions.handleAuthFailure();

    expect(session.sessionRevoked.value).toBe(false);
    expect(await spaces.lastOpenedSpace()).toBe(created.id);
  });
});

/**
 * Opening a view-once message is split across two moments on purpose, and the
 * split is the whole feature: the retraction goes out when it is *opened*, so
 * no second device can still reach it, while the local copy survives until the
 * reader closes it, so the person who opened it gets to finish reading.
 */
describe("view-once messages", () => {
  const A_MESSAGE: LocalMessage = {
    id: "msg-1",
    direction: "in",
    senderDeviceId: "other-device",
    text: "secret",
    viewOnce: true,
    createdAt: 1,
    status: "sent",
  };

  beforeEach(async () => {
    // The message store is per space, so one has to be open to write into it.
    await spaces.beginSpace("Home");
    session.session.value = A_SESSION;
    identity.knownDeviceIds.value = ["device", "other-device"];
    await messagesState.upsertMessage(A_MESSAGE);
  });

  it("retracts from the other devices on open, and keeps the copy being read", async () => {
    await actions.consumeViewOnce(A_MESSAGE);

    // The tombstone is queued for delivery...
    const tombstone = messagesState.messages.value.find((m) => m.deletes === A_MESSAGE.id);
    expect(tombstone).toMatchObject({ direction: "out", status: "queued" });
    // ...and the id is remembered, so a copy still in flight is dropped on
    // arrival instead of quietly coming back.
    expect(await deletions.loadDeletions()).toHaveProperty(A_MESSAGE.id);
    // But what is being read is still here.
    expect(messagesState.getLocalMessage(A_MESSAGE.id)).toBeDefined();
  });

  it("erases the local copy when the reader closes it", async () => {
    await actions.consumeViewOnce(A_MESSAGE);
    await actions.releaseViewOnce(A_MESSAGE);

    expect(messagesState.getLocalMessage(A_MESSAGE.id)).toBeUndefined();
  });

  it("records the deletion but sends no tombstone when there is nobody to tell", async () => {
    identity.knownDeviceIds.value = ["device"];

    await actions.consumeViewOnce(A_MESSAGE);

    expect(messagesState.messages.value.some((m) => m.deletes)).toBe(false);
    expect(await deletions.loadDeletions()).toHaveProperty(A_MESSAGE.id);
  });

  it("ignores a message that is not view-once, whatever calls it", async () => {
    const ordinary: LocalMessage = { ...A_MESSAGE, id: "msg-2", viewOnce: undefined };
    await messagesState.upsertMessage(ordinary);

    await actions.consumeViewOnce(ordinary);

    expect(messagesState.messages.value.some((m) => m.deletes)).toBe(false);
    expect(messagesState.getLocalMessage("msg-2")).toBeDefined();
  });
});
