import { describe, expect, it } from "vitest";
import { installedAppStartPath } from "./pwa";

describe("installedAppStartPath", () => {
  it("opens an installed standalone PWA at /app instead of the landing page", () => {
    expect(
      installedAppStartPath({
        pathname: "/",
        standaloneDisplayMode: true,
        iosStandalone: false,
      }),
    ).toBe("/app");
  });

  it("recognizes the iOS Home Screen standalone mode", () => {
    expect(
      installedAppStartPath({
        pathname: "/",
        standaloneDisplayMode: false,
        iosStandalone: true,
      }),
    ).toBe("/app");
  });

  it("leaves the landing page available in a normal browser tab", () => {
    expect(
      installedAppStartPath({
        pathname: "/",
        standaloneDisplayMode: false,
        iosStandalone: false,
      }),
    ).toBeUndefined();
  });

  it("does not replace an installed app deep link", () => {
    expect(
      installedAppStartPath({
        pathname: "/app/space-id",
        standaloneDisplayMode: true,
        iosStandalone: false,
      }),
    ).toBeUndefined();
  });
});
