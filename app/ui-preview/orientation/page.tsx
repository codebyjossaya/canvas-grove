import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { OrientationPreview } from "@/components/orientation/preview";

// Public fixture preview of every orientation step and state. No auth, no network, no extension.
//   /ui-preview/orientation               index of states
//   /ui-preview/orientation?s=ext-missing one state, full page
// Theme follows the system setting (or the stored preference).
type Search = Record<string, string | string[] | undefined>;

export default function OrientationPreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  return <Suspense fallback={<div className="boot" />}><Gate searchParams={searchParams} /></Suspense>;
}

async function Gate({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  if (process.env.NODE_ENV === "production" && process.env.UI_FORWARD_PREVIEW !== "1") notFound();
  const query = await searchParams;
  const key = Array.isArray(query.s) ? query.s[0] : query.s;
  return <OrientationPreview stateKey={key} />;
}
