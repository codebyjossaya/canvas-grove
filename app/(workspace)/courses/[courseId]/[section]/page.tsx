import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { OnboardingGate } from "@/components/ui/onboarding-gate";

const sections = new Set(["assignments", "announcements", "files", "syllabus", "modules", "pages", "grades"]);

// The section UI is rendered by the persistent course layout; this page validates the
// section and enforces access.
export default function CourseSectionPage({ params }: { params: Promise<{ courseId: string; section: string }> }) {
  return <Suspense fallback={null}><Gate params={params}/></Suspense>;
}

async function Gate({ params }: { params: Promise<{ courseId: string; section: string }> }) {
  const { section } = await params;
  if (!sections.has(section)) notFound();
  const session = await auth();
  if (!session.userId) redirect("/sign-in");
  return <OnboardingGate>{null}</OnboardingGate>;
}
