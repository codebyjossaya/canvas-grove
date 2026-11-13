import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { PageTransition } from "@/components/ui/page-transition";
import { ApprovalsScreen } from "@/components/workspace/approvals/approvals-screen";

export const metadata = { title: "Approvals" };

export default function ApprovalsPage() { return <Suspense fallback={<PageSkeleton label="Loading approvals" rows={3} />}><PageTransition><OnboardingGate><ProtectedApprovals /></OnboardingGate></PageTransition></Suspense>; }
async function ProtectedApprovals() { const session = await auth(); if (!session.userId) redirect("/sign-in"); return <ApprovalsScreen />; }
