import { afterEach, describe, expect, it } from "vitest";
import { SHARE_CACHE, SHARE_META_KEY, sharedFileKey } from "./cache";
import { takeSharedContent } from "./incoming";

class MemoryCache {
  private readonly entries = new Map<string, Response>();

  async match(request: RequestInfo): Promise<Response | undefined> {
    const key = typeof request === "string" ? request : request.url;
    const response = this.entries.get(new URL(key, "https://x.test").pathname);
    return response?.clone();
  }

  async put(request: RequestInfo, response: Response): Promise<void> {
    const key = typeof request === "string" ? request : request.url;
    this.entries.set(new URL(key, "https://x.test").pathname, response.clone());
  }

  async delete(request: RequestInfo): Promise<boolean> {
    const key = typeof request === "string" ? request : request.url;
    return this.entries.delete(new URL(key, "https://x.test").pathname);
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((key) => new Request(`https://x.test${key}`));
  }
}

const cache = new MemoryCache();
const originalCaches = globalThis.caches;
const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "caches", { value: originalCaches, configurable: true });
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
});

describe("takeSharedContent", () => {
  it("clears stale files after draining a smaller share", async () => {
    await cache.put(
      SHARE_META_KEY,
      new Response(JSON.stringify({ title: "title", text: "", url: "", fileCount: 1 })),
    );
    await cache.put(
      sharedFileKey(0),
      new Response("first", { headers: { "X-Share-Filename": "first.txt" } }),
    );
    await cache.put(sharedFileKey(1), new Response("stale"));
    Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
    Object.defineProperty(globalThis, "caches", {
      value: { open: async (name: string) => (name === SHARE_CACHE ? cache : undefined) },
      configurable: true,
    });

    const content = await takeSharedContent();

    expect(content.text).toBe("title");
    expect(content.files.map((file) => file.name)).toEqual(["first.txt"]);
    expect(await cache.keys()).toEqual([]);
  });

  it("does not iterate an untrusted file count without a bound", async () => {
    await cache.put(
      SHARE_META_KEY,
      new Response(JSON.stringify({ title: "", text: "", url: "", fileCount: 1e100 })),
    );
    Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
    Object.defineProperty(globalThis, "caches", {
      value: { open: async () => cache },
      configurable: true,
    });

    await expect(takeSharedContent()).resolves.toEqual({ text: "", files: [] });
    expect(await cache.keys()).toEqual([]);
  });
});
