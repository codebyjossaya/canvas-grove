import "server-only";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { connection } from "next/server";
import { cache } from "react";
import { db } from "./index";
import { users } from "./schema";

export type AuthContext = Readonly<{ ownerId: string; clerkUserId: string }>;

/** lastSeenAt is a coarse activity signal; refreshing it on every request was a write per render. */
const LAST_SEEN_REFRESH_MS = 5 * 60_000;

/**
 * Idempotently provisions the local tenant for a verified Clerk subject.
 * Memoized per request (layout + page + loaders share one lookup) and read-first, so the common
 * path is a single indexed SELECT with no write.
 */
export const ensureUserForClerk = cache(async (clerkUserId: string): Promise<AuthContext> => {
  if (!clerkUserId) throw new Error("UNAUTHENTICATED");
  // Request-time work: tells Next (cacheComponents) not to prerender past this point, so the
  // clock reads below are legitimate instead of "unstable value `new Date()`" errors.
  await connection();
  const now = new Date();
  const [existing] = await db.select({ id: users.id, status: users.status, lastSeenAt: users.lastSeenAt })
    .from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
  let user: { id: string; status: string } | undefined = existing;
  if (!existing) {
    [user] = await db.insert(users).values({ clerkUserId, lastSeenAt: now })
      .onConflictDoUpdate({ target: users.clerkUserId, set: { lastSeenAt: now, updatedAt: now } })
      .returning({ id: users.id, status: users.status });
  } else if (!existing.lastSeenAt || now.getTime() - existing.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
    // Fire-and-forget: the activity stamp must never slow down or fail a page render.
    void db.update(users).set({ lastSeenAt: now, updatedAt: now }).where(eq(users.id, existing.id)).catch(() => undefined);
  }
  if (!user || user.status !== "active") throw new Error("USER_DISABLED");
  return { ownerId: user.id, clerkUserId };
});

export async function requireAuthContext(): Promise<AuthContext> {
  const { userId } = await auth();
  if (!userId) throw new Error("UNAUTHENTICATED");

  return ensureUserForClerk(userId);
}
