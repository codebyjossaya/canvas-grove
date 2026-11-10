import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { UiForwardPreview } from "@/components/ui/ui-forward-preview";

export default function UiPreviewPage() {
  return <Suspense fallback={<div className="boot" />}><PreviewGate /></Suspense>;
}

async function PreviewGate() {
  await connection();
  if (process.env.NODE_ENV === "production" && process.env.UI_FORWARD_PREVIEW !== "1") notFound();
  return <UiForwardPreview />;
}
