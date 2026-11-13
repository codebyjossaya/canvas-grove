import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { DevPreview } from "@/components/preview/dev-preview";

// DEV-ONLY fixture mode: renders every redesigned workspace page with realistic fixtures that
// match the real schema shapes. It returns 404 unless NODE_ENV is "development", which is never
// the case for `next build`/`next start`, so production builds cannot reach it.
export default function DevPreviewPage({ params, searchParams }: { params: Promise<{ slug?: string[] }>; searchParams: Promise<Record<string, string | undefined>> }) {
  return <Suspense fallback={<div className="boot" />}><Gate params={params} searchParams={searchParams} /></Suspense>;
}

async function Gate({ params, searchParams }: { params: Promise<{ slug?: string[] }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await connection();
  if (process.env.NODE_ENV !== "development") notFound();
  const [{ slug = [] }, query] = await Promise.all([params, searchParams]);
  return <DevPreview slug={slug} query={query} />;
}
