import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalMessage, Session } from "../types";

const state = vi.hoisted(() => ({
  messages: new Map<string, LocalMessage>(),
  files: new Map<string, Blob>(),
  session: {
    groupId: "group",
    deviceId: "device",
    deviceName: "Phone",
    groupAuthToken: "token",
  } satisfies Session,
  key: {} as CryptoKey,
  uploadFile: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../db/store", () => ({
  META_GROUP_KEY: "groupKey",
  META_SESSION: "session",
  allMessages: async () => [...state.messages.values()],
  getFile: async (key: string) => state.files.get(key),
  getMessage: async (id: string) => state.messages.get(id),
  metaGet: async (key: string) => (key === "session" ? state.session : state.key),
  putMessage: async (message: LocalMessage) => {
    state.messages.set(message.id, message);
  },
}));

vi.mock("../crypto/crypto", () => ({
  bufToBase64Url: () => "pinned-iv",
  encryptFile: async () => ({ ciphertext: new ArrayBuffer(16), iv: "pinned-iv" }),
  encryptJson: async () => ({ ciphertext: "encrypted-meta", iv: "meta-iv" }),
  encryptText: async () => ({ ciphertext: "encrypted-text", iv: "text-iv" }),
  randomBytes: () => new Uint8Array(12),
}));

vi.mock("../api/client", () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  class NetworkError extends Error {}
  return {
    ApiError,
    NetworkError,
    api: {
      uploadFile: state.uploadFile,
      sendMessage: state.sendMessage,
    },
  };
});

import { flushQueuedOutbox } from "./outbox";

function queuedFile(id: string, createdAt: number): LocalMessage {
  return {
    id,
    direction: "out",
    senderDeviceId: "device",
    file: {
      r2Key: `file-${id}`,
      iv: "",
      name: `${id}.bin`,
      size: 4,
      mime: "application/octet-stream",
    },
    createdAt,
    status: "queued",
    fileState: "downloaded",
  };
}

function addFiles(count: number): LocalMessage[] {
  const messages = Array.from({ length: count }, (_, index) =>
    queuedFile(`message-${index + 1}`, index),
  );
  for (const message of messages) {
    state.messages.set(message.id, message);
    state.files.set(message.file!.r2Key, new Blob(["data"]));
  }
  return messages;
}

describe("outbox batch handoff", () => {
  beforeEach(() => {
    state.messages.clear();
    state.files.clear();
    state.uploadFile.mockReset().mockResolvedValue(undefined);
    state.sendMessage.mockReset().mockResolvedValue(undefined);
  });

  it("processes only one file in a bounded worker pass and reports the rest", async () => {
    const messages = addFiles(3);

    const result = await flushQueuedOutbox(undefined, { maxMessages: 1 });

    expect(result).toEqual({ sent: 1, failed: 0, remaining: 2 });
    expect(state.uploadFile).toHaveBeenCalledTimes(1);
    expect(state.messages.get(messages[0]!.id)?.status).toBe("sent");
    expect(state.messages.get(messages[1]!.id)?.status).toBe("queued");
    expect(state.messages.get(messages[2]!.id)?.status).toBe("queued");
  });

  it("re-queues the interrupted file and does not start the next one", async () => {
    const messages = addFiles(2);
    const controller = new AbortController();
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    state.uploadFile.mockImplementation(
      (_key: string, _body: ArrayBuffer, _auth: unknown, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          uploadStarted();
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const flushing = flushQueuedOutbox(undefined, { signal: controller.signal });
    await started;
    controller.abort();
    const result = await flushing;

    expect(result).toEqual({ sent: 0, failed: 0, remaining: 2 });
    expect(state.uploadFile).toHaveBeenCalledTimes(1);
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(state.messages.get(messages[0]!.id)?.status).toBe("queued");
    expect(state.messages.get(messages[1]!.id)?.status).toBe("queued");
  });
});
