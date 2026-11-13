import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { InboxScreen } from "@/components/workspace/inbox-screen";
import { InboxSkeleton } from "@/components/workspace/skeletons";
import { LoadError } from "@/components/workspace/load-error";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { loadInboxView } from "@/lib/views/loaders";
import { PageTransition } from "@/components/ui/page-transition";

type Params = { tab?: string; c?: string; a?: string };

export default function InboxPage({ searchParams }: { searchParams: Promise<Params> }) {
  return <Suspense fallback={<InboxSkeleton />}><PageTransition><OnboardingGate><ProtectedInbox searchParams={searchParams} /></OnboardingGate></PageTransition></Suspense>;
}

async function ProtectedInbox({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await auth(); if (!session.userId) redirect("/sign-in");
  const ctx = await ensureUserForClerk(session.userId);
  const view = await loadInboxView(ctx, await searchParams).catch(() => null);
  return view ? <InboxScreen view={view} now={new Date().toISOString()} /> : <LoadError what="your inbox" />;
}
