import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ApiError } from "./errors";
import { Router } from "./router";

function handle(router: Router, method: string, url: string): Promise<Response | null> {
  return router.handle(new Request(url, { method }), env, createExecutionContext());
}

describe("Router", () => {
  it("returns null when no route matches", async () => {
    const router = new Router();
    router.get("/api/things", () => new Response("ok"));

    expect(await handle(router, "GET", "https://x.dev/api/other")).toBeNull();
  });

  it("does not match a route of a different method", async () => {
    const router = new Router();
    router.post("/api/things", () => new Response("ok"));

    expect(await handle(router, "GET", "https://x.dev/api/things")).toBeNull();
  });

  it("does not let a longer or shorter path match a pattern", async () => {
    const router = new Router();
    router.get("/api/things/:id", () => new Response("ok"));

    expect(await handle(router, "GET", "https://x.dev/api/things")).toBeNull();
    expect(await handle(router, "GET", "https://x.dev/api/things/a/b")).toBeNull();
  });

  it("extracts and percent-decodes path params", async () => {
    const router = new Router();
    let seen: Record<string, string> = {};
    router.get("/api/groups/:groupId/devices/:deviceId", (c) => {
      seen = c.params;
      return new Response("ok");
    });

    await handle(router, "GET", "https://x.dev/api/groups/g%2F1/devices/d1");

    expect(seen).toEqual({ groupId: "g/1", deviceId: "d1" });
  });

  it("turns a malformed percent escape into a client error", async () => {
    const router = new Router();
    router.get("/api/groups/:groupId", () => new Response("ok"));

    await expect(handle(router, "GET", "https://x.dev/api/groups/%ZZ")).rejects.toMatchObject({
      code: "bad_request",
    } satisfies Partial<ApiError>);
  });

  it("ignores the query string when matching", async () => {
    const router = new Router();
    router.get("/api/messages/pending", () => new Response("ok"));

    const response = await handle(router, "GET", "https://x.dev/api/messages/pending?since=42");

    expect(response?.status).toBe(200);
  });

  it("matches the first registered route when two patterns overlap", async () => {
    // `/api/devices/self/signing-key` is registered before `/api/devices/:id`,
    // and the literal segment has to win or publishing a signing key would be
    // routed to the revoke handler with id="self".
    const router = new Router();
    router.post("/api/devices/self/signing-key", () => new Response("literal"));
    router.post("/api/devices/:id/signing-key", () => new Response("param"));

    const response = await handle(router, "POST", "https://x.dev/api/devices/self/signing-key");

    expect(await response?.text()).toBe("literal");
  });

  it("passes the parsed URL and request through to the handler", async () => {
    const router = new Router();
    router.get(
      "/api/thing",
      (c) => new Response(`${c.url.searchParams.get("q")}:${c.request.method}`),
    );

    const response = await handle(router, "GET", "https://x.dev/api/thing?q=hi");

    expect(await response?.text()).toBe("hi:GET");
  });
});
