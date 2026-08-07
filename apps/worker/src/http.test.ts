import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import {
  optionalString,
  readJson,
  readJsonObject,
  requireId,
  requireInt,
  requireSha256Hex,
  requireString,
} from "./http";

/** Assert `fn` throws an ApiError carrying `code`. */
async function rejectsWith(fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    return;
  }
  throw new Error(`expected an ApiError(${code}), nothing was thrown`);
}

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://x.dev/api/thing", { method: "POST", body, headers });
}

describe("readJson", () => {
  it("parses a valid body", async () => {
    expect(await readJson(jsonRequest(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
  });

  it("rejects invalid JSON as bad_request", async () => {
    await rejectsWith(() => readJson(jsonRequest("{not json")), "bad_request");
  });

  it("rejects an oversized body from its Content-Length, before parsing it", async () => {
    // The point of the header check: this must fail without the body ever
    // being read, so a hostile client cannot make us buffer megabytes first.
    const request = jsonRequest("{}", { "content-length": String(3 * 1024 * 1024) });

    await rejectsWith(() => readJson(request), "payload_too_large");
    expect(request.bodyUsed).toBe(false);
  });

  it("accepts a body at the limit", async () => {
    const request = jsonRequest(JSON.stringify({ a: 1 }), {
      "content-length": String(2 * 1024 * 1024),
    });

    expect(await readJson(request)).toEqual({ a: 1 });
  });

  it("rejects a streaming body that exceeds the limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const request = new Request("https://x.dev/api/thing", {
      method: "POST",
      body: stream,
      // @ts-expect-error - required by undici for a streaming body
      duplex: "half",
    });

    await rejectsWith(() => readJson(request), "payload_too_large");
  });
});

describe("readJsonObject", () => {
  it.each(["null", "[]", '"text"', "42"])("rejects JSON %s", async (body) => {
    await rejectsWith(() => readJsonObject(jsonRequest(body)), "bad_request");
  });

  it("accepts an object", async () => {
    expect(await readJsonObject<{ a: number }>(jsonRequest('{"a":1}'))).toEqual({ a: 1 });
  });
});

describe("requireString", () => {
  it("accepts a non-empty string within the bound", () => {
    expect(requireString("hello", "field")).toBe("hello");
  });

  it.each([
    ["empty", ""],
    ["number", 42],
    ["null", null],
    ["undefined", undefined],
    ["object", {}],
  ])("rejects %s", async (_label, value) => {
    await rejectsWith(() => requireString(value, "field"), "bad_request");
  });

  it("rejects a value past maxLen", async () => {
    await rejectsWith(() => requireString("abcd", "field", 3), "bad_request");
  });

  it("names the offending field in the message", () => {
    expect(() => requireString(undefined, "encryptedName")).toThrow(/encryptedName/);
  });
});

describe("optionalString", () => {
  it("returns undefined for absent values", () => {
    expect(optionalString(undefined, "field")).toBeUndefined();
    expect(optionalString(null, "field")).toBeUndefined();
  });

  it("still validates a value that is present", async () => {
    await rejectsWith(() => optionalString("", "field"), "bad_request");
    await rejectsWith(() => optionalString(7, "field"), "bad_request");
  });
});

describe("requireSha256Hex", () => {
  const digest = "a".repeat(64);

  it("accepts 64 lowercase hex chars", () => {
    expect(requireSha256Hex(digest, "hash")).toBe(digest);
  });

  it.each([
    ["uppercase", "A".repeat(64)],
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["non-hex", `${"a".repeat(63)}z`],
  ])("rejects %s", async (_label, value) => {
    await rejectsWith(() => requireSha256Hex(value, "hash"), "bad_request");
  });
});

describe("requireInt", () => {
  it("accepts an integer inside the range", () => {
    expect(requireInt(5, "epoch", 1, 10)).toBe(5);
    expect(requireInt(1, "epoch", 1, 10)).toBe(1);
    expect(requireInt(10, "epoch", 1, 10)).toBe(10);
  });

  it.each([
    ["below the range", 0],
    ["above the range", 11],
    ["a float", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "5"],
  ])("rejects %s", async (_label, value) => {
    await rejectsWith(() => requireInt(value, "epoch", 1, 10), "bad_request");
  });
});

describe("requireId", () => {
  it("accepts base64url-shaped ids", () => {
    expect(requireId("aB0_-xyz", "id")).toBe("aB0_-xyz");
  });

  it.each([
    ["a path traversal", "../etc/passwd"],
    ["a slash", "group/key"],
    ["a dot", "file.txt"],
    ["a space", "two words"],
    ["a percent escape", "a%2Fb"],
  ])("rejects %s, so it is always safe as a path segment or R2 key", async (_label, value) => {
    await rejectsWith(() => requireId(value, "r2key"), "bad_request");
  });

  it("rejects an id longer than 256 chars", async () => {
    await rejectsWith(() => requireId("a".repeat(257), "id"), "bad_request");
  });
});
