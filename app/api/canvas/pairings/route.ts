import { auth } from "@clerk/nextjs/server";
import { digest, newId, pairingCode } from "@/lib/bridge/crypto";
import { errorJson, json } from "@/lib/bridge/http";
import { bridgeStore } from "@/lib/bridge/store";

export async function POST() {
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
  const code = pairingCode();
  const now = Date.now();
  const pairing = { id: newId(), userId: session.userId, codeHash: digest(code), attempts: 0, expiresAt: now + 10 * 60_000 };
  await bridgeStore.createPairing(pairing);
  return json({ pairingId: pairing.id, code, expiresAt: new Date(pairing.expiresAt).toISOString() }, 201);
}
