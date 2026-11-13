import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { PageTransition } from "@/components/ui/page-transition";
import { ExtensionConnect } from "@/components/workspace/extension-connect";

export const metadata = { title: "Connect browser · Canvas Grove" };

export default function ExtensionConnectPage() {
  return <Suspense fallback={<PageSkeleton label="Loading" rows={3} />}><PageTransition><ProtectedConnect /></PageTransition></Suspense>;
}
async function ProtectedConnect() {
  const session = await auth();
  if (!session.userId) redirect("/sign-in?redirect_url=%2Fextension%2Fconnect");
  return <ExtensionConnect />;
}
