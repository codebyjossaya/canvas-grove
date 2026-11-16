import { auth } from "@clerk/nextjs/server";
import { completeOnboardingForClerk, onboardingForClerk, onboardingGates, OrientationIncompleteError, ORIENTATION_VERSION } from "@/lib/onboarding";
import { errorJson, json } from "@/lib/bridge/http";

export async function GET() {
  try {
    const session = await auth();
    if (!session.isAuthenticated || !session.userId) return errorJson(new Error("Authentication required"), 401);
    const state = await onboardingForClerk(session.userId);
    const gates = await onboardingGates(state.ctx.ownerId);
    return json({ completed: state.completed, orientationVersion: state.orientationVersion, completedAt: state.completedAt?.toISOString() ?? null, gates });
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
  } catch (error) {
    if (error instanceof OrientationIncompleteError) return json({ error: error.message, code: error.code, gates: error.gates }, 409);
    return errorJson(new Error("Onboarding completion is temporarily unavailable"), 503);
  }
}
