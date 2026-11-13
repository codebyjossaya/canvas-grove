import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { CoursesScreen } from "@/components/workspace/courses-screen";
import { LoadError } from "@/components/workspace/load-error";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { loadCoursesView } from "@/lib/views/loaders";
import { PageTransition } from "@/components/ui/page-transition";

export default function CoursesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  return <Suspense fallback={<PageSkeleton label="Loading courses" rows={5} />}><PageTransition><OnboardingGate><Courses searchParams={searchParams} /></OnboardingGate></PageTransition></Suspense>;
}

async function Courses({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const session = await auth();
  if (!session.userId) redirect("/sign-in");
  const ctx = await ensureUserForClerk(session.userId);
  const view = await loadCoursesView(ctx, (await searchParams).view).catch(() => null);
  return view ? <CoursesScreen view={view} /> : <LoadError what="your courses" />;
}
