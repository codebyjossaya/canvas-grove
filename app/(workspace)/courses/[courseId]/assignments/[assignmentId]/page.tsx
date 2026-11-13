import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { requireCompletedOnboarding } from "@/lib/onboarding";
import { AssignmentDetailView } from "@/components/workspace/assignment-detail-view";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { loadAssignmentDetail } from "@/lib/views/assignment-detail";
import { PageTransition } from "@/components/ui/page-transition";

type Params = Promise<{ courseId: string; assignmentId: string }>;

export default function AssignmentDetailPage({ params }: { params: Params }) {
  return <Suspense fallback={<PageSkeleton label="Loading assignment" rows={5} />}><PageTransition><Page params={params} /></PageTransition></Suspense>;
}

async function Page({ params }: { params: Params }) {
  const { courseId, assignmentId } = await params;
  const session = await auth();
  if (!session.userId) redirect("/sign-in");
  const ctx = await ensureUserForClerk(session.userId);
  const [, detail] = await Promise.all([requireCompletedOnboarding(), loadAssignmentDetail(ctx, courseId, assignmentId)]);
  if (!detail) notFound();
  return <AssignmentDetailView detail={detail} />;
}
