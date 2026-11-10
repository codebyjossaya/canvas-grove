import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { Dashboard } from "@/components/ui/dashboard";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { tenantRepository } from "@/lib/db/repository";

// Signed-out visitors never reach this page: proxy.ts rewrites "/" to the public landing page.
export default function Home() { return <Suspense fallback={<PageSkeleton label="Loading today"/>}><HomeContent/></Suspense>; }

async function HomeContent() {
  const session = await auth();
  if (!session.userId) redirect("/sign-in");
  const ctx = await ensureUserForClerk(session.userId);
  const repo = tenantRepository(ctx);
  const [assignments, announcements, courses] = await Promise.all([
    repo.listUpcomingAssignmentsWithCourse(), repo.listAnnouncements(), repo.listCourses(),
  ]);
  return <OnboardingGate><Dashboard assignments={assignments} announcements={announcements} courses={courses}/></OnboardingGate>;
}
