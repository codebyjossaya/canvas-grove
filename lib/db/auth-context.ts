import "server-only";
import { auth } from "@clerk/nextjs/server";
import { db } from "./index";
import { users } from "./schema";

export type AuthContext = Readonly<{ ownerId: string; clerkUserId: string }>;

/** Idempotently provisions the local tenant for a verified Clerk subject. */
export async function ensureUserForClerk(clerkUserId: string): Promise<AuthContext> {
  if (!clerkUserId) throw new Error("UNAUTHENTICATED");
  const [user] = await db.insert(users).values({ clerkUserId, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: users.clerkUserId, set: { lastSeenAt: new Date(), updatedAt: new Date() } })
    .returning({ id: users.id, status: users.status });
  if (user.status !== "active") throw new Error("USER_DISABLED");
  return { ownerId: user.id, clerkUserId };
}

export async function requireAuthContext(): Promise<AuthContext> {
  const { userId } = await auth();
  if (!userId) throw new Error("UNAUTHENTICATED");

  return ensureUserForClerk(userId);
}
