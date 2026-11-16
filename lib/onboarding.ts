import "server-only";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { sql } from "drizzle-orm";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { withTenantSql, withTenantTransaction } from "@/lib/db";
import { userPreferences } from "@/lib/db/schema";
import { loadProfile } from "@/lib/views/loaders";
import { gatesFromRow, onboardingGatesMet, type OnboardingGates } from "@/lib/scopes/settings";

export const ORIENTATION_VERSION = "2026-11-v2";

export async function onboardingForClerk(clerkUserId: string) {
  const ctx = await ensureUserForClerk(clerkUserId);
  // Shares the request-scoped profile read with the page loaders (no extra query when they run).
  const { pref: row } = await loadProfile(ctx.ownerId);
  const completed = row?.orientationVersion === ORIENTATION_VERSION && Boolean(row.orientationCompletedAt);
  return { ctx, completed, orientationVersion: ORIENTATION_VERSION, completedAt: completed ? row!.orientationCompletedAt : null };
}

/**
 * Orientation gates from real state, all owner-scoped under forced RLS:
 * - extensionPaired: an active extension device that still has a credential (revoke clears it);
 * - scopesSaved: the user saved scope settings at least once;
 * - canvasConnected: an active, unrevoked Canvas session bound to a Canvas account;
 * - agentConnected: a live OAuth grant or an unexpired personal access token.
 */
export async function onboardingGates(ownerId: string): Promise<OnboardingGates> {
  const [row] = await withTenantSql(ownerId, (tx) => tx<{ extension_paired: boolean; scopes_saved: boolean; canvas_connected: boolean; agent_connected: boolean }[]>`select
    exists(select 1 from extension_devices where owner_id = ${ownerId} and status = 'active' and credential_hash is not null) as extension_paired,
    exists(select 1 from user_preferences where owner_id = ${ownerId} and scopes_saved_at is not null) as scopes_saved,
    exists(select 1 from hosted_browser_sessions where owner_id = ${ownerId} and status = 'active' and revoked_at is null and canvas_account_id is not null) as canvas_connected,
    (exists(select 1 from mcp_grants where owner_id = ${ownerId} and revoked_at is null)
      or exists(select 1 from mcp_tokens where owner_id = ${ownerId} and kind = 'pat' and revoked_at is null and (expires_at is null or expires_at > now()))) as agent_connected`);
  return gatesFromRow(row);
}

export class OrientationIncompleteError extends Error {
  readonly code = "ORIENTATION_INCOMPLETE";
  constructor(readonly gates: OnboardingGates) { super("Finish the required orientation steps first."); }
}

/** Completes orientation only when the required gates hold (re-checked here, never trusted from the client). */
export async function completeOnboardingForClerk(clerkUserId: string) {
  const ctx = await ensureUserForClerk(clerkUserId);
  const gates = await onboardingGates(ctx.ownerId);
  if (!onboardingGatesMet(gates)) throw new OrientationIncompleteError(gates);
  const now = new Date(); const nowIso = now.toISOString();
  const [row] = await withTenantTransaction(ctx.ownerId, (tx) => tx.insert(userPreferences).values({ ownerId: ctx.ownerId, orientationVersion: ORIENTATION_VERSION, orientationCompletedAt: now })
    .onConflictDoUpdate({ target: userPreferences.ownerId, set: {
      orientationVersion: ORIENTATION_VERSION,
      orientationCompletedAt: sql`case when ${userPreferences.orientationVersion} = ${ORIENTATION_VERSION} and ${userPreferences.orientationCompletedAt} is not null then ${userPreferences.orientationCompletedAt} else ${nowIso}::timestamptz end`,
      updatedAt: sql`case when ${userPreferences.orientationVersion} = ${ORIENTATION_VERSION} and ${userPreferences.orientationCompletedAt} is not null then ${userPreferences.updatedAt} else ${nowIso}::timestamptz end`,
    } }).returning({ version: userPreferences.orientationVersion, completedAt: userPreferences.orientationCompletedAt }));
  return { completed: true, orientationVersion: ORIENTATION_VERSION, completedAt: row.completedAt!, gates };
}

export async function requireCompletedOnboarding() {
  await connection();
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) redirect("/sign-in");
  const state = await onboardingForClerk(session.userId);
  if (!state.completed) redirect("/welcome");
  return state.ctx;
}
