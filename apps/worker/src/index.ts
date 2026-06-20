import { runCleanup } from "./cron";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { Router } from "./router";
import { listDevices, revokeDevice } from "./routes/devices";
import { downloadFile, uploadFile } from "./routes/files";
import { createGroup } from "./routes/groups";
import { ackMessage, pendingMessages, sendMessage } from "./routes/messages";
import { completePairing, pollPairing, requestPairing } from "./routes/pairing";

const router = new Router();

router.post("/api/groups", createGroup);

router.post("/api/pairing/:pairingId/request", requestPairing);
router.post("/api/pairing/:pairingId/complete", completePairing);
router.get("/api/pairing/:pairingId", pollPairing);

router.get("/api/messages/pending", pendingMessages);
router.post("/api/messages/:id/ack", ackMessage);
router.post("/api/messages", sendMessage);

router.put("/api/files/:r2key", uploadFile);
router.get("/api/files/:r2key", downloadFile);

router.get("/api/devices", listDevices);
router.delete("/api/devices/:id", revokeDevice);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The Worker only owns /api/*; everything else is static PWA assets.
    if (url.pathname.startsWith("/api/")) {
      try {
        const response = await router.handle(request, env, ctx);
        if (response) return response;
        throw new ApiError("not_found", "No such endpoint");
      } catch (err) {
        if (err instanceof ApiError) return err.toResponse();
        console.error("Unhandled error:", err);
        return new ApiError("internal", "Internal server error").toResponse();
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCleanup(env));
  },
} satisfies ExportedHandler<Env>;
