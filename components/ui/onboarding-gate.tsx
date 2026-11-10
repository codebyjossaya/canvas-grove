import type { ReactNode } from "react";
import { requireCompletedOnboarding } from "@/lib/onboarding";

export async function OnboardingGate({ children }: { children: ReactNode }) {
  await requireCompletedOnboarding();
  return children;
}
