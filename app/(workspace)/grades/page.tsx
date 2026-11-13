import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { GradeCoursePicker } from "@/components/ui/grade-course-picker";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { tenantRepository } from "@/lib/db/repository";
import { loadGradesOverview } from "@/lib/views/loaders";
import { PageTransition } from "@/components/ui/page-transition";

export default function GradesPage({ searchParams }: { searchParams: Promise<{ course?: string }> }) {
  return <Suspense fallback={<PageSkeleton label="Loading course grades" rows={5} />}><PageTransition><Page searchParams={searchParams} /></PageTransition></Suspense>;
}

async function Page({ searchParams }: { searchParams: Promise<{ course?: string }> }) {
  const session = await auth();
  if (!session.userId) redirect("/sign-in");
  const ctx = await ensureUserForClerk(session.userId);
  const courses = await tenantRepository(ctx).listCourses();
  const requested = (await searchParams).course;
  if (requested && courses.some(course => course.id === requested)) redirect(`/courses/${requested}/grades`);
  const overview = await loadGradesOverview(ctx).catch(() => null);
  const stats = new Map(overview?.courses.map(course => [course.id, course]) ?? []);
  return <OnboardingGate><GradeCoursePicker courses={courses.map(course => ({ ...course, graded: stats.get(course.id)?.graded, missing: stats.get(course.id)?.missing }))} recent={overview?.recent ?? []} now={new Date().toISOString()} /></OnboardingGate>;
}
