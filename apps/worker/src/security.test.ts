import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RateLimit } from "./env";
import { ApiError } from "./errors";
import { clientIp, enforceRateLimit, rateLimit, withSecurityHeaders } from "./security";

describe("withSecurityHeaders", () => {
  it("applies the full header set", () => {
    const response = withSecurityHeaders(new Response("body"));

    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=63072000");
  });

  it("keeps the CSP strict enough that an injected script cannot run", () => {
    const csp = withSecurityHeaders(new Response()).headers.get("Content-Security-Policy") ?? "";

    // An XSS defeats the entire E2E model, so these are load-bearing.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("font-src 'self' data:");
  });

  it("preserves the status, body and pre-existing headers", async () => {
    const original = new Response("payload", {
      status: 201,
      statusText: "Created",
      headers: { "Content-Type": "text/plain", "X-Custom": "kept" },
    });

    const response = withSecurityHeaders(original);

    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("X-Custom")).toBe("kept");
    expect(await response.text()).toBe("payload");
  });

  it("overrides a header the upstream response set for itself", () => {
    const original = new Response("", { headers: { "X-Frame-Options": "ALLOWALL" } });

    expect(withSecurityHeaders(original).headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("marks error responses as non-indexable", () => {
    expect(
      withSecurityHeaders(new Response(null, { status: 404 })).headers.get("X-Robots-Tag"),
    ).toBe("noindex, nofollow");
  });

  it("can mark a successful response as non-indexable on a preview host", () => {
    expect(
      withSecurityHeaders(new Response("preview"), { noIndex: true }).headers.get("X-Robots-Tag"),
    ).toBe("noindex, nofollow");
  });
});

describe("clientIp", () => {
  it("reads CF-Connecting-IP", () => {
    const request = new Request("https://x.dev/", {
      headers: { "CF-Connecting-IP": "203.0.113.7" },
    });

    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("falls back to a constant when the header is absent", () => {
    expect(clientIp(new Request("https://x.dev/"))).toBe("unknown");
  });
});

describe("enforceRateLimit", () => {
  it("passes the key through to the binding", async () => {
    const keys: string[] = [];
    const limiter: RateLimit = {
      async limit({ key }) {
        keys.push(key);
        return { success: true };
      },
    };

    await enforceRateLimit(limiter, "device-1");

    expect(keys).toEqual(["device-1"]);
  });

  it("throws rate_limited when the binding refuses", async () => {
    const limiter: RateLimit = { limit: async () => ({ success: false }) };

    await expect(enforceRateLimit(limiter, "device-1")).rejects.toThrow(ApiError);
    await expect(enforceRateLimit(limiter, "device-1")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("is a no-op when the binding is not provisioned", async () => {
    // Local dev and the test environment have no edge rate limiter; the API
    // must stay usable rather than failing closed on every request.
    await expect(enforceRateLimit(undefined, "device-1")).resolves.toBeUndefined();
    await expect(rateLimit(env, "RL_WRITE", "device-1")).resolves.toBeUndefined();
  });
});
