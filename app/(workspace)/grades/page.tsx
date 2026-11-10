import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { GradeCoursePicker } from "@/components/ui/grade-course-picker";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { tenantRepository } from "@/lib/db/repository";

export default function GradesPage({ searchParams }: { searchParams: Promise<{ course?: string }> }) {
  return <Suspense fallback={<PageSkeleton label="Loading course grades"/>}><Page searchParams={searchParams} /></Suspense>;
}

async function Page({ searchParams }: { searchParams: Promise<{ course?: string }> }) {
  const session = await auth();
  if (!session.userId) redirect("/sign-in");
  const courses = await tenantRepository(await ensureUserForClerk(session.userId)).listCourses();
  const requested = (await searchParams).course;
  if (requested && courses.some(course => course.id === requested)) redirect(`/courses/${requested}/grades`);
  return <OnboardingGate><GradeCoursePicker courses={courses} /></OnboardingGate>;
}
