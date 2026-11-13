import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { requireCompletedOnboarding } from "@/lib/onboarding";
import { InboxScreen } from "@/components/workspace/inbox-screen";
import { InboxSkeleton } from "@/components/workspace/skeletons";
import { LoadError } from "@/components/workspace/load-error";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { loadInboxView } from "@/lib/views/loaders";
import { PageTransition } from "@/components/ui/page-transition";

type Params = { tab?: string; c?: string; a?: string };

export default function InboxPage({ searchParams }: { searchParams: Promise<Params> }) {
  return <Suspense fallback={<InboxSkeleton />}><PageTransition><ProtectedInbox searchParams={searchParams} /></PageTransition></Suspense>;
}

async function ProtectedInbox({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await auth(); if (!session.userId) redirect("/sign-in");
  const ctx = await ensureUserForClerk(session.userId);
  const [, view] = await Promise.all([requireCompletedOnboarding(), searchParams.then(params => loadInboxView(ctx, params)).catch(() => null)]);
  return view ? <InboxScreen view={view} now={new Date().toISOString()} /> : <LoadError what="your inbox" />;
}
