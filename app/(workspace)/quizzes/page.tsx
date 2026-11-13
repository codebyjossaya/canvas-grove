import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/app-shell";
import { QuizzesScreen } from "@/components/workspace/quizzes-screen";
import { PageTransition } from "@/components/ui/page-transition";

export default function QuizzesPage() { return <Suspense fallback={<PageSkeleton label="Loading quizzes" />}><PageTransition><Protected /></PageTransition></Suspense>; }
async function Protected() { const session = await auth(); if (!session.userId) redirect("/sign-in"); return <QuizzesScreen />; }
