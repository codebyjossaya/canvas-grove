import { auth } from "@clerk/nextjs/server";
import { completeOnboardingForClerk, onboardingForClerk, ORIENTATION_VERSION } from "@/lib/onboarding";
import { errorJson, json } from "@/lib/bridge/http";

export async function GET() {
  try {
    const session = await auth();
    if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
    const state = await onboardingForClerk(session.userId);
    return json({ completed: state.completed, orientationVersion: state.orientationVersion, completedAt: state.completedAt?.toISOString() ?? null });
  } catch {
    return errorJson(new Error("Onboarding state is temporarily unavailable"), 503);
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
    const body = await request.json().catch(() => null) as { completed?: unknown; orientationVersion?: unknown } | null;
    if (!body || body.completed !== true || (body.orientationVersion !== undefined && body.orientationVersion !== ORIENTATION_VERSION)) return errorJson(new Error("Invalid onboarding completion request"), 400);
    const state = await completeOnboardingForClerk(session.userId);
    return json({ ...state, completedAt: state.completedAt.toISOString() });
  } catch {
    return errorJson(new Error("Onboarding completion is temporarily unavailable"), 503);
  }
}
