import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { OnboardingGate } from "@/components/ui/onboarding-gate";

// The course workspace UI is rendered by ./layout.tsx; this page only enforces access.
export default function CoursePage() { return <Suspense fallback={null}><Gate/></Suspense>; }

async function Gate() {
  const session = await auth();
  if (!session.userId) redirect("/sign-in");
  return <OnboardingGate>{null}</OnboardingGate>;
}
