import type { Viewport } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SecureBrowserPopup } from "@/components/ui/secure-browser-popup";

// The remote browser owns layout and zoom on phones; keep this frame fixed and edge-to-edge.
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: "cover", interactiveWidget: "resizes-visual" };

export default function SecureBrowserPendingPage() { return <Suspense fallback={<div className="boot"/>}><Pending/></Suspense>; }
async function Pending() { const session = await auth(); if (!session.userId) redirect("/sign-in"); return <SecureBrowserPopup/>; }
