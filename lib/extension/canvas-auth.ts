import "server-only";
import { BridgeError } from "@/lib/bridge/errors";
import { completeExtensionAuthenticationTx } from "@/lib/bridge/complete-authentication";
import { hostedSessionStore, publicHostedSession } from "@/lib/bridge/hosted-browser";
import { envelopeEncryptBrowserState } from "@/lib/bridge/providers/envelope";
import { withTenantSql } from "@/lib/db";
import { CanvasSessionClient } from "@/lib/canvas/session-client";
import type { DeviceAuth } from "./devices";
import { canvasUserIdFromVerification, normalizeCapturedCookies } from "./canvas-auth-contract";

export async function activateCapturedCanvasSession(device: DeviceAuth, input: { sessionId?: unknown; canvasOrigin?: unknown; cookies?: unknown }) {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const canvasOrigin = typeof input.canvasOrigin === "string" ? input.canvasOrigin : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new BridgeError("CANVAS_SESSION_INVALID", "The Canvas connection attempt is invalid.", 400);
  }
  const hosted = await hostedSessionStore.getForOwner(sessionId, device.ctx.clerkUserId);
  if (!hosted || hosted.state === "terminated") throw new BridgeError("CANVAS_SESSION_NOT_FOUND", "The Canvas connection attempt was not found.", 404);
  if (!hosted.interactiveAttemptId) throw new BridgeError("CANVAS_SESSION_INVALID", "Start a new Canvas sign-in attempt.", 409);
  if (!hosted.interactiveAttemptDeadlineAt || hosted.interactiveAttemptDeadlineAt <= Date.now()) {
    throw new BridgeError("CANVAS_SESSION_EXPIRED", "This Canvas sign-in attempt expired. Start again.", 409);
  }
  if (new URL(hosted.canvasOrigin).origin !== canvasOrigin) {
    throw new BridgeError("CANVAS_COOKIE_CAPTURE_SCOPE", "The captured Canvas site does not match this connection.", 400);
  }
  const cookies = normalizeCapturedCookies(input.cookies, canvasOrigin);
  let encrypted = envelopeEncryptBrowserState({ cookies, origins: [] }, hosted.userId);
  let version = encrypted.iv;
  const client = new CanvasSessionClient({
    ownerId: hosted.userId,
    canvasOrigin,
    maxResponseBytes: 256 * 1024,
    maxTotalBytes: 512 * 1024,
    store: {
      load: async () => ({ state: encrypted, version }),
      compareAndSwap: async (next, expected) => {
        if (expected !== version) return false;
        encrypted = next;
        version = next.iv;
        return true;
      },
    },
  });
  const verified = await client.request({ method: "GET", path: "/api/v1/users/self" });
  await client.flush();
  const canvasUserId = canvasUserIdFromVerification(verified);
  const connected = await withTenantSql(hosted.userId, (tx) => completeExtensionAuthenticationTx(tx, {
    attemptId: hosted.interactiveAttemptId!, ownerId: hosted.userId, hostedSessionId: hosted.id,
    canvasOrigin: hosted.canvasOrigin, institutionName: hosted.institutionName,
  }, canvasUserId, encrypted));
  if (!connected) throw new BridgeError("CANVAS_SESSION_CHANGED", "This Canvas sign-in attempt has changed. Start again.", 409);
  const latest = await hostedSessionStore.getForOwner(hosted.id, device.ctx.clerkUserId);
  if (!latest) throw new BridgeError("CANVAS_SESSION_NOT_FOUND", "The Canvas connection was not found after verification.", 404);
  return { connected: true, session: publicHostedSession(latest) };
}
