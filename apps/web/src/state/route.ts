/**
 * Where the app is, as a URL.
 *
 * Three places exist, and each one is addressable so it can be bookmarked,
 * reloaded and shared between the tabs of the same device:
 *
 *  - `/` — the public marketing page, prerendered for crawlers;
 *  - `/app` — the spaces on this device;
 *  - `/app/<id>` — one space's messages, the id being local to this device;
 *  - `/app/<id>/devices` — that space's devices.
 *
 * A space's sections are routes rather than local state so that stepping into
 * one is a real navigation: the browser's Back button (and Android's) walks
 * back out of it instead of leaving the space altogether.
 *
 * The id in the URL is a random local id, deliberately unrelated to the
 * space's id on the server: a URL that leaks (a screenshot, a shared tab, a
 * synced browser history) then says nothing about the space it names, and
 * cannot be used to reach it from anywhere else.
 */

import { signal } from "@preact/signals";

/** The sections of an open space. Messages are what a space is, so they are its root. */
export type SpaceSection = "chat" | "devices";

export type Route =
  | { name: "landing" }
  | { name: "spaces" }
  | { name: "space"; spaceId: string; section: SpaceSection };

export const APP_PATH = "/app";

export function spacePath(spaceId: string, section: SpaceSection = "chat"): string {
  const base = `${APP_PATH}/${encodeURIComponent(spaceId)}`;
  return section === "chat" ? base : `${base}/${section}`;
}

function parse(pathname: string): Route {
  if (pathname !== APP_PATH && !pathname.startsWith(`${APP_PATH}/`)) return { name: "landing" };
  const rest = pathname.slice(APP_PATH.length).replace(/^\/+|\/+$/g, "");
  if (!rest) return { name: "spaces" };
  // The id is encoded, so the only separator left in the path is the section's.
  const [id = "", section = ""] = rest.split("/");
  return {
    name: "space",
    spaceId: decodeURIComponent(id),
    // An unknown section is a mistyped or outdated URL; the space's root is the
    // honest place to land rather than a dead end.
    section: section === "devices" ? "devices" : "chat",
  };
}

export const route = signal<Route>(
  typeof location === "undefined" ? { name: "landing" } : parse(location.pathname),
);

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (typeof history !== "undefined") {
    if (options.replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
  }
  route.value = parse(path.split(/[?#]/)[0] ?? "/");
}

/**
 * Move to another section of the space that is already open.
 *
 * It replaces the current entry: this is the app putting the user where the
 * content they asked for lands (a drop, a share), not the user navigating, so
 * it must not leave a step for Back to undo.
 */
export function showSpaceSection(section: SpaceSection): void {
  const current = route.value;
  if (current.name !== "space" || current.section === section) return;
  navigate(spacePath(current.spaceId, section), { replace: true });
}

/**
 * Follow a link inside the app without a full page load, while leaving the
 * anchor a real one: middle-click, ctrl/cmd-click and "open in new tab" keep
 * working, and the href is what a crawler (or a JS-less client) sees.
 */
export function followLink(event: MouseEvent, path: string): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    route.value = parse(location.pathname);
  });
}
