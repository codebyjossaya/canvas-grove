import { Suspense, type ReactNode } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { CourseWorkspaceRoute } from "@/components/ui/course-workspace";

// Persists across /courses/[courseId] and its sections so switching tabs keeps the course
// header and navigation mounted. The pages below only gate auth and onboarding.
export default function CourseLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageSkeleton label="Loading course"/>}><CourseWorkspaceRoute>{children}</CourseWorkspaceRoute></Suspense>;
}
