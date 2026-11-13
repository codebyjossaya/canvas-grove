import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { requireCompletedOnboarding } from "@/lib/onboarding";
import { LoadError } from "@/components/workspace/load-error";
import { PlannerScreen } from "@/components/workspace/planner-screen";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { loadPlannerView } from "@/lib/views/loaders";
import { PageTransition } from "@/components/ui/page-transition";

type Params = { week?: string; view?: string };

export default function PlannerPage({ searchParams }: { searchParams: Promise<Params> }) {
  return <Suspense fallback={<PageSkeleton label="Loading planner" />}><PageTransition><ProtectedPlanner searchParams={searchParams} /></PageTransition></Suspense>;
}

async function ProtectedPlanner({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await auth(); if (!session.userId) redirect("/sign-in");
  const ctx = await ensureUserForClerk(session.userId);
  const [, view] = await Promise.all([requireCompletedOnboarding(), searchParams.then(params => loadPlannerView(ctx, params)).catch(() => null)]);
  return view ? <PlannerScreen view={view} /> : <LoadError what="your planner" />;
}
