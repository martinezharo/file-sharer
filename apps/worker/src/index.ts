import { runCleanup } from "./cron";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { Router } from "./router";
import { listDevices, publishSigningKey, revokeDevice, updateDeviceRole } from "./routes/devices";
import { downloadFile, uploadFile } from "./routes/files";
import { createGroup } from "./routes/groups";
import { ackKey, rotateKey } from "./routes/keys";
import { ackMessage, pendingMessages, sendMessage } from "./routes/messages";
import { completePairing, deletePairing, pollPairing, requestPairing } from "./routes/pairing";
import { withSecurityHeaders } from "./security";

const router = new Router();

router.post("/api/groups", createGroup);

router.post("/api/pairing/:pairingId/request", requestPairing);
router.post("/api/pairing/:pairingId/complete", completePairing);
router.get("/api/pairing/:pairingId", pollPairing);
router.delete("/api/pairing/:pairingId", deletePairing);

router.get("/api/messages/pending", pendingMessages);
router.post("/api/messages/:id/ack", ackMessage);
router.post("/api/messages", sendMessage);

router.put("/api/files/:r2key", uploadFile);
router.get("/api/files/:r2key", downloadFile);

router.post("/api/keys/rotate", rotateKey);
router.post("/api/keys/:epoch/ack", ackKey);

router.get("/api/devices", listDevices);
router.post("/api/devices/self/signing-key", publishSigningKey);
router.delete("/api/devices/:id", revokeDevice);
router.patch("/api/devices/:id/role", updateDeviceRole);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The Worker only owns /api/*; everything else is static PWA assets.
    if (url.pathname.startsWith("/api/")) {
      try {
        const response = await router.handle(request, env, ctx);
        if (response) return withSecurityHeaders(response);
        throw new ApiError("not_found", "No such endpoint");
      } catch (err) {
        if (err instanceof ApiError) return withSecurityHeaders(err.toResponse());
        console.error("Unhandled error:", err);
        return withSecurityHeaders(new ApiError("internal", "Internal server error").toResponse());
      }
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCleanup(env));
  },
} satisfies ExportedHandler<Env>;
