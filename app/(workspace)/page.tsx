import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { requireCompletedOnboarding } from "@/lib/onboarding";
import { LoadError } from "@/components/workspace/load-error";
import { TodayScreen } from "@/components/workspace/today-screen";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { loadTodayView } from "@/lib/views/loaders";
import { PageTransition } from "@/components/ui/page-transition";

// Signed-out visitors never reach this page: proxy.ts rewrites "/" to the public landing page.
export default function Home() { return <Suspense fallback={<PageSkeleton label="Loading today" rows={8} />}><PageTransition><HomeContent /></PageTransition></Suspense>; }

async function HomeContent() {
  const session = await auth();
  if (!session.userId) redirect("/sign-in");
  const ctx = await ensureUserForClerk(session.userId);
  // The onboarding check and the view load run side by side instead of one after the other.
  const [, view] = await Promise.all([requireCompletedOnboarding(), loadTodayView(ctx).catch(() => null)]);
  return view ? <TodayScreen view={view} /> : <LoadError what="your agenda" />;
}
