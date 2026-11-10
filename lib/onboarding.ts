import "server-only";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { eq, sql } from "drizzle-orm";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { withTenantTransaction } from "@/lib/db";
import { userPreferences } from "@/lib/db/schema";

export const ORIENTATION_VERSION = "2026-11-v1";

export async function onboardingForClerk(clerkUserId: string) {
  const ctx = await ensureUserForClerk(clerkUserId);
  const [row] = await withTenantTransaction(ctx.ownerId, (tx) => tx.select({ version: userPreferences.orientationVersion, completedAt: userPreferences.orientationCompletedAt }).from(userPreferences).where(eq(userPreferences.ownerId, ctx.ownerId)).limit(1));
  const completed = row?.version === ORIENTATION_VERSION && Boolean(row.completedAt);
  return { ctx, completed, orientationVersion: ORIENTATION_VERSION, completedAt: completed ? row.completedAt : null };
}

export async function completeOnboardingForClerk(clerkUserId: string) {
  const ctx = await ensureUserForClerk(clerkUserId); const now = new Date(); const nowIso = now.toISOString();
  const [row] = await withTenantTransaction(ctx.ownerId, (tx) => tx.insert(userPreferences).values({ ownerId: ctx.ownerId, orientationVersion: ORIENTATION_VERSION, orientationCompletedAt: now })
    .onConflictDoUpdate({ target: userPreferences.ownerId, set: {
      orientationVersion: ORIENTATION_VERSION,
      orientationCompletedAt: sql`case when ${userPreferences.orientationVersion} = ${ORIENTATION_VERSION} and ${userPreferences.orientationCompletedAt} is not null then ${userPreferences.orientationCompletedAt} else ${nowIso}::timestamptz end`,
      updatedAt: sql`case when ${userPreferences.orientationVersion} = ${ORIENTATION_VERSION} and ${userPreferences.orientationCompletedAt} is not null then ${userPreferences.updatedAt} else ${nowIso}::timestamptz end`,
    } }).returning({ version: userPreferences.orientationVersion, completedAt: userPreferences.orientationCompletedAt }));
  return { completed: true, orientationVersion: ORIENTATION_VERSION, completedAt: row.completedAt! };
}

export async function requireCompletedOnboarding() {
  await connection();
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) redirect("/sign-in");
  const state = await onboardingForClerk(session.userId);
  if (!state.completed) redirect("/welcome");
  return state.ctx;
}
