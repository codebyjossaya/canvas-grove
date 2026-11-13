import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { SettingsScreen } from "@/components/workspace/settings-screen";
import { PageTransition } from "@/components/ui/page-transition";

export default function SettingsPage() { return <Suspense fallback={<PageSkeleton label="Loading settings" rows={4} />}><PageTransition><OnboardingGate><ProtectedSettings /></OnboardingGate></PageTransition></Suspense>; }
async function ProtectedSettings() { const session = await auth(); if (!session.userId) redirect("/sign-in"); return <SettingsScreen />; }
