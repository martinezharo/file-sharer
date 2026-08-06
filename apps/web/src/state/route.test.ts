import { describe, expect, it } from "vitest";
import { APP_PATH, navigate, route, showSpaceSection, spacePath } from "./route";

/**
 * The router runs without a DOM here (no `history`), which is also the shape it
 * has during the server-side prerender of the landing page: it must resolve a
 * path without touching the browser.
 */
describe("navigate", () => {
  it("reads the landing page from the site root", () => {
    navigate("/");

    expect(route.value).toEqual({ name: "landing" });
  });

  it("reads the space list from /app, with or without a trailing slash", () => {
    navigate(APP_PATH);
    expect(route.value).toEqual({ name: "spaces" });

    navigate("/app/");
    expect(route.value).toEqual({ name: "spaces" });
  });

  it("reads a space from the segment below /app, on its chat by default", () => {
    navigate(spacePath("abc-123"));

    expect(route.value).toEqual({ name: "space", spaceId: "abc-123", section: "chat" });
  });

  it("reads a space's section from the segment below it", () => {
    navigate(spacePath("abc-123", "devices"));

    expect(route.value).toEqual({ name: "space", spaceId: "abc-123", section: "devices" });
  });

  it("falls back to the space's chat for a section it does not know", () => {
    navigate("/app/abc-123/settings");

    expect(route.value).toEqual({ name: "space", spaceId: "abc-123", section: "chat" });
  });

  it("round-trips an id whose base64url characters need escaping", () => {
    // Space ids are random base64url, so they can contain characters a URL
    // would otherwise reinterpret — including the separator of the section
    // that follows it.
    const id = "a/b+c d";

    navigate(spacePath(id, "devices"));

    expect(route.value).toEqual({ name: "space", spaceId: id, section: "devices" });
  });

  it("ignores the query and hash when deciding where it is", () => {
    navigate("/app?share-target=1");
    expect(route.value).toEqual({ name: "spaces" });

    navigate("/app/xyz?a=1#top");
    expect(route.value).toEqual({ name: "space", spaceId: "xyz", section: "chat" });
  });

  it("treats anything outside /app as the public site", () => {
    navigate("/security/");
    expect(route.value).toEqual({ name: "landing" });

    // Not a prefix match: /applications is someone else's page.
    navigate("/applications");
    expect(route.value).toEqual({ name: "landing" });
  });
});

describe("showSpaceSection", () => {
  it("switches section while staying in the same space", () => {
    navigate(spacePath("abc-123", "devices"));

    showSpaceSection("chat");

    expect(route.value).toEqual({ name: "space", spaceId: "abc-123", section: "chat" });
  });

  it("does nothing when no space is open", () => {
    navigate(APP_PATH);

    showSpaceSection("chat");

    expect(route.value).toEqual({ name: "spaces" });
  });
});
