import type { Viewport } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SecureBrowserPopup } from "@/components/ui/secure-browser-popup";

// The remote browser owns layout and zoom on phones; keep this frame fixed and edge-to-edge.
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: "cover", interactiveWidget: "resizes-visual" };

export default function SecureBrowserPage({ params }: { params: Promise<{ sessionId: string }> }) { return <Suspense fallback={<div className="boot"/>}><Viewer params={params}/></Suspense>; }
async function Viewer({ params }: { params: Promise<{ sessionId: string }> }) { const session = await auth(); if (!session.userId) redirect("/sign-in"); const { sessionId } = await params; return <SecureBrowserPopup sessionId={sessionId}/>; }
