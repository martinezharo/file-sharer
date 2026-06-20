import {
  type AckResponse,
  type ApiErrorBody,
  type CreateGroupRequest,
  type CreateGroupResponse,
  DEVICE_ID_HEADER,
  type DevicesListResponse,
  type PairingCompleteBody,
  type PairingPollResponse,
  type PairingRequestBody,
  type PendingMessagesResponse,
  type SendMessageRequest,
} from "@file-sharer/shared";

const BASE = "/api";

/** Auth material attached to authenticated requests. */
export interface Auth {
  token: string;
  deviceId: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

interface RequestOptions {
  auth?: Auth;
  jsonBody?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  retries?: number;
}

async function rawRequest(method: string, path: string, opts: RequestOptions): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.auth) {
    headers.set("Authorization", `Bearer ${opts.auth.token}`);
    headers.set(DEVICE_ID_HEADER, opts.auth.deviceId);
  }

  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  } else if (opts.jsonBody !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(opts.jsonBody);
  }

  const maxAttempts = (opts.retries ?? 2) + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`${BASE}${path}`, { method, headers, body });
      // Retry transient server errors with backoff.
      if (response.status >= 500 && attempt < maxAttempts - 1) {
        await delay(250 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        throw await toApiError(response);
      }
      return response;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Network failure: back off and retry.
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await delay(250 * 2 ** attempt);
        continue;
      }
    }
  }
  throw new NetworkError(
    lastError instanceof Error ? lastError.message : "Network request failed",
  );
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "internal";
  let message = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.error) {
      code = body.error.code;
      message = body.error.message;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(response.status, code, message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonRequest<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
  const response = await rawRequest(method, path, opts);
  return (await response.json()) as T;
}

// --- API surface ---------------------------------------------------------

export const api = {
  createGroup(body: CreateGroupRequest): Promise<CreateGroupResponse> {
    return jsonRequest("POST", "/groups", { jsonBody: body });
  },

  pairingRequest(pairingId: string, body: PairingRequestBody): Promise<void> {
    return jsonRequest("POST", `/pairing/${pairingId}/request`, { jsonBody: body });
  },

  pairingComplete(pairingId: string, body: PairingCompleteBody, auth: Auth): Promise<void> {
    return jsonRequest("POST", `/pairing/${pairingId}/complete`, { jsonBody: body, auth });
  },

  pairingPoll(pairingId: string): Promise<PairingPollResponse> {
    return jsonRequest("GET", `/pairing/${pairingId}`, { retries: 0 });
  },

  sendMessage(body: SendMessageRequest, auth: Auth): Promise<void> {
    return jsonRequest("POST", "/messages", { jsonBody: body, auth });
  },

  pendingMessages(auth: Auth, since = 0): Promise<PendingMessagesResponse> {
    return jsonRequest("GET", `/messages/pending?since=${since}`, { auth, retries: 0 });
  },

  ackMessage(id: string, auth: Auth): Promise<AckResponse> {
    return jsonRequest("POST", `/messages/${id}/ack`, { auth });
  },

  async uploadFile(r2Key: string, ciphertext: ArrayBuffer, auth: Auth): Promise<void> {
    await rawRequest("PUT", `/files/${r2Key}`, { rawBody: ciphertext, auth });
  },

  async downloadFile(r2Key: string, auth: Auth): Promise<ArrayBuffer> {
    const response = await rawRequest("GET", `/files/${r2Key}`, { auth, retries: 1 });
    return response.arrayBuffer();
  },

  listDevices(auth: Auth): Promise<DevicesListResponse> {
    return jsonRequest("GET", "/devices", { auth, retries: 1 });
  },

  revokeDevice(id: string, auth: Auth): Promise<void> {
    return jsonRequest("DELETE", `/devices/${id}`, { auth });
  },
};
